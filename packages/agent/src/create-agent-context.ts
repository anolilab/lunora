// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/dispatch is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { createDispatchRunner } from "@lunora/dispatch";
import { LunoraError } from "@lunora/errors";

import { hasBranchMarker } from "../../../shared/branch-marker";
import { DEFAULT_AGENT_FUNCTION_PATHS, toFunctionReference } from "./paths";
import type { AgentBindingSpec, AgentHandle, AgentRunFunction, AgentRunInput, AgentWorkflowBindingLike } from "./types";

/**
 * Build the `ctx.agents` producer surface from the codegen-emitted spec list
 * (`LUNORA_AGENTS`), mirroring the `ctx.queues` property-access pattern: each
 * declared agent resolves its `AGENT_*` Workflow binding off `env` lazily, so
 * a missing binding only errors when that agent is actually started.
 *
 * `cancel` also needs to write the thread's status, so it dispatches the agent
 * runtime's `agentPatchThread` mutation. Production leaves `dispatch` undefined
 * and the env-backed `createDispatchRunner` (the same runner the workflow body
 * uses — it POSTs to `/_lunora/scheduler/dispatch`) is built on demand; tests
 * inject a `dispatch` double.
 * @experimental
 */
const createAgentContext = (env: Record<string, unknown>, specs: ReadonlyArray<AgentBindingSpec>, dispatch?: AgentRunFunction): Record<string, AgentHandle> => {
    const agents: Record<string, AgentHandle> = {};
    const patchThread = toFunctionReference(DEFAULT_AGENT_FUNCTION_PATHS.patchThread);
    const resolveDispatch = (): AgentRunFunction => dispatch ?? createDispatchRunner({ env, label: "@lunora/agent" });

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
            cancel: async (id: string) => {
                // Terminate the run, then mark its thread cancelled. `terminate`
                // kills the workflow abruptly (the loop's error handler never
                // runs), so the status has to be patched from here — targeted by
                // the instance id the thread stored at bootstrap.
                const instance = await resolve().get(id);

                await instance.terminate();

                // `terminate` is the irreversible act — the run is already gone.
                // The status patch is best-effort bookkeeping: if it fails, cancel()
                // must NOT throw (a retry would re-terminate an already-dead
                // instance), so swallow it. The stale "running" status is reconciled
                // out-of-band rather than leaving the thread wedged.
                try {
                    await resolveDispatch()(patchThread, { instanceId: id, status: "cancelled" });
                } catch {
                    // Non-fatal — the run is terminated; thread status is reconciled separately.
                }
            },
            // Carried from the codegen spec (`defineAgent({ publicRun: true })`).
            // Gates the public `agents:agentRun` mutation fail-closed; the
            // server-side `run(...)` below is unaffected.
            publicRun: spec.publicRun === true,
            run: async (input: AgentRunInput, options?: { id?: string }) => {
                // `input` is reachable from the public `agents:agentRun` mutation
                // when `publicRun: true` — reject the reserved workflow
                // branch-marker key at this trust boundary before it ever reaches
                // `create()`.
                if (hasBranchMarker(input)) {
                    throw new LunoraError("BAD_REQUEST", "@lunora/agent: run input may not contain the reserved workflow branch-marker key");
                }

                const instance = await resolve().create({ ...(options?.id === undefined ? {} : { id: options.id }), params: input });

                return { id: instance.id };
            },
            sendEvent: async (id: string, event: { payload: unknown; type: string }) => {
                // Resume a run paused on a human-in-the-loop approval:
                // `agents:agentResolveApproval` reaches this handle off the
                // function-run ctx and delivers the `agent-approval` event to the
                // hibernated `waitForEvent`.
                const instance = await resolve().get(id);

                await instance.sendEvent(event);
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
