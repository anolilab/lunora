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
 * once its handler finishes. The parent awaits all those joins CONCURRENTLY — so a
 * failure anywhere fails the group at once rather than after every earlier-declared
 * branch has finished — and slots each result into its declaration-order position,
 * returning a tuple of branch outputs. Children are arbitrary user workflows —
 * nothing about their bodies
 * changes; only the base class learns to call home.
 */
import { LunoraError } from "@lunora/errors";

import { BRANCH_MARKER_KEY, BRANCH_MARKER_REJECTION, hasBranchMarker } from "../../../shared/branch-marker";
import { RESERVED_EVENT_TYPE_PREFIX } from "./define-event";
import { isDuplicateInstanceError, NonRetryableError } from "./errors";
import type {
    BranchCompensationParams,
    WorkflowBranch,
    WorkflowInstanceLike,
    WorkflowLogger,
    WorkflowParallelFunction,
    WorkflowSpawnFunction,
    WorkflowStepLike,
} from "./types";

/** Hard cap on branches per `ctx.parallel` call — auto-scale, never silently spawn unbounded DOs. */
const MAX_BRANCHES = 100;

/** Durable-step name prefix for a branch/spawn create. */
const SPAWN_STEP_PREFIX = "lunora:spawn:";
/** Durable-step name prefix for the parent's per-branch join wait. */
const AWAIT_STEP_PREFIX = "lunora:await:";
/** Durable-step name prefix for the child's completion signal back to the parent. */
const SIGNAL_STEP_PREFIX = "lunora:signal:";
/** Durable-step name prefix for a completed branch's group-saga compensation spawn. */
const COMPENSATE_STEP_PREFIX = "lunora:compensate:";

/**
 * Event-type prefix the parent waits on and the child sends. Derived from the
 * reserved namespace rather than re-spelled, so the guard that rejects user events
 * in that namespace can never stop covering it.
 */
