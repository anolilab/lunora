/* eslint-disable no-secrets/no-secrets -- JSDoc names the generated `<Name>AgentWorkflow` class, not a credential. */

import type { WorkflowDefinition } from "@lunora/workflow";
import { defineWorkflow } from "@lunora/workflow";

import { runAgentLoop } from "./agent-loop";
import { createAgentGenerate, createCompact, createEpisodeExtract, createGraphExtract, createStreamGenerate } from "./generate";
import { agentDefaultName } from "./naming";
import { DEFAULT_AGENT_FUNCTION_PATHS } from "./paths";
import resolveAgentRun from "./resolve-run";
import { otlpTelemetry } from "./telemetry/otlp";
import type { AgentDefinition, AgentFunctionPaths, AgentRunInput, AgentRunResult } from "./types";

/**
 * On the Lunora platform the deploy path injects `LUNORA_OTLP_ENDPOINT` /
 * `LUNORA_OTLP_TOKEN` into every tenant. When they're present, auto-append an
 * `otlpTelemetry` integration so a deployed agent's model turns and tool calls
 * emit `gen_ai.*` generation spans to the cloud with **no app wiring** — the same
 * way `otlpSink` auto-ships RPC telemetry.
 *
 * Privacy-safe: `otlpTelemetry` records only structural metadata (model, token
 * counts) unless the app opts into `recordInputs`/`recordOutputs`. Byte-identical
 * no-op when no endpoint is set (local / self-hosted) or when the app explicitly
 * set `telemetry.isEnabled: false`.
 */
const withAutoOtlpTelemetry = (agent: AgentDefinition, env: Record<string, unknown>, conversationId?: string): AgentDefinition => {
    const endpoint = env.LUNORA_OTLP_ENDPOINT;

    if (typeof endpoint !== "string" || endpoint === "" || agent.telemetry?.isEnabled === false) {
        return agent;
    }

    const token = typeof env.LUNORA_OTLP_TOKEN === "string" ? env.LUNORA_OTLP_TOKEN : undefined;

    // `integrations` may be a single `Telemetry`, an array, or absent — normalize
    // to an array (`[x].flat()` keeps a single value and unwraps an array).
    const existingList = [agent.telemetry?.integrations].flat().filter((integration) => integration !== undefined);

    return {
        ...agent,
        telemetry: {
            ...agent.telemetry,
            // Tag every generation span with the run's thread as its conversation
            // id (one thread = one multi-turn conversation), so the cloud groups a
            // deployed agent's turns with no app wiring. Absent → ungrouped, as before.
            integrations: [...existingList, otlpTelemetry({ conversationId, endpoint, token })],
            isEnabled: true,
        },
    };
};

/**
 * Compile a `defineAgent` definition into the workflow the generated
 * `<Name>AgentWorkflow` entrypoint class runs. Codegen emits, per agent:
 *
 * ```ts
 * import LunoraWorkflow from "@lunora/workflow/do";
 * import { compileAgentWorkflow } from "@lunora/agent";
 * import { support } from "../agents.js";
 *
 * export class SupportAgentWorkflow extends LunoraWorkflow<AgentRunInput, AgentRunResult> {
 *     public constructor(ctx: ConstructorParameters<typeof LunoraWorkflow>[0], env: Record<string, unknown>) {
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
        handler: async (context) => {
            // On the platform, auto-append OTLP generation telemetry from the
            // injected endpoint; local/self-hosted agents are unaffected. The run's
            // `threadKey` rides along as the conversation/session id so multi-turn
            // spans group in the cloud.
            const runtimeAgent = withAutoOtlpTelemetry(agent, context.env, context.params.threadKey);

            return runAgentLoop({
                agent: runtimeAgent,
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
                generate: createAgentGenerate(runtimeAgent, context.env),
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
                streamGenerate: createStreamGenerate(runtimeAgent, context.env),
            });
        },
        name: agent.name ?? agentDefaultName(exportName),
    });

export default compileAgentWorkflow;
