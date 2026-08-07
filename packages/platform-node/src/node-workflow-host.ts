/**
 * `createNodeWorkflowHost` — the Node implementation of the `@lunora/workflow`
 * binding surface (`WorkflowBindingLike` + the derived `WORKFLOW_*` env), backed
 * by the `@visulima/workflow` engine (`createRuntime`).
 *
 * # How the seam maps
 *
 * A Lunora `defineWorkflow` result (branded `isLunoraWorkflow`) is compiled into
 * a visulima `WorkflowConfig`: the handler runs through the exact same
 * `createWorkflowRunContext` assembly the Cloudflare host uses, but with the
 * native `cloudflare:workers` `WorkflowStep` replaced by an adapter over the
 * visulima `RunContext`:
 *
 * - `step.do(name, cb)` / `step.do(name, config, cb)` → `ctx.step(name, cb)` —
 * memoized + replay-safe in the visulima engine. The `config` (retries) and
 * `rollback` arguments are accepted but NOT emulated — visulima steps have no
 * per-step retry config or compensation.
 * - `step.sleep(name, duration)` / `step.sleepUntil(name, ts)` → `ctx.sleep(...)`
 * with a millisecond `Duration`. Cloudflare-style duration strings
 * ("1 minute", "2 hours", …) are parsed; `sleepUntil` in the past resolves
 * immediately.
 * - `step.waitForEvent(name, { type, timeout })` → `ctx.waitForEvent(name, type,
 * { timeout })`, resolving `{ payload, type }`.
 *
 * The runtime executes a `trigger` synchronously to completion or suspension, so
 * `create` resolves with the run already advanced as far as it can go (any
 * `sleep`/`waitForEvent` leaves it `suspended`/`waiting`). Instance status maps
 * visulima `RunStatus` → `WorkflowInstanceStatus` (`completed` → `complete`,
 * `failed` → `errored`, `suspended`/`waiting` → `waiting`); `sendEvent` maps to
 * `signal` and rejects unless the run is waiting for exactly that event name.
 *
 * # Known gaps (documented in `plans/234-node-host-findings.md`)
 *
 * - `pause`, `restart` throw `NOT_IMPLEMENTED` — the visulima engine has no
 * equivalent. `terminate` drops the run and writes a tombstone in its place, so
 * a later `status()` reports `terminated` instead of collapsing into the
 * `unknown` an invalid instance id also returns.
 * - `create({ id })` throws `NOT_IMPLEMENTED` — `runtime.trigger` assigns run
 * ids and takes no caller-supplied one, so honouring the option is impossible
 * and silently ignoring it would hand back a different instance than the caller
 * named (and break `get(id)` after a retried create).
 * - `ctx.run` still dispatches to `/_lunora/scheduler/dispatch`, which has no
 * Node HTTP server — a workflow body that calls `ctx.run` fails at runtime.
 * - `ctx.parallel`'s join cannot interleave inside one synchronous `trigger`
 * activation (the child's signal arrives before the parent's `waitForEvent` is
 * persisted); `spawn` + direct create/get/signal flows are sound.
 *
 * `store` is required rather than defaulted, because the only default available
 * is the engine's in-process `MemoryStore` and a host that silently loses every
 * run on restart should not be the thing a caller gets for saying nothing.
 * `createNodeWorkflowStore` (`./node-workflow-store`) is the durable choice;
 * `new MemoryStore()` stays available for tests, as an explicit one.
 */

import { LunoraError } from "@lunora/errors";
import type {
    WorkflowBindingLike,
    WorkflowInstanceLike,
    WorkflowInstanceStatus,
    WorkflowStatusResult,
    WorkflowStepConfigLike,
    WorkflowStepContextLike,
    WorkflowStepLike,
} from "@lunora/workflow";
import { createWorkflowRunContext, isWorkflowDefinition, workflowBindingName, workflowDefaultName } from "@lunora/workflow";
import type { RunContext, RunStatus, WorkflowRuntime, WorkflowStore } from "@visulima/workflow";
import { createRuntime, defineWorkflow as defineVisulimaWorkflow } from "@visulima/workflow";

