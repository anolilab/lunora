import type { WorkflowDefinition } from "@lunora/workflow";
import { defineWorkflow } from "@lunora/workflow";

import { runAgentLoop } from "./agent-loop";
import { createAgentGenerate, createCompact, createEpisodeExtract, createGraphExtract, createStreamGenerate } from "./generate";
import { agentDefaultName } from "./naming";
import { DEFAULT_AGENT_FUNCTION_PATHS } from "./paths";
import resolveAgentRun from "./resolve-run";
import type { AgentDefinition, AgentFunctionPaths, AgentRunInput, AgentRunResult } from "./types";

/**
 * Compile a `defineAgent` definition into the workflow the generated
 * `&lt;Name>AgentWorkflow` entrypoint class runs. Codegen emits, per agent:
 *
 * ```ts
 * import LunoraWorkflow from "@lunora/workflow/do";
 * import { compileAgentWorkflow } from "@lunora/agent";
 * import { support } from "../agents.js";
 *
 * export class SupportAgentWorkflow extends LunoraWorkflow&lt;AgentRunInput, AgentRunResult> {
 *     public constructor(ctx: ConstructorParameters&lt;typeof LunoraWorkflow>[0], env: Record&lt;string, unknown>) {
 *         super(ctx, env, compileAgentWorkflow(support, "support"), "support");
 *     }
 * }
 * ```
 *
 * The workflow ctx supplies durability (`step.do`) and the Lunora dispatcher
 * (`run`); the loop supplies determinism (step naming + idempotent persists).
 * @experimental
 */
const compileAgentWorkflow = (
    agent: AgentDefinition,
    exportName: string,
    options?: { paths?: AgentFunctionPaths },
): WorkflowDefinition<AgentRunInput, AgentRunResult> =>
    defineWorkflow<AgentRunInput, AgentRunResult>({
        handler: async (context) =>
            runAgentLoop({
                agent,
                // Automatic history compaction. Dormant unless the agent declares
                // a `compaction` config; the loop gates on it, so any other agent
                // takes the byte-identical no-compaction path.
                compact: createCompact(),
                env: context.env,
                exportName,
                // Run-end graph extraction. Dormant unless the agent declares a
                // `kind: "graph"` memory source AND the run carries an owner — the
                // loop gates on both, so a semantic-only agent takes the
                // byte-identical no-extraction path.
                extractGraph: createGraphExtract(),
                // Run-end episode recording. Dormant unless the agent declares a
                // `kind: "episodic"` memory source AND the run carries an owner —
                // the loop gates on both, so any other agent is byte-identical.
                extractEpisode: createEpisodeExtract(),
                generate: createAgentGenerate(agent, context.env),
                instanceId: context.event.instanceId,
                params: context.params,
                paths: options?.paths ?? DEFAULT_AGENT_FUNCTION_PATHS,
                // The loop reads its own owner-gated thread back through
                // `agents:*` queries. The default `context.run` forwards no
                // identity, so on an OWNED thread those reads would come back
                // empty and the model would answer blind. `resolveAgentRun`
                // dispatches an owner-scoped run under that verified identity so
                // the owner gate admits the loop's reads (ownerless runs keep the
                // identity-free `context.run`). See `resolve-run.ts`.
                run: resolveAgentRun(context.run, context.params.owner, context.env),
                step: context.step,
                // The streaming seam is wired and ready, but stays dormant until a
                // live token sink is threaded onto the run (a follow-up wires
                // `onTokenDelta` to the stream transport). With no sink the loop
                // takes the byte-identical non-streaming `generate` path.
                streamGenerate: createStreamGenerate(agent, context.env),
            }),
        name: agent.name ?? agentDefaultName(exportName),
    });

export default compileAgentWorkflow;