const BRANCH_EVENT_PREFIX = `${RESERVED_EVENT_TYPE_PREFIX}branch:`;

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
    /** Optional structured logger — used to surface best-effort failures (e.g. a stranded group-saga compensation) without aborting the flow. */
    log?: WorkflowLogger;
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
    options?: { compensateWith?: string; id?: string; timeout?: number | string },
): WorkflowBranch<Output> => {
    return { compensateWith: options?.compensateWith, id: options?.id, params, timeout: options?.timeout, workflow };
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
 * Cloudflare's hard ceiling on a workflow event payload. An outcome over it can
 * never reach the parent — `sendEvent` rejects on every retry.
 * https://developers.cloudflare.com/workflows/reference/limits/
 */
const MAX_EVENT_PAYLOAD_BYTES = 1_048_576;

/**
 * Start a child instance, or attach to the one a previous attempt already
 * started.
 *
 * `step.do` memoizes a step's RESULT, not its side effects: a spawn body that
 * fails *after* `create` landed (an RPC/transport error, a DO eviction
 * mid-step) is re-run, and Cloudflare rejects the second create with "instance
 * already exists". Without this the step burned its retries and `ctx.spawn` /
 * `ctx.parallel` failed while the child it had just started kept running —
 * contradicting the replay-re-attachment the docs promise. A duplicate-id
 * rejection is exactly the signal that the create applied, so take the existing
 * instance over; every other rejection surfaces so the step retries or fails
 * visibly.
 */
const createOrAttach = async (
    binding: ReturnType<WorkflowBindingResolver>,
    options: { id: string; params?: Record<string, unknown> },
): Promise<WorkflowInstanceLike> => {
    try {
        return await binding.create(options);
    } catch (error: unknown) {
        if (!isDuplicateInstanceError(error)) {
            throw error;
        }

        return await binding.get(options.id);
    }
};

/** A branch after id/event-type allocation — the parent's per-branch join bookkeeping. */
interface PlannedBranch {
    childId: string;
    eventType: string;
    index: number;
    item: WorkflowBranch;
}

/**
 * Internal carrier for the first branch (in wall-clock order) to fail its join.
 *
 * Concurrent joins reject rather than return, so the branch that lost has to travel
 * out through `Promise.all` with enough context to build the group's terminal message
 * and pick the error the compensations receive. Never escapes `createParallel`.
 */
class BranchJoinFailure extends Error {
    public readonly branchError: { message: string; name: string };

    public readonly kind: "failed" | "join failed";

    public readonly plan: PlannedBranch;

    public constructor(plan: PlannedBranch, branchError: { message: string; name: string }, kind: "failed" | "join failed") {
        super(branchError.message);
        this.branchError = branchError;
        this.kind = kind;
        this.plan = plan;
    }
}

/**
 * Group-saga rollback (plan 075 Phase 3): on a branch failure, spawn each
 * already-completed sibling's declared `compensateWith` workflow in reverse
 * declaration order. Each spawn is a durable, replay-safe idempotent create
 * (keyed by the completed child's id via `step.do` memoization), so a parent
 * replay re-attaches instead of double-compensating. Completed branches with no
 * `compensateWith` are skipped; the failing branch itself is never compensated
 * (its own per-step rollbacks already ran inside its instance).
 */
const compensateCompleted = async (
    deps: FanOutDeps,
    completed: ReadonlyArray<{ output: unknown; plan: PlannedBranch }>,
    error: { message: string; name: string },
): Promise<void> => {
    for (let cursor = completed.length - 1; cursor >= 0; cursor -= 1) {
        const done = completed[cursor];
        const compensateWith = done?.plan.item.compensateWith;

        if (done === undefined || compensateWith === undefined) {
            continue;
        }

        try {
            // Resolve the compensation binding OUTSIDE the durable step: a missing or
            // typo'd `compensateWith` export throws deterministically here (no wasted
            // step retries on an error that can never succeed) and is caught below.
            const compensation = deps.resolveBinding(compensateWith);

            // eslint-disable-next-line no-await-in-loop -- reverse-order group-saga compensation, one durable spawn per completed branch
            await deps.step.do(`${COMPENSATE_STEP_PREFIX}${done.plan.childId}`, async (): Promise<string> => {
                const compensateId = `${done.plan.childId}:compensate`;
                const compensationParams: BranchCompensationParams = {
                    branch: done.plan.item.workflow,
                    error,
                    index: done.plan.index,
                    output: done.output,
                };

                await createOrAttach(compensation, { id: compensateId, params: compensationParams });

                return compensateId;
            });
        } catch (compensationError: unknown) {
            // A single failed compensation (unresolvable binding, create rejection)
            // must not strand the earlier-declared siblings' rollbacks nor mask the
            // original group failure — log it and continue the reverse loop.
            deps.log?.error(
                `ctx.parallel: group-saga compensation "${compensateWith}" for branch "${done.plan.item.workflow}" (#${String(done.plan.index)}) failed`,
                compensationError,
            );
        }
    }
};

/**
 * Build `ctx.parallel` for one workflow invocation. Spawns each branch as an
 * isolated child instance, hibernates on all the per-branch `waitForEvent` joins at
 * once, and returns the branch outputs in declaration order. Throws (non-retryable —
 * retrying the join cannot re-run an already-failed child) on the first branch to
 * report an error in WALL-CLOCK order, not the first in declaration order:
 * `ctx.parallel` is documented fail-fast, and a declaration-order loop made a group
 * whose first branch runs for an hour wait that hour to notice its second branch had
 * failed in a second. Still-running siblings are left to finish (Cloudflare cannot
 * cleanly cancel a running instance).
 *
 * **Group saga (plan 075 Phase 3):** when a branch fails, every *already-completed*
 * sibling that declared a `compensateWith` workflow is rolled back — its
 * compensation workflow is spawned (durable, replay-safe, in reverse declaration
 * order) with {@link BranchCompensationParams} — before the group failure is
 * thrown. "Already-completed" means completed at the instant of failure, in any
 * order: a sibling that finished ahead of an earlier-declared one used to be
 * invisible to the loop and its rollback was silently skipped. A group where no
 * branch sets `compensateWith` behaves exactly as a plain fail-fast fan-out, so the
 * feature is zero-overhead until opted into.
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
        const planned: PlannedBranch[] = branches.map((item, index) => {
            const childId = deps.nextChildId(item.id);

            return { childId, eventType: `${BRANCH_EVENT_PREFIX}${childId}`, index, item };
        });

        // Reject duplicate child ids up front. Two branches resolving to the same id
        // (a repeated explicit `id`, or an explicit id colliding with a derived one)
        // share a spawn/await/event step name, so `step.do` memoization would silently
        // drop the second spawn and both joins would wait on the same event — wrong
        // output or a hang. Fail loud and non-retryable instead.
        const seenIds = new Set<string>();

        for (const plan of planned) {
            if (seenIds.has(plan.childId)) {
                throw new NonRetryableError(
                    `ctx.parallel: duplicate branch id "${plan.childId}" — each branch in a group must resolve to a unique child instance id (check explicit \`id\` options)`,
                );
            }

            seenIds.add(plan.childId);
        }

        // 1. Spawn all branches concurrently. `step.do` memoizes by name, so the
        //    create runs exactly once across replays/restarts.
        await Promise.all(
            planned.map((plan) =>
                deps.step.do(`${SPAWN_STEP_PREFIX}${plan.childId}`, async (): Promise<string> => {
                    const binding = deps.resolveBinding(plan.item.workflow);
                    const marker: BranchMarker = { eventType: plan.eventType, index: plan.index, parentBinding: deps.parentBinding, parentId: deps.instanceId };

                    await createOrAttach(binding, { id: plan.childId, params: { ...plan.item.params, [BRANCH_MARKER_KEY]: marker } });

                    return plan.childId;
                }),
            ),
        );

        // 2. Join: hibernate until each branch signals back. CONCURRENT, not a
        //    declaration-order loop — a loop observes branch #1's failure only after
        //    branch #0's join returns, so a group whose first branch runs for an hour
        //    is not fail-fast, and a sibling that finished out of declaration order
        //    was absent from `completed` and never compensated. Both are documented
        //    guarantees. `Promise.all` rejects on the first branch to fail in
        //    WALL-CLOCK order and handles the later rejections itself, and each join
        //    records its own completion as it lands, so `completed` is the true
        //    already-finished set at the instant of failure.
        const results: unknown[] = Array.from({ length: planned.length });
        const completed: ({ output: unknown; plan: PlannedBranch } | undefined)[] = Array.from({ length: planned.length });

        const join = async (plan: PlannedBranch): Promise<void> => {
            let outcome: BranchOutcome;

            try {
                const event = await deps.step.waitForEvent<BranchOutcome>(`${AWAIT_STEP_PREFIX}${plan.childId}`, {
                    timeout: plan.item.timeout,
                    type: plan.eventType,
                });

                outcome = event.payload;
            } catch (joinError: unknown) {
                // The join itself failed — the per-branch `timeout` elapsed because
                // the child was terminated (or its parent binding was absent, so its
                // signal no-op'd) before it could report back. Treated exactly as a
                // reported branch error, so a timed-out join compensates its siblings
                // rather than stranding them.
                throw new BranchJoinFailure(plan, serializeError(joinError), "join failed");
            }

            if (outcome.status === "error") {
                throw new BranchJoinFailure(plan, outcome.error, "failed");
            }

            completed[plan.index] = { output: outcome.value, plan };
            results[plan.index] = outcome.value;
        };

        try {
            await Promise.all(planned.map((plan) => join(plan)));
        } catch (error: unknown) {
            if (!(error instanceof BranchJoinFailure)) {
                throw error;
            }

            // Group saga: roll back every sibling that HAD completed when the group
            // failed, in reverse declaration order. `completed` is sparse — a branch
            // still running has no entry — so compact it before handing it over.
            await compensateCompleted(
                deps,
                completed.filter((done) => done !== undefined),
                error.branchError,
            );

            throw new NonRetryableError(
                `ctx.parallel: branch "${error.plan.item.workflow}" (#${String(error.plan.index)}) ${error.kind}: ${error.branchError.message}`,
            );
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
        // Reject a caller-supplied reserved branch marker at the trust boundary —
        // only `createParallel`'s internal injection may set `__lunoraBranch`.
        if (hasBranchMarker(params)) {
            throw new LunoraError("BAD_REQUEST", `@lunora/workflow: params ${BRANCH_MARKER_REJECTION}`);
        }

        const childId = deps.nextChildId(options?.id);

        await deps.step.do(`${SPAWN_STEP_PREFIX}${childId}`, async (): Promise<string> => {
            const binding = deps.resolveBinding(workflow);

            await createOrAttach(binding, { id: childId, params });

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

    // Defense-in-depth: even if a marker slips past the create-surface guard,
    // constrain the parent dereference to a `WORKFLOW_*` binding and the send to
    // the branch event namespace. Legitimate markers always satisfy both
    // (createParallel builds `WORKFLOW_*` bindings and `lunora:branch:*` types).
    if (!candidate.parentBinding.startsWith("WORKFLOW_") || !candidate.eventType.startsWith(BRANCH_EVENT_PREFIX)) {
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
 * Swap an outcome the event channel cannot carry for a bounded failure that it
 * can.
 *
 * Cloudflare caps an event payload at {@link MAX_EVENT_PAYLOAD_BYTES}. A branch
 * whose output is over it had `sendEvent` reject on every retry of the signal
 * step; the failure was swallowed as best-effort, the child completed, and the
 * parent then hibernated on its join until the branch `timeout` (Cloudflare's
 * default is 24 hours) before compensating a branch that had actually
 * succeeded. Reporting the size failure instead fails the group in seconds with
 * a message that names the branch and the byte count.
 *
 * Measured on the serialised form, because that is what the host puts on the
 * wire, and applied to the error path too — an oversized error message is just
 * as undeliverable as an oversized value.
 */
const boundOutcome = (outcome: BranchOutcome): BranchOutcome => {
    const bytes = new TextEncoder().encode(JSON.stringify(outcome)).length;

    if (bytes <= MAX_EVENT_PAYLOAD_BYTES) {
        return outcome;
    }

    return {
        error: {
            message:
                `branch outcome serialises to ${String(bytes)} bytes, over Cloudflare's ${String(MAX_EVENT_PAYLOAD_BYTES)}-byte event payload limit — ` +
                "the parent can never receive it. Return a reference the parent can dereference (an R2 key, a row id) instead of the payload itself",
            name: "BranchOutputTooLarge",
        },
        status: "error",
    };
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
    const deliverable = boundOutcome(outcome);

    await deps.step.do(`${SIGNAL_STEP_PREFIX}${String(marker.index)}`, async (): Promise<string> => {
        const parent = await getParent(marker.parentId);

        await parent.sendEvent({ payload: deliverable, type: marker.eventType });

        return marker.eventType;
    });
};

/**
 * A never-throwing wrapper over {@link signalBranchParent}. A failed parent signal —
 * the parent instance was terminated, or `sendEvent` rejects after its durable
 * step retries — must not become the child's own recorded failure (success path)
 * nor mask the handler's real error (error path). The parent simply falls back to
 * its `waitForEvent` timeout when the signal is lost. The failure is logged when a
 * logger is provided.
 */
const signalBranchParentSafe = async (
    deps: { env: Record<string, unknown>; log?: WorkflowLogger; step: WorkflowStepLike },
    marker: BranchMarker,
    outcome: BranchOutcome,
): Promise<void> => {
    try {
        await signalBranchParent(deps, marker, outcome);
    } catch (signalError: unknown) {
        deps.log?.error(`@lunora/workflow: failed to signal branch parent "${marker.parentId}" (event "${marker.eventType}")`, signalError);
    }
};

export type { BranchMarker, BranchOutcome, FanOutDeps, WorkflowBindingResolver };
export {
    branch,
    createParallel,
    createSpawn,
    errorOutcome,
    extractBranchMarker,
    MAX_BRANCHES,
    okOutcome,
    signalBranchParent,
    signalBranchParentSafe,
    stripBranchMarker,
};
