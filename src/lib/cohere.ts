import cohere from "cohere-ai";
import { env } from "./env";

cohere.init(env.COHERE_API_KEY, "2021-11-08");

export default cohere;