/**
 * `definitionId` of the row `terminate` leaves behind. No workflow can carry it
 * (`defineWorkflow` ids come from export names), and it has no `wakeAt`, so
 * `store.due` never returns it and `sweep` never tries to resume it.
 */
const TERMINATED_DEFINITION_ID = "@lunora/platform-node:terminated";

/** Millisecond multipliers for every duration unit the parser recognises. */
const DURATION_MS: Record<string, number> = {
    d: 86_400_000,
    day: 86_400_000,
    days: 86_400_000,
    h: 3_600_000,
    hour: 3_600_000,
    hours: 3_600_000,
    m: 60_000,
    millisecond: 1,
    milliseconds: 1,
    minute: 60_000,
    minutes: 60_000,
    ms: 1,
    s: 1000,
    second: 1000,
    seconds: 1000,
    w: 604_800_000,
    week: 604_800_000,
    weeks: 604_800_000,
    month: 2_592_000_000,
    months: 2_592_000_000,
};

/** Matches a numeric amount followed by a duration unit. */
const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i;

/** Parse a Cloudflare-style `number | string` duration into milliseconds. */
const toMs = (duration: number | string): number => {
    if (typeof duration === "number") {
        // `NaN` and `Infinity` are rejected rather than clamped: both would reach
        // `context.sleep` as a wake-at the engine can never satisfy, so a run
        // sleeps forever with no error to explain it.
        if (!Number.isFinite(duration)) {
            throw new LunoraError("VALIDATION_ERROR", `@lunora/platform-node: workflow duration must be finite, got ${String(duration)}`);
        }

        return Math.max(0, duration);
    }

    const match = DURATION_PATTERN.exec(duration.trim());

    if (match === null) {
        throw new LunoraError("VALIDATION_ERROR", `@lunora/platform-node: unsupported workflow duration "${duration}"`);
    }

    const amount = Number(match[1]);
    const unit = (match[2] ?? "").toLowerCase();
    const perUnit = DURATION_MS[unit];

    if (perUnit === undefined) {
        throw new LunoraError("VALIDATION_ERROR", `@lunora/platform-node: unsupported workflow duration "${duration}"`);
    }

    const ms = amount * perUnit;

    // A literal so large it overflows to `Infinity` ("1e400 ms") parses fine and
    // is just as unsatisfiable as an explicit `Infinity`.
    if (!Number.isFinite(ms)) {
        throw new LunoraError("VALIDATION_ERROR", `@lunora/platform-node: workflow duration "${duration}" overflows`);
    }

    return Math.max(0, ms);
};

/**
 * Refuse a caller-supplied instance id. `runtime.trigger` mints its own run id
 * and accepts no override, so accepting the option would return a *different*
 * instance than the caller asked for — a retried create would fan out into
 * distinct runs and `get(id)` would never find any of them.
 */
const rejectCallerId = (instanceId: string | undefined): void => {
    if (instanceId !== undefined) {
        throw new LunoraError(
            "NOT_IMPLEMENTED",
            `@lunora/platform-node: workflow create({ id: "${instanceId}" }) is not supported — the visulima engine assigns run ids; use the returned instance's id`,
        );
    }
};

/** The per-attempt info a `step.do` callback receives — the engine has no retries, so attempt is always 1. */
const stepContext = (name: string): WorkflowStepContextLike => {
    return {
        attempt: 1,
        config: { retries: { limit: 1 } },
        step: { count: 1, name },
    };
};

/** Map a visulima `RunStatus` onto the Lunora `WorkflowInstanceStatus` vocabulary. */
const mapStatus = (status: RunStatus): WorkflowInstanceStatus => {
    switch (status) {
        case "completed": {
            return "complete";
        }
        case "failed": {
            return "errored";
        }
        default: {
            return "waiting";
        }
    }
};

