/**
 * `ctx.parallel` / `ctx.spawn` — workflow fan-out with child-DO resource
 * isolation. Each branch runs as its own child workflow instance (its own
 * Durable Object: ~128 MB memory, 5 min CPU, independent retry budget) instead
 * of sharing the parent instance's single budget the way `Promise.all` of
 * `ctx.runStep(...)` would.
 *
 * Node-safe (no `cloudflare:workers` import): the native durable `step`, the
 * `WORKFLOW_*` bindings, and the parent's identity are all injected, so the whole
 * spawn/join orchestration is unit-testable with plain doubles. The workerd-only
 * `src/do` base class supplies the real values and runs the child-side signal.
 *
 * ### How the join works
 *
 * The parent spawns every branch (idempotent `step.do` create, keyed by a
 * deterministic child id so a parent replay re-attaches instead of double-
 * spawning), then **hibernates** on a `step.waitForEvent` per branch. Each child
 * is an ordinary declared workflow; the base class wraps it so that, when spawned
 * as a branch, it `sendEvent`s its result (or error) back to the parent instance
 * once its handler finishes. The parent collects the events in declaration order,
 * returning a tuple of branch outputs, and fails fast if any branch reports an
 * error. Children are arbitrary user workflows — nothing about their bodies
 * changes; only the base class learns to call home.
 */
import { NonRetryableError } from "./errors";
import type { WorkflowBranch, WorkflowInstanceLike, WorkflowParallelFunction, WorkflowSpawnFunction, WorkflowStepLike } from "./types";

/** Hard cap on branches per `ctx.parallel` call — auto-scale, never silently spawn unbounded DOs. */
const MAX_BRANCHES = 100;

/** The params key the parent injects so a child knows to signal completion back. Stripped before the user handler sees `ctx.params`. */
const BRANCH_MARKER_KEY = "__lunoraBranch";

/** Durable-step name prefix for a branch/spawn create. */
const SPAWN_STEP_PREFIX = "lunora:spawn:";
/** Durable-step name prefix for the parent's per-branch join wait. */
const AWAIT_STEP_PREFIX = "lunora:await:";
/** Durable-step name prefix for the child's completion signal back to the parent. */
const SIGNAL_STEP_PREFIX = "lunora:signal:";
/** Event-type prefix the parent waits on and the child sends. */
const BRANCH_EVENT_PREFIX = "lunora:branch:";

/** The completion event a branch child sends to its parent. Discriminated so an `undefined` value is distinguishable from a failure. */
type BranchOutcome = { error: { message: string; name: string }; status: "error" } | { status: "ok"; value?: unknown };

/** The marker the parent injects into a child's params and the child reads back to address its parent. */
interface BranchMarker {
    /** The event type the parent waits on for this branch. */
    eventType: string;
    /** Declaration-order index of the branch (for log correlation). */
    index: number;
    /** The parent workflow's own `WORKFLOW_*` binding name — how the child reaches back. */
    parentBinding: string;
    /** The parent workflow instance id. */
    parentId: string;
}

/** Resolve a declared child workflow's `WORKFLOW_*` binding by export name; throws a helpful error when absent. */
type WorkflowBindingResolver = (workflow: string) => {
    create: (options?: { id?: string; params?: Record<string, unknown> }) => Promise<WorkflowInstanceLike>;
    get: (id: string) => Promise<WorkflowInstanceLike>;
};

/** Dependencies the fan-out factories close over — all injected so the orchestration is Node-testable. */
interface FanOutDeps {
    /** The Worker environment bindings (used to reach the parent binding on the child side). */
    env: Record<string, unknown>;
    /** The running workflow's instance id — the parent id stamped into each child. */
    instanceId: string;
    /** Allocate the next deterministic child instance id (replay-stable; honors an explicit id). */
    nextChildId: (explicit?: string) => string;
    /** The running workflow's own `WORKFLOW_*` binding name — passed to children so they can signal back. */
    parentBinding: string;
    /** Resolve a child workflow's binding by export name. */
    resolveBinding: WorkflowBindingResolver;
    /** The native Cloudflare durable-step API. */
    step: WorkflowStepLike;
}

