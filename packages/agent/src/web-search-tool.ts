import type { AiBindingLike, AiWebSearchItem, AiWebSearchProvider } from "@lunora/ai";
import { createAi } from "@lunora/ai";
import { LunoraError } from "@lunora/errors";
import { jsonSchema } from "ai";

import type { AgentToolDefinition } from "./types";

/**
 * Config for {@link webSearchTool}.
 * @experimental
 */
interface WebSearchToolOptions {
    /** Overrides the description shown to the model. */
    description?: string;

    /**
     * The AI Gateway that brokers and bills the search. Defaults to
     * `LUNORA_AI_GATEWAY_ID`, else the account's `default` gateway.
     */
    gatewayId?: string;
    /** Maximum results per search, 1–10. Defaults to 5: every result is prompt the next turn pays for. */
    limit?: number;
    /** Defaults to the Web Search API's own default (`"ceramic"`). */
    provider?: AiWebSearchProvider;
}

/**
 * What the model passes.
 * @experimental
 */
interface WebSearchToolInput {
    query: string;
}

const DEFAULT_LIMIT = 5;

const DEFAULT_DESCRIPTION =
    "Search the web for current information. Returns up to a handful of results, each with a url, a title and (when the provider has one) a description. Use it for facts that may have changed after your training data, then cite the urls you relied on.";

const WEB_SEARCH_TOOL_SCHEMA = jsonSchema<WebSearchToolInput>({
    properties: { query: { description: "The search query, 1–1024 characters.", maxLength: 1024, minLength: 1, type: "string" } },
    required: ["query"],
    type: "object",
});

/**
 * Codes a retry cannot fix. Returned to the model as the tool's result rather
 * than thrown: a throw out of `execute` is retried by the durable step to
 * exhaustion and fails the run, where a string lets the next turn carry on.
 */
const DETERMINISTIC_CODES = new Set(["BAD_REQUEST", "NOT_IMPLEMENTED"]);

/**
 * A batteries-included agent tool over the Cloudflare Web Search API (beta,
 * `ctx.ai.websearch`), so an agent can ground an answer in live results.
 * Searches are billed to AI Gateway credits; every provider runs under Zero
 * Data Retention.
 *
 * It calls the `AI` binding straight from the tool's durable step: a search
 * is a read, so the at-least-once step retry repeats nothing but a query, and
 * there is no dispatcher action to register.
 *
 * ```ts
 * import { defineAgent, webSearchTool } from "@lunora/agent";
 *
 * export const researcher = defineAgent({
 *     model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
 *     tools: { search: webSearchTool({ provider: "exa" }) },
 * });
 * ```
 * @experimental
 */
const webSearchTool = (options: WebSearchToolOptions = {}): AgentToolDefinition<WebSearchToolInput, AiWebSearchItem[] | string> => {
    return {
        description: options.description ?? DEFAULT_DESCRIPTION,
        execute: async (input, context) => {
            const binding = context.env["AI"];

            if (!binding) {
                return "Web search is unavailable: this Worker has no `AI` binding. Answer from what you already know, and say that you could not search.";
            }

            try {
                const result = await createAi({ binding: binding as AiBindingLike, env: context.env }).websearch(input.query, {
                    ...(options.gatewayId === undefined ? {} : { gatewayId: options.gatewayId }),
                    limit: options.limit ?? DEFAULT_LIMIT,
                    ...(options.provider === undefined ? {} : { provider: options.provider }),
                });

                return result.items;
            } catch (error) {
                if (error instanceof LunoraError && DETERMINISTIC_CODES.has(error.code)) {
                    return `Web search failed: ${error.message}`;
                }

                throw error;
            }
        },
        inputSchema: WEB_SEARCH_TOOL_SCHEMA,
        isLunoraAgentTool: true,
    };
};

export type { WebSearchToolInput, WebSearchToolOptions };
export { webSearchTool };
