import { LunoraError } from "@lunora/errors";

import type { AgentBindingSpec, AgentHandle, AgentRunInput, AgentWorkflowBindingLike } from "./types";

/**
 * Build the `ctx.agents` producer surface from the codegen-emitted spec list
 * (`LUNORA_AGENTS`), mirroring the `ctx.queues` property-access pattern: each
 * declared agent resolves its `AGENT_*` Workflow binding off `env` lazily, so
 * a missing binding only errors when that agent is actually started.
 */
const createAgentContext = (env: Record<string, unknown>, specs: ReadonlyArray<AgentBindingSpec>): Record<string, AgentHandle> => {
    const agents: Record<string, AgentHandle> = {};

    for (const spec of specs) {
        const resolve = (): AgentWorkflowBindingLike => {
            const binding = env[spec.binding] as AgentWorkflowBindingLike | undefined;

            if (!binding || typeof binding.create !== "function" || typeof binding.get !== "function") {
                throw new LunoraError(
                    "INTERNAL",
                    `@lunora/agent: no Workflow binding "${spec.binding}" on env for agent "${spec.exportName}" — run codegen/dev so wrangler.jsonc declares it`,
                );
            }

            return binding;
        };

        agents[spec.exportName] = {
            run: async (input: AgentRunInput, options?: { id?: string }) => {
                const instance = await resolve().create({ ...(options?.id === undefined ? {} : { id: options.id }), params: input });

                return { id: instance.id };
            },
            status: async (id: string) => {
                const instance = await resolve().get(id);

                return instance.status();
            },
        };
    }

    return agents;
};

export default createAgentContext;