/**
 * Build a single fan-out branch: a declared child workflow referenced by its
 * `lunora/workflows.ts` export name, plus the params it is created with. Pass the
 * output type as the generic argument so `ctx.parallel(...)` infers the result
 * tuple — e.g. `branch("imageTag", { key })` typed as `branch` of `{ tags }`.
 */
const branch = <Output = unknown>(
    workflow: string,
    params?: Record<string, unknown>,
    options?: { id?: string; timeout?: number | string },
): WorkflowBranch<Output> => {
    return { id: options?.id, params, timeout: options?.timeout, workflow };
};

/** Reduce an unknown thrown value to the serialisable `{ message, name }` a branch event carries. */
const serializeError = (error: unknown): { message: string; name: string } => {
    if (error instanceof Error) {
        return { message: error.message, name: error.name };
    }

    return { message: String(error), name: "Error" };
};

/** Build the success outcome a completed branch reports to its parent. */
const okOutcome = (value: unknown): BranchOutcome => {
    return { status: "ok", value };
};

/** Build the failure outcome a thrown branch reports to its parent. */
const errorOutcome = (error: unknown): BranchOutcome => {
    return { error: serializeError(error), status: "error" };
};

/**
 * Build `ctx.parallel` for one workflow invocation. Spawns each branch as an
 * isolated child instance, hibernates on a per-branch `waitForEvent`, and returns
 * the branch outputs in declaration order. Throws (non-retryable — retrying the
 * join cannot re-run an already-failed child) on the first branch that reports an
 * error; still-running siblings are left to finish (Cloudflare cannot cleanly
 * cancel a running instance).
 */
const createParallel = (deps: FanOutDeps): WorkflowParallelFunction => {
    const run = async (branches: ReadonlyArray<WorkflowBranch>): Promise<unknown[]> => {
        if (branches.length === 0) {
            return [];
        }

        if (branches.length > MAX_BRANCHES) {
            throw new NonRetryableError(
                `ctx.parallel: ${String(branches.length)} branches exceeds the cap of ${String(MAX_BRANCHES)} — split the fan-out or raise the work into fewer child workflows`,
            );
        }

        // Assign deterministic ids + event types synchronously, in declaration
        // order, BEFORE any await — so a parent replay reproduces the exact same
        // ids and re-attaches to the existing children rather than spawning new ones.
        const planned = branches.map((item, index) => {
            const childId = deps.nextChildId(item.id);

            return { childId, eventType: `${BRANCH_EVENT_PREFIX}${childId}`, index, item };
        });

        // 1. Spawn all branches concurrently. `step.do` memoizes by name, so the
        //    create runs exactly once across replays/restarts.
        await Promise.all(
            planned.map((plan) =>
                deps.step.do(`${SPAWN_STEP_PREFIX}${plan.childId}`, async (): Promise<string> => {
                    const binding = deps.resolveBinding(plan.item.workflow);
                    const marker: BranchMarker = { eventType: plan.eventType, index: plan.index, parentBinding: deps.parentBinding, parentId: deps.instanceId };

                    await binding.create({ id: plan.childId, params: { ...plan.item.params, [BRANCH_MARKER_KEY]: marker } });

                    return plan.childId;
                }),
            ),
        );

        // 2. Join: hibernate until each branch signals back. Sequential in
        //    declaration order — events are buffered by type, so the wall-clock is
        //    max(branch durations), not the sum, and the result order is stable.
        const results: unknown[] = [];

        for (const plan of planned) {
            // eslint-disable-next-line no-await-in-loop -- sequential, ordered join; per-type event buffering keeps wall-clock at max(branch), not the sum
            const event = await deps.step.waitForEvent<BranchOutcome>(`${AWAIT_STEP_PREFIX}${plan.childId}`, {
                timeout: plan.item.timeout,
                type: plan.eventType,
            });
            const outcome = event.payload;

            if (outcome.status === "error") {
                throw new NonRetryableError(`ctx.parallel: branch "${plan.item.workflow}" (#${String(plan.index)}) failed: ${outcome.error.message}`);
            }

            results.push(outcome.value);
        }

        return results;
    };

    return run as unknown as WorkflowParallelFunction;
};