/** Adapt a visulima `RunContext` into the native `WorkflowStepLike` surface. */
const createStepAdapter = (context: RunContext): WorkflowStepLike => {
    return {
        do: (async (
            name: string,
            configOrCallback: WorkflowStepConfigLike | ((context: WorkflowStepContextLike) => Promise<unknown>),
            maybeCallback?: (context: WorkflowStepContextLike) => Promise<unknown>,
            _rollback?: unknown,
        ) => {
            const callback = typeof configOrCallback === "function" ? configOrCallback : maybeCallback;

            if (typeof callback !== "function") {
                throw new LunoraError("VALIDATION_ERROR", `@lunora/platform-node: step.do("${name}") requires a callback`);
            }

            return context.step(name, async () => callback(stepContext(name)));
        }) as WorkflowStepLike["do"],
        sleep: async (name, duration) => {
            const ms = toMs(duration);

            if (ms === 0) {
                return;
            }

            await context.sleep(name, ms);
        },
        sleepUntil: async (name, timestamp) => {
            const target = typeof timestamp === "number" ? timestamp : timestamp.getTime();

            // An invalid `Date` yields `NaN`, which `Math.max` propagates straight
            // through to `context.sleep`.
            if (!Number.isFinite(target)) {
                throw new LunoraError("VALIDATION_ERROR", `@lunora/platform-node: step.sleepUntil("${name}") needs a valid timestamp`);
            }

            const ms = Math.max(0, target - Date.now());

            if (ms === 0) {
                return;
            }

            await context.sleep(name, ms);
        },
        waitForEvent: (async (name, options) => {
            const payload = await context.waitForEvent(name, options.type, {
                timeout: options.timeout === undefined ? undefined : toMs(options.timeout),
            });

            return { payload, type: options.type };
        }) as WorkflowStepLike["waitForEvent"],
    };
};

/** Options for {@link createNodeWorkflowHost}. */
interface NodeWorkflowHostOptions<Workflows extends Record<string, { isLunoraWorkflow: true }>> {
    /** Base env merged under the derived `WORKFLOW_*` bindings — surfaced to workflow bodies as `ctx.env` and used to resolve spawned children. */
    env?: Record<string, unknown>;
    /** How long (ms) the engine holds a cross-process lease while an activation runs, for stores that implement `acquire`. Defaults to 30000. */
    leaseTtlMs?: number;
    /** Where runs are persisted. Required — see the header for why there is no default. `createNodeWorkflowStore(database)` is the durable one. */
    store: WorkflowStore;
    /** The declared workflows keyed by their `lunora/workflows.ts` export name (e.g. `{ orderPipeline: orderPipeline }`). Values must be `defineWorkflow` results. */
    workflows: Workflows;
}

/** A fully-wired Node workflow host. */
interface NodeWorkflowHost<Workflows extends Record<string, { isLunoraWorkflow: true }>> {
    /** Per-export-name `WorkflowBindingLike` — the map `ctx.workflows` consumes. */
    readonly bindings: { [K in keyof Workflows]: WorkflowBindingLike };

    /**
     * The caller's `env` plus one `WORKFLOW_&lt;EXPORT>` binding per workflow —
     * merge this into a worker env so `ctx.spawn`/`ctx.parallel` resolve
     * children through the same runtime.
     */
    readonly env: Record<string, unknown>;
    /** The underlying visulima runtime — `sweep`/`signal` for a dev loop or tests. */
    readonly runtime: WorkflowRuntime;
}

/**
 * Create a Node workflow host: compile every declared Lunora workflow onto the
 * visulima engine, derive the `WORKFLOW_*` env, and expose the per-workflow
 * `WorkflowBindingLike` handles.
 */
