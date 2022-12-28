import inquirer, { Answers, QuestionCollection } from "inquirer";
import { Browser, BrowserContext, chromium, Page } from "playwright";
import { Subject } from "rxjs";
import invariant from "tiny-invariant";
import z from "zod";
import { openai } from "./lib/openai";
import {
	BROWSER_CONTEXT_EXAMPLE_1,
	BROWSER_CONTEXT_EXAMPLE_2,
	BROWSER_CONTEXT_EXAMPLE_3,
	BROWSER_CONTEXT_TEMPLATE,
	createPromptTemplate,
} from "./lib/prompt";
import sleep from "./lib/sleep";

const urlSchema = z.string().url({ message: "Invalid URL" });
type IdToDomPath = Map<number, string>;
class Ondai {
	#browser: Browser;
	#context: BrowserContext | null = null;
	#page: Page | null = null;
	#previous_command: string = "";
	#browserContexts = [
		BROWSER_CONTEXT_EXAMPLE_1,
		BROWSER_CONTEXT_EXAMPLE_2,
		BROWSER_CONTEXT_EXAMPLE_3,
	];

	constructor(browser: Browser) {
		this.#browser = browser;
		// browser.on('page', () => {

		// })
	}

	async setPage(url: string) {
		if (!this.#context) {
			this.#context = await this.#browser.newContext({
				userAgent:
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36",
			});
			this.#context.on("page", async (newPage) => {
				console.log("new page");
				this.#page = newPage;
			});
		}
		const page = await this.#context.newPage();
		await page.goto(url);
		this.#page = page;
	}

	getUrl() {
		invariant(this.#page, "Page not initialized");
		return this.#page.url();
	}

	async getInteractiveElements() {
		invariant(this.#page, "Page not initialized");
		return await this.#page.evaluateHandle(async () => {
			// https://stackoverflow.com/a/66143123/13766751
			(window as any).__getDomPath = (el: Element) => {
				const stack = [];

				while (el.parentNode !== null) {
					let sibCount = 0;
					let sibIndex = 0;
					for (let i = 0; i < el.parentNode.childNodes.length; i += 1) {
						const sib = el.parentNode.childNodes[i];
						if (sib?.nodeName === el.nodeName) {
							if (sib === el) {
								sibIndex = sibCount;
								break;
							}
							sibCount += 1;
						}
					}

					const nodeName = CSS.escape(el.nodeName.toLowerCase());

					// Ignore `html` as a parent node
					if (nodeName === "html") break;

					stack.unshift(`${nodeName}:nth-of-type(${sibIndex + 1})`);

					// if (el.hasAttribute("id") && el.id !== "") {
					// 	stack.unshift(`#${CSS.escape(el.id)}`);
					// 	// Remove this `break` if you want the entire path
					// 	break;
					// } else if (sibIndex > 0) {
					// 	// :nth-of-type is 1-indexed
					// 	stack.unshift(`${nodeName}:nth-of-type(${sibIndex + 1})`);
					// } else {
					// 	stack.unshift(nodeName);
					// }

					el = el.parentNode as any;
				}

				return stack.join(" > ");
			};
			const getDomPath = (window as any).__getDomPath as (
				el: Element
			) => string;
			const allElements = document.getElementsByTagName("*");
			type FakeElementTypes = "link" | "input" | "button";
			const interactiveElements: Array<{
				type: FakeElementTypes;
				text: string;
				domPath: string;
			}> = [];
			// TODO: include shadow dom
			for (const element of allElements) {
				// TODO: decide if ariaLabel is more important (most likely, since devs explicitly set it)
				const text = (element.ariaLabel || (element as any)?.innerText)?.trim();
				if (!text) {
					continue;
				}
				const elementName = element.nodeName.toLowerCase();
				if (
					(elementName === "input" &&
						element.getAttribute("type") === "text") ||
					elementName === "textarea"
				) {
					interactiveElements.push({
						type: "input",
						text: text,
						domPath: getDomPath(element),
					});
				} else if (elementName === "a") {
					interactiveElements.push({
						type: "link",
						text: text,
						domPath: getDomPath(element),
					});
				} else if (
					elementName === "button" ||
					elementName === "button" ||
					// element.hasAttribute("tabindex")
					(element as any).onclick !== null
				) {
					interactiveElements.push({
						type: "button",
						text: text,
						domPath: getDomPath(element),
					});
				}
			}
			console.log(interactiveElements);
			return interactiveElements;
		});

		// return await this.#page.$$(
		// 	"input, textarea, select, button, a, [tabindex]"
		// );
	}

	async generatePrompt(action: string) {
		const ondai = this;
		const interactiveElements = await ondai
			.getInteractiveElements()
			.then((h) => h.jsonValue());

		const idToDomPath: IdToDomPath = new Map<number, string>();
		const browserContent = interactiveElements
			.map((element, index) => {
				const { type, text, domPath } = element;
				const id = index;
				idToDomPath.set(id, domPath);
				return `<${type} id=${id}>${text}</${type}>`;
			})
			.join("\n");

		let browserContext = BROWSER_CONTEXT_TEMPLATE;
		browserContext = browserContext.replace("$objective", action);
		browserContext = browserContext.replace(
			"$url",
			ondai.getUrl().substring(0, 100)
		);
		browserContext = browserContext.replace(
			"$previous_command",
			this.#previous_command
		);
		browserContext = browserContext.replace(
			"$browser_content",
			browserContent.substring(0, 4500)
		);

		this.#browserContexts.push(browserContext);

		const lastThreeBrowserContexts = this.#browserContexts.slice(-3);
		console.log(lastThreeBrowserContexts.length);

		const prompt = createPromptTemplate({
			browserContexts: lastThreeBrowserContexts,
		});
		// let prompt = promptTemplate;
		// prompt = prompt.replace("$objective", action);
		// prompt = prompt.replace("$url", ondai.getUrl().substring(0, 100));
		// prompt = prompt.replace("$previous_command", this.#previous_command);
		// prompt = prompt.replace(
		// 	"$browser_content",
		// 	browserContent.substring(0, 4500)
		// );

		return { prompt: prompt.trim(), idToDomPath };
	}

	async runCommand(opts: { command: string; selector: string }) {
		invariant(this.#browser, "Browser not initialized");
		invariant(this.#page, "Page not initialized");
		const locator = this.#page?.locator(opts.selector);
		if (!locator) {
			throw new Error(`Locator not found for selector: ${opts.selector}`);
		}
		const command = opts.command.split("\n")[0];
		if (!command) {
			throw new Error(`Invalid command: ${opts.command}`);
		}
		if (command.startsWith("SCROLL-UP")) {
			await locator.scrollIntoViewIfNeeded();
			// await this.#page?.keyboard.press("ArrowUp")
		} else if (command.startsWith("SCROLL-DOWN")) {
			await locator.scrollIntoViewIfNeeded();
			// await this.#page?.keyboard.press("ArrowDown")
		} else if (command.startsWith("CLICK")) {
			await locator.click({
				timeout: 5000,
			});
		} else if (command.startsWith("TYPE")) {
			const [_TYPE, _id, ...rest] = command.split(" ");
			const text = rest.join(" ").slice(1, -1);
			await locator.type(text, { delay: 100 });
			if (command.startsWith("TYPESUBMIT")) {
				await locator.press("Enter");
			}
		} else if (command.startsWith("NAVIGATE")) {
			const [_NAVIGATE, url] = command.split(" ");
			if (!url) {
				throw new Error(`Invalid command: ${opts.command}`);
			}
			await this.#page?.goto(url);
		} else {
			throw new Error(`Invalid command: ${opts.command}`);
		}
		// this.#page = await this.#page.context.
		await this.#page.waitForLoadState("domcontentloaded");
	}
}

async function main() {
	// console.log("Launching browser...");
	const browser = await chromium.launch({ headless: false });
	const terminalPrompts = new Subject<QuestionCollection<Answers>>();
	const inquirerPrompts = inquirer.prompt(terminalPrompts as any);

	const urlPrompt: QuestionCollection<Answers> = {
		type: "input",
		name: "url",
		message: "Enter an URL to open:",
		filter(value) {
			if (!value.startsWith("http")) {
				return `https://${value}`;
			}
			return value;
		},
		validate(value) {
			const result = urlSchema.safeParse(value);
			if (result.success) {
				return true;
			}
			if (!value.startsWith("http")) {
				const newUrl = `https://${value}`;
				if (urlSchema.safeParse(newUrl).success) {
					return true;
				}
			}
			return String(result.error.message);
		},
	};
	const ondai = new Ondai(browser);

	terminalPrompts.next(urlPrompt);

	inquirerPrompts.ui.process.subscribe({
		next: async ({ answer, name }) => {
			if (name === "url") {
				const url = urlSchema.parse(answer);
				await ondai.setPage(url);

				terminalPrompts.next({
					type: "input",
					name: `action.1`,
					message: "What should I do?",
				});
			} else if (name.startsWith("action")) {
				const [_, _actionId] = name.split(".");
				const actionId = Number(_actionId);
				const action = z.string().parse(answer);
				console.log(`Action ${actionId}: ${action}`);

				while (true) {
					const { prompt, idToDomPath } = await ondai.generatePrompt(action);
					const gptResponse = await openai
						.createCompletion({
							model: "text-davinci-002",
							prompt: prompt,
							temperature: 0.5,
							best_of: 10,
							n: 10,
							max_tokens: 50,
						})
						.catch((err) => {
							console.error(err);
							throw new Error("OpenAI API error");
						});
					const command = gptResponse.data.choices[0]?.text?.trim();
					if (!command) {
						console.error("No command generated");
						break;
					}
					const [, elementId] = command.split(" ");
					if (!elementId) {
						throw new Error(`Invalid elementId: ${elementId}`);
					}
					const selector = idToDomPath.get(Number(elementId));
					if (!selector) {
						throw new Error(`Invalid selector: ${selector}`);
					}
					console.log("COMMAND:", command);
					console.log("SELECTOR:", selector);
					try {
						await ondai.runCommand({ command, selector });
					} catch (e) {
						console.log("Failed to run command.", e);
						break;
					}
					await sleep(1000);
				}

				// const gptResponse = await cohere.generate({
				// 	model: "large",
				// 	prompt: gptCommand,
				// 	max_tokens: 50,
				// 	temperature: 0.5,
				// 	k: 10,
				// });

				terminalPrompts.next({
					type: "input",
					name: `action.${actionId + 1}`,
					message: "What should I do?",
				});
			}
		},
		error: (error) => {
			console.error("error", error);
		},
		complete: () => {
			console.log("Done!");
		},
	});
	// console.log(`Opening ${url}`);
	// await browser.close();
}

try {
	main();
} catch (err) {
	console.error(err);
}
