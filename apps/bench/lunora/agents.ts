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

import { internal } from "./_generated/internal";

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
const runOrganization = ({ owner, threadKey }: Pick<AgentToolContext, "owner" | "threadKey">): { organizationId: string; userId: string } => {
    const separator = threadKey.lastIndexOf(":");
    const organizationId = threadKey.slice(0, separator);

    if (separator <= 0 || owner === undefined || threadKey.slice(separator + 1) !== owner) {
        throw new LunoraError("FORBIDDEN", "the assistant's tools run only on threads started by assistant:ask");
    }

    return { organizationId, userId: owner };
};

/**
 * The organisation a tool may read, once the thread's user is confirmed a member
 * of it. The run may have started before a removal, so the check runs on every
 * tool call rather than once per run.
 */
const tenantForRun = async (context: AgentToolContext): Promise<string> => {
    const { organizationId, userId } = runOrganization(context);
    const { member } = (await context.run(internal.membership.isMember, { organizationId, userId }, { shardKey: "__root__" })) as { member: boolean };

    if (!member) {
        throw new LunoraError("FORBIDDEN", "this thread's user is no longer a member of the organisation");
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
            execute: async ({ term }, context) => {
                const organizationId = await tenantForRun(context);

                return context.run(internal.assistant.searchTasks, { organizationId, term }, { shardKey: organizationId });
            },
            inputSchema: jsonSchema<{ term: string }>({ properties: { term: { type: "string" } }, required: ["term"], type: "object" }),
        }),
        openTasks: defineAgentTool({
            description: "List the organisation's open tasks, newest first.",
            execute: async (_input, context) => {
                const organizationId = await tenantForRun(context);

                // `tasks` is `.shardBy("organizationId")`; the default shard holds none of the tenant's rows.
                return context.run(internal.assistant.openTasks, { organizationId }, { shardKey: organizationId });
            },
            inputSchema: jsonSchema<Record<string, never>>({ properties: {}, type: "object" }),
        }),
    },
});