/**
 * Build `ctx.spawn` for one workflow invocation — fire-and-forget start of a
 * declared child workflow, with replay-safe idempotent create. Returns a live
 * handle to the child instance (no join; use `ctx.parallel` to await results).
 */
const createSpawn =
    (deps: FanOutDeps): WorkflowSpawnFunction =>
    async (workflow: string, params?: Record<string, unknown>, options?: { id?: string }): Promise<WorkflowInstanceLike> => {
        const childId = deps.nextChildId(options?.id);

        await deps.step.do(`${SPAWN_STEP_PREFIX}${childId}`, async (): Promise<string> => {
            const binding = deps.resolveBinding(workflow);

            await binding.create({ id: childId, params });

            return childId;
        });

        return deps.resolveBinding(workflow).get(childId);
    };

/**
 * Read the parent-callback marker the spawning parent injected into a child's
 * params, or `undefined` when this instance was not spawned as a branch (a
 * top-level instance, or a `ctx.spawn` fire-and-forget child). The base class
 * uses it to decide whether to signal completion back.
 */
const extractBranchMarker = (payload: unknown): BranchMarker | undefined => {
    if (typeof payload !== "object" || payload === null) {
        return undefined;
    }

    const marker = (payload as Record<string, unknown>)[BRANCH_MARKER_KEY];

    if (typeof marker !== "object" || marker === null) {
        return undefined;
    }

    const candidate = marker as Record<string, unknown>;

    if (
        typeof candidate.eventType !== "string" ||
        typeof candidate.parentBinding !== "string" ||
        typeof candidate.parentId !== "string" ||
        typeof candidate.index !== "number"
    ) {
        return undefined;
    }

    return { eventType: candidate.eventType, index: candidate.index, parentBinding: candidate.parentBinding, parentId: candidate.parentId };
};

/** Return the child's params with the internal branch marker removed — the shape the user handler's `ctx.params` should see. */
const stripBranchMarker = (payload: unknown): unknown => {
    if (typeof payload !== "object" || payload === null) {
        return payload;
    }

    const rest = { ...(payload as Record<string, unknown>) };

    Reflect.deleteProperty(rest, BRANCH_MARKER_KEY);

    return rest;
};

/**
 * Signal a branch's terminal outcome back to its parent (a durable `step.do`, so
 * the send is retried until it lands). Best-effort: if the parent binding is
 * unavailable the call is a no-op and the parent's `waitForEvent` falls back to
 * its timeout. Pass the result on success or the serialised error on failure.
 */
const signalBranchParent = async (
    deps: { env: Record<string, unknown>; step: WorkflowStepLike },
    marker: BranchMarker,
    outcome: BranchOutcome,
): Promise<void> => {
    const binding = deps.env[marker.parentBinding] as { get?: (id: string) => Promise<WorkflowInstanceLike> } | undefined;

    if (!binding || typeof binding.get !== "function") {
        return;
    }

    const getParent = binding.get.bind(binding);

    await deps.step.do(`${SIGNAL_STEP_PREFIX}${String(marker.index)}`, async (): Promise<string> => {
        const parent = await getParent(marker.parentId);

        await parent.sendEvent({ payload: outcome, type: marker.eventType });

        return marker.eventType;
    });
};

export type { BranchMarker, BranchOutcome, FanOutDeps, WorkflowBindingResolver };
export {
    branch,
    BRANCH_MARKER_KEY,
    createParallel,
    createSpawn,
    errorOutcome,
    extractBranchMarker,
    MAX_BRANCHES,
    okOutcome,
    signalBranchParent,
    stripBranchMarker,
};
