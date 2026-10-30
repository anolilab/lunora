/**
 * Durable agents — each `defineAgent` compiles onto a Cloudflare Workflow
 * (re-exported from `lunora/server.ts`); codegen wires `ctx.agents.<name>`.
 *
 * The model is a Workers AI id, so a run needs a Cloudflare login (or
 * `LUNORA_AI_PROXY_URL`) in local dev; declaring the agent needs neither.
 */
import type { AgentToolContext } from "@lunora/agent";
import { defineAgent, defineAgentTool } from "@lunora/agent";
import { jsonSchema } from "@lunora/ai";
import { LunoraError } from "@lunora/errors";

import { internal } from "./_generated/internal.js";

/**
 * The organisation a tool may read. `assistant:ask` keys every thread
 * `<organizationId>:<userId>` from the caller's verified identity, and the loop
 * passes the verified owner alongside; a key whose user is not the owner did not
 * come from `ask`, so it is refused rather than trusted.
 *
 * This holds only while `support` is not `publicRun`: the public `agentRun`
 * takes the thread key from the caller, who could then name another tenant's
 * organisation, and the tools would need a membership check instead.
 */
const runOrganization = ({ owner, threadKey }: Pick<AgentToolContext, "owner" | "threadKey">): string => {
    const separator = threadKey.lastIndexOf(":");
    const organizationId = threadKey.slice(0, separator);

    if (separator <= 0 || owner === undefined || threadKey.slice(separator + 1) !== owner) {
        throw new LunoraError("FORBIDDEN", "the assistant's tools run only on threads started by assistant:ask");
    }

    return organizationId;
};

export const support = defineAgent({
    instructions: "You help a team triage its tasks. Answer from the tools; never invent a task.",
    maxTurns: 6,
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    tools: {
        findTasks: defineAgentTool({
            description: "Search the organisation's tasks by title.",
            execute: async ({ term }, context) => context.run(internal.assistant.searchTasks, { organizationId: runOrganization(context), term }),
            inputSchema: jsonSchema<{ term: string }>({ properties: { term: { type: "string" } }, required: ["term"], type: "object" }),
        }),
        openTasks: defineAgentTool({
            description: "List the organisation's open tasks, newest first.",
            execute: async (_input, context) => context.run(internal.assistant.openTasks, { organizationId: runOrganization(context) }),
            inputSchema: jsonSchema<Record<string, never>>({ properties: {}, type: "object" }),
        }),
    },
});
