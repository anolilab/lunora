/**
 * Durable agents — each `defineAgent` compiles onto a Cloudflare Workflow
 * (re-exported from `lunora/server.ts`); codegen wires `ctx.agents.<name>`.
 *
 * The model is a Workers AI id, so a run needs a Cloudflare login (or
 * `LUNORA_AI_PROXY_URL`) in local dev; declaring the agent needs neither.
 */
import { defineAgent, defineAgentTool } from "@lunora/agent";
import { jsonSchema } from "@lunora/ai";

export const support = defineAgent({
    instructions: "You help a team triage its tasks. Answer from the tools; never invent a task.",
    maxTurns: 6,
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    tools: {
        findTasks: defineAgentTool({
            description: "Search the organisation's tasks by title.",
            execute: async ({ term }, { run }) => run({ __lunoraRef: "assistant/index:searchTasks" }, { term }),
            inputSchema: jsonSchema<{ term: string }>({ properties: { term: { type: "string" } }, required: ["term"], type: "object" }),
        }),
        openTasks: defineAgentTool({
            description: "List the organisation's open tasks, newest first.",
            execute: async (_input, { run }) => run({ __lunoraRef: "assistant/index:openTasks" }, {}),
            inputSchema: jsonSchema<Record<string, never>>({ properties: {}, type: "object" }),
        }),
    },
});