const createNodeWorkflowHost = <Workflows extends Record<string, { isLunoraWorkflow: true }>>(
    options: NodeWorkflowHostOptions<Workflows>,
): NodeWorkflowHost<Workflows> => {
    const entries = Object.entries(options.workflows);
    const idByExport = new Map<string, string>();

    for (const [exportName, value] of entries) {
        if (!isWorkflowDefinition(value)) {
            throw new LunoraError("VALIDATION_ERROR", `@lunora/platform-node: "${exportName}" is not a defineWorkflow result`);
        }

        idByExport.set(exportName, value.name ?? workflowDefaultName(exportName));
    }

    const { store } = options;
    const env: Record<string, unknown> = { ...options.env };

    const visulimaWorkflows = entries.map(([exportName]) => {
        const definition = options.workflows[exportName];

        if (!isWorkflowDefinition(definition)) {
            throw new LunoraError("VALIDATION_ERROR", `@lunora/platform-node: "${exportName}" is not a defineWorkflow result`);
        }

        const id = idByExport.get(exportName) as string;

        return defineVisulimaWorkflow({
            id,
            tags: [exportName],
            run: async (runContext: RunContext) => {
                const step = createStepAdapter(runContext);
                const context = createWorkflowRunContext({
                    env,
                    event: {
                        instanceId: runContext.runId,
                        payload: runContext.payload as Record<string, unknown>,
                        timestamp: new Date(),
                        workflowName: id,
                    },
                    exportName,
                    step,
                });

                return await definition.handler(context);
            },
        });
    });

    const runtime = createRuntime({ leaseTtlMs: options.leaseTtlMs, store, workflows: visulimaWorkflows });

    const instanceFor = (id: string): WorkflowInstanceLike => {
        return {
            id,
            pause: () =>
                Promise.reject(
                    new LunoraError(
                        "NOT_IMPLEMENTED",
                        `@lunora/platform-node: workflow instance "${id}" cannot be paused — the visulima engine has no pause equivalent`,
                    ),
                ),
            restart: () =>
                Promise.reject(
                    new LunoraError(
                        "NOT_IMPLEMENTED",
                        `@lunora/platform-node: workflow instance "${id}" cannot be restarted — the visulama engine has no restart equivalent`,
                    ),
                ),
            resume: async () => {
                await runtime.resume(id);
            },
            sendEvent: async (event) => {
                const run = await runtime.getRun(id);

                if (run?.status !== "waiting" || run.pending?.kind !== "event" || run.pending.eventName !== event.type) {
                    throw new LunoraError("BAD_REQUEST", `@lunora/platform-node: workflow instance "${id}" is not waiting for event "${event.type}"`);
                }

                await runtime.signal(id, event.type, event.payload);
            },
            status: async (): Promise<WorkflowStatusResult> => {
                const stored = await store.load(id);

                if (stored?.definitionId === TERMINATED_DEFINITION_ID) {
                    return { status: "terminated" };
                }

                const run = await runtime.getRun(id);

                if (run === undefined) {
                    return { status: "unknown" };
                }

                return {
                    error: run.error === undefined ? undefined : { message: run.error.message, name: run.error.name },
                    output: run.output,
                    status: mapStatus(run.status),
                };
            },
            terminate: async () => {
                // Overwrite rather than delete: a deleted run reads back as
                // `unknown`, which is also what an invalid instance id returns,
                // so the caller loses the ability to tell the two apart.
                await store.save({
                    definitionId: TERMINATED_DEFINITION_ID,
                    runId: id,
                    snapshot: undefined,
                    status: "failed",
                    updatedAt: Date.now(),
                });
            },
        };
    };

    const bindings: Record<string, WorkflowBindingLike> = {};

    for (const [exportName] of entries) {
        const id = idByExport.get(exportName) as string;
        const binding: WorkflowBindingLike = {
            create: async (createOptions) => {
                rejectCallerId(createOptions?.id);

                const result = await runtime.trigger(id, createOptions?.params);

                return instanceFor(result.runId);
            },
            createBatch: async (batch) => {
                for (const createOptions of batch) {
                    rejectCallerId(createOptions.id);
                }

                const results = await Promise.all(batch.map((createOptions) => runtime.trigger(id, createOptions.params)));

                return results.map((result) => instanceFor(result.runId));
            },
            get: (instanceId) => Promise.resolve(instanceFor(instanceId)),
        };

        bindings[exportName] = binding;
        env[workflowBindingName(exportName)] = binding;
    }

    return { bindings: bindings as NodeWorkflowHost<Workflows>["bindings"], env, runtime };
};

export { createNodeWorkflowHost };
export type { NodeWorkflowHost, NodeWorkflowHostOptions };
