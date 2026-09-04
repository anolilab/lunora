import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import { BRANCH_MARKER_KEY, BRANCH_MARKER_REJECTION, hasBranchMarker } from "../../../shared/branch-marker";
import type { BranchOutcome, FanOutDeps } from "../src/fan-out";
import {
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
} from "../src/fan-out";
import type { WorkflowInstanceLike, WorkflowStatusResult, WorkflowStepLike } from "../src/types";

/**
 * The engine's own instance-id grammar and length cap, copied from the shared
 * validators the Workflows runtime applies to every `create` before it does
 * anything else (miniflare's `binding.worker.js` — the same file the workerd
 * harness and `wrangler dev` load).
 *
 * Note what it excludes: `:` is NOT in the character class. A double that
 * accepts any string lets a colon-bearing id pass here and fail in production —
 * which is exactly how the group-saga rollback shipped inert.
 */
const ENGINE_INSTANCE_ID_PATTERN = /^\w[\w-]*$/u;
const ENGINE_MAX_INSTANCE_ID_LENGTH = 100;

/** The engine's create-time id check, mirrored so the doubles reject what the runtime rejects. */
const engineRejectsInstanceId = (id: unknown): boolean =>
    typeof id !== "string" || id.length > ENGINE_MAX_INSTANCE_ID_LENGTH || !ENGINE_INSTANCE_ID_PATTERN.test(id);

/** A fake instance handle — only the methods the fan-out path touches are real. */
const makeInstance = (id: string): WorkflowInstanceLike => {
    return {
        id,
        pause: vi.fn<() => Promise<void>>(),
        restart: vi.fn<() => Promise<void>>(),
        resume: vi.fn<() => Promise<void>>(),
        sendEvent: vi.fn<(event: { payload: unknown; type: string }) => Promise<void>>(async () => undefined),
        // The real handle always answers with a `WorkflowStatusResult`; a double
        // that resolved `undefined` let a missing status read look harmless.
        status: vi.fn<() => Promise<WorkflowStatusResult>>(async () => {
            return { status: "running" };
        }),
        terminate: vi.fn<() => Promise<void>>(),
    };
};

/** A `create` double that validates its id the way the real binding does. */
const makeCreate = (): Mock<(options?: { id?: string; params?: Record<string, unknown> }) => Promise<WorkflowInstanceLike>> =>
    vi.fn<(options?: { id?: string; params?: Record<string, unknown> }) => Promise<WorkflowInstanceLike>>(async (options) => {
        if (options?.id !== undefined && engineRejectsInstanceId(options.id)) {
            // The engine's exact rejection: `throw new WorkflowError("Workflow instance has invalid id")`.
            throw new Error("Workflow instance has invalid id");
        }

        return makeInstance(options?.id ?? "auto");
    });

/** A handle whose `status()` already reports a given result — an attached child that has finished. */
const finishedInstance = (id: string, result: WorkflowStatusResult): WorkflowInstanceLike => {
    return { ...makeInstance(id), status: vi.fn<() => Promise<WorkflowStatusResult>>(async () => result) };
};

/** A durable step whose `waitForEvent` never settles — the join a consumed event can never satisfy. */
const makeNeverJoiningStep = (): WorkflowStepLike =>
    ({
        do: vi.fn<(name: string, callback: (context: unknown) => Promise<unknown>) => Promise<unknown>>(async (_name, callback) => callback({})),
        sleep: vi.fn<() => Promise<void>>(),
        sleepUntil: vi.fn<() => Promise<void>>(),
        waitForEvent: vi.fn<() => Promise<never>>(async () => new Promise<never>(() => {})),
    }) as unknown as WorkflowStepLike;

/** A fake durable step: `do` runs its callback inline; `waitForEvent` drains `outcomes` in call order. */
const makeStep = (outcomes: BranchOutcome[] = []): WorkflowStepLike => {
    let waitIndex = 0;

    return {
        do: vi.fn<(name: string, callback: (context: unknown) => Promise<unknown>) => Promise<unknown>>(async (_name, callback) => callback({})),
        sleep: vi.fn<() => Promise<void>>(),
        sleepUntil: vi.fn<() => Promise<void>>(),
        waitForEvent: vi.fn<(name: string, options: { type: string }) => Promise<{ payload: unknown; type: string }>>(async (_name, options) => {
            const payload = outcomes[waitIndex];
            waitIndex += 1;

            return { payload, type: options.type };
        }),
    } as unknown as WorkflowStepLike;
};

/** A fake durable step whose `waitForEvent` either returns a payload or throws per its scripted `waits` (models a join timeout). */
const makeStepWithWaits = (waits: ReadonlyArray<{ payload?: BranchOutcome; throw?: unknown }>): WorkflowStepLike => {
    let waitIndex = 0;

    return {
        do: vi.fn<(name: string, callback: (context: unknown) => Promise<unknown>) => Promise<unknown>>(async (_name, callback) => callback({})),
        sleep: vi.fn<() => Promise<void>>(),
        sleepUntil: vi.fn<() => Promise<void>>(),
        waitForEvent: vi.fn<(name: string, options: { type: string }) => Promise<{ payload: unknown; type: string }>>(async (_name, options) => {
            const wait = waits[waitIndex];
            waitIndex += 1;

            if (wait && "throw" in wait) {
                throw wait.throw;
            }

            return { payload: wait?.payload, type: options.type };
        }),
    } as unknown as WorkflowStepLike;
};

/** A no-op structured logger double whose channels are spies. */
const makeLog = (): { debug: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } => {
    return {
        debug: vi.fn<(...args: unknown[]) => void>(),
        error: vi.fn<(...args: unknown[]) => void>(),
        info: vi.fn<(...args: unknown[]) => void>(),
        warn: vi.fn<(...args: unknown[]) => void>(),
    };
};

/** Build fan-out deps over a single shared binding double, with a deterministic id counter. */
const makeDeps = (
    step: WorkflowStepLike,
): {
    create: Mock<(options?: { id?: string; params?: Record<string, unknown> }) => Promise<WorkflowInstanceLike>>;
    deps: FanOutDeps;
    get: Mock<(id: string) => Promise<WorkflowInstanceLike>>;
} => {
    const create = makeCreate();
    const get = vi.fn<(id: string) => Promise<WorkflowInstanceLike>>(async (id) => makeInstance(id));
    let counter = 0;

    return {
        create,
        deps: {
            env: {},
            instanceId: "parent-1",
            nextChildId: (explicit?: string) => {
                if (explicit !== undefined) {
                    return explicit;
                }

                const id = `parent-1-c${String(counter)}`;
                counter += 1;

                return id;
            },
            parentBinding: "WORKFLOW_PARENT",
            resolveBinding: () => {
                return { create, get };
            },
            step,
        },
        get,
    };
};

describe("branch", () => {
    it("builds a branch descriptor from name + params + options", () => {
        expect.assertions(1);

        expect(branch<{ ok: boolean }>("imageTag", { key: "k" }, { id: "fixed", timeout: "5 minutes" })).toEqual({
            id: "fixed",
            params: { key: "k" },
            timeout: "5 minutes",
            workflow: "imageTag",
        });
    });
});

describe("createParallel", () => {
    it("returns [] for no branches without touching the step API", async () => {
        expect.assertions(2);

        const step = makeStep();
        const { deps } = makeDeps(step);

        await expect(createParallel(deps)([])).resolves.toEqual([]);
        expect(step.do).not.toHaveBeenCalled();
    });

    it("throws (non-retryable) when the branch count exceeds the cap", async () => {
        expect.assertions(2);

        const { deps } = makeDeps(makeStep());
        const branches = Array.from({ length: MAX_BRANCHES + 1 }, (_value, index) => branch(`w${String(index)}`));

        const error = await createParallel(deps)(branches).catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe("NonRetryableError");
    });

    it("spawns each branch with a deterministic id + injected parent marker, returns outputs in order", async () => {
        expect.assertions(4);

        const step = makeStep([okOutcome({ a: 1 }), okOutcome({ b: 2 })]);
        const { create, deps } = makeDeps(step);

        const results = await createParallel(deps)([branch<{ a: number }>("first", { x: 1 }), branch<{ b: number }>("second")]);

        expect(results).toEqual([{ a: 1 }, { b: 2 }]);
        expect(create).toHaveBeenCalledTimes(2);
        // Deterministic ids derived from the parent instance id + declaration index.
        expect(create.mock.calls[0]?.[0]).toStrictEqual({
            id: "parent-1-c0",
            params: { [BRANCH_MARKER_KEY]: { eventType: "lunora:branch:parent-1-c0", index: 0, parentBinding: "WORKFLOW_PARENT", parentId: "parent-1" }, x: 1 },
        });
        expect(create.mock.calls[1]?.[0]).toStrictEqual({
            id: "parent-1-c1",
            params: { [BRANCH_MARKER_KEY]: { eventType: "lunora:branch:parent-1-c1", index: 1, parentBinding: "WORKFLOW_PARENT", parentId: "parent-1" } },
        });
    });

    it("fails fast (non-retryable) when a branch reports an error", async () => {
        expect.assertions(2);

        const step = makeStep([okOutcome({ a: 1 }), errorOutcome(new Error("transcode blew up"))]);
        const { deps } = makeDeps(step);

        const error = await createParallel(deps)([branch("first"), branch("second")]).catch((error_: unknown) => error_);

        expect((error as Error).name).toBe("NonRetryableError");
        expect((error as Error).message).toContain("transcode blew up");
    });

    it("group saga: rolls back completed siblings (reverse order) via compensateWith when a later branch fails", async () => {
        expect.assertions(3);

        // b0 ok, b1 ok, b2 fails → compensate b1 then b0 (reverse declaration order), both declared.
        const step = makeStep([okOutcome({ a: 1 }), okOutcome({ b: 2 }), errorOutcome(new Error("boom"))]);
        const { create, deps } = makeDeps(step);

        const error = await createParallel(deps)([
            branch("first", { x: 1 }, { compensateWith: "undoFirst" }),
            branch("second", undefined, { compensateWith: "undoSecond" }),
            branch("third"),
        ]).catch((error_: unknown) => error_);

        expect((error as Error).name).toBe("NonRetryableError");

        const compensations = create.mock.calls.map((call) => call[0]).filter((options) => String(options?.id).endsWith("-compensate"));

        // Reverse declaration order: c1 (second) is compensated before c0 (first).
        expect(compensations.map((options) => options?.id)).toEqual(["parent-1-c1-compensate", "parent-1-c0-compensate"]);
        // Compensation params carry the completed branch's output + the failing sibling's error.
        expect(compensations[0]?.params).toStrictEqual({ branch: "second", error: { message: "boom", name: "Error" }, index: 1, output: { b: 2 } });
    });

    it("group saga: fails as soon as ANY branch fails, and compensates every sibling that had completed", async () => {
        expect.assertions(4);

        // The documented shape: a fast branch completes, a slow one is still running, and a
        // third fails. Under a declaration-order join the group waited for branch #0 before it
        // could even see #2's failure (not fail-fast), and branch #1 — which finished ahead of
        // #0 — was absent from the completed set, so its rollback never ran.
        const settled: string[] = [];
        const resolvers = new Map<string, (outcome: BranchOutcome) => void>();
        const step = {
            do: vi.fn<(name: string, callback: (context: unknown) => Promise<unknown>) => Promise<unknown>>(async (_name, callback) => callback({})),
            sleep: vi.fn<() => Promise<void>>(),
            sleepUntil: vi.fn<() => Promise<void>>(),
            waitForEvent: vi.fn<(name: string, options: { type: string }) => Promise<{ payload: unknown; type: string }>>(
                async (_name, options) =>
                    await new Promise((resolve) => {
                        resolvers.set(options.type, (payload: BranchOutcome) => {
                            settled.push(options.type);
                            resolve({ payload, type: options.type });
                        });
                    }),
            ),
        } as unknown as WorkflowStepLike;
        const { create, deps } = makeDeps(step);

        const group = createParallel(deps)([
            branch("slow", undefined, { compensateWith: "undoSlow" }),
            branch("fast", undefined, { compensateWith: "undoFast" }),
            branch("doomed"),
        ]).catch((error_: unknown) => error_);

        // Let the spawn phase and all three joins register, then land "fast" (out of declaration
        // order) and fail "doomed". "slow" never reports — the group must not wait on it.
        for (let tick = 0; tick < 50 && resolvers.size < 3; tick += 1) {
            // eslint-disable-next-line no-await-in-loop -- drain the microtask queue until every join has registered
            await Promise.resolve();
        }

        resolvers.get("lunora:branch:parent-1-c1")?.(okOutcome({ b: 2 }));
        resolvers.get("lunora:branch:parent-1-c2")?.(errorOutcome(new Error("boom")));

        const error = await group;

        expect((error as Error).name).toBe("NonRetryableError");
        // Fail-fast: the group rejected without branch #0 ever signalling back.
        expect(settled).toStrictEqual(["lunora:branch:parent-1-c1", "lunora:branch:parent-1-c2"]);

        const compensations = create.mock.calls.map((call) => call[0]).filter((options) => String(options?.id).endsWith("-compensate"));

        // The out-of-order sibling that HAD completed is rolled back; the one still running is not.
        expect(compensations.map((options) => options?.id)).toStrictEqual(["parent-1-c1-compensate"]);
        expect(compensations[0]?.params).toStrictEqual({ branch: "fast", error: { message: "boom", name: "Error" }, index: 1, output: { b: 2 } });
    });

    it("group saga: a group with no compensateWith fails fast with zero compensation spawns", async () => {
        expect.assertions(2);

        const step = makeStep([okOutcome({ a: 1 }), errorOutcome(new Error("boom"))]);
        const { create, deps } = makeDeps(step);

        const error = await createParallel(deps)([branch("first"), branch("second")]).catch((error_: unknown) => error_);

        expect((error as Error).name).toBe("NonRetryableError");
        expect(create.mock.calls.some((call) => String(call[0]?.id).endsWith("-compensate"))).toBe(false);
    });

    it("group saga: skips completed siblings that declared no compensateWith", async () => {
        expect.assertions(2);

        // b0 ok (no compensateWith), b1 ok (compensateWith), b2 fails → only b1 is compensated.
        const step = makeStep([okOutcome({ a: 1 }), okOutcome({ b: 2 }), errorOutcome(new Error("boom"))]);
        const { create, deps } = makeDeps(step);

        await createParallel(deps)([branch("first"), branch("second", undefined, { compensateWith: "undoSecond" }), branch("third")]).catch(() => undefined);

        const compensations = create.mock.calls.map((call) => call[0]).filter((options) => String(options?.id).endsWith("-compensate"));

        expect(compensations).toHaveLength(1);
        expect(compensations[0]?.id).toBe("parent-1-c1-compensate");
    });

    it("honors an explicit branch id over the derived one", async () => {
        expect.assertions(1);

        const step = makeStep([okOutcome(null)]);
        const { create, deps } = makeDeps(step);

        await createParallel(deps)([branch("only", undefined, { id: "my-id" })]);

        expect(create.mock.calls[0]?.[0]?.id).toBe("my-id");
    });

    it("group saga: rolls back completed siblings when a branch join times out (waitForEvent throws)", async () => {
        expect.assertions(3);

        // b0 completes (compensateWith), b1's join throws (its per-branch timeout
        // elapsed because the child was terminated before it could signal) → b0
        // must still be compensated before the group fails.
        const step = makeStepWithWaits([{ payload: okOutcome({ a: 1 }) }, { throw: new Error("waitForEvent timed out") }]);
        const { create, deps } = makeDeps(step);

        const error = await createParallel(deps)([branch("first", { x: 1 }, { compensateWith: "undoFirst" }), branch("second")]).catch(
            (error_: unknown) => error_,
        );

        expect((error as Error).name).toBe("NonRetryableError");
        expect((error as Error).message).toContain("join failed");

        const compensations = create.mock.calls.map((call) => call[0]).filter((options) => String(options?.id).endsWith("-compensate"));

        expect(compensations.map((options) => options?.id)).toEqual(["parent-1-c0-compensate"]);
    });

    it("every instance id it mints — children and compensations — satisfies the engine's id grammar", async () => {
        expect.assertions(2);

        // The regression guard for the whole class: not "the suffix is
        // `-compensate`" but "nothing this package hands to `create` can be
        // rejected by the engine's id check". A future suffix carrying a `:`, a
        // `.`, or a leading `-` fails here rather than in production.
        //
        // The parent here is a SHORT synthetic id, so this case only exercises the
        // character class. The engine checks length first and the ids are
        // caller-controlled up to that ceiling — see the near-ceiling case below.
        const step = makeStep([okOutcome({ a: 1 }), okOutcome({ b: 2 }), errorOutcome(new Error("boom"))]);
        const { create, deps } = makeDeps(step);

        await createParallel(deps)([
            branch("first", { x: 1 }, { compensateWith: "undoFirst" }),
            branch("second", undefined, { compensateWith: "undoSecond" }),
            branch("third"),
        ]).catch(() => undefined);

        const ids = create.mock.calls.map((call) => call[0]?.id);

        expect(ids).toHaveLength(5);
        expect(ids.filter((id) => engineRejectsInstanceId(id))).toStrictEqual([]);
    });

    it("compensates a branch whose own id sits just under the engine's 100-character ceiling", async () => {
        expect.assertions(3);

        // The character class is only half of the engine's check, and it is the
        // half that runs SECOND: the create-time id check rejects on
        // `id.length > 100` before it ever tests the pattern. A branch id is
        // caller-controlled right up to that ceiling — an explicit
        // `branch(…, { id })`, or a derived `<parentId>-c<n>` under a long
        // host-issued parent — so a 90-character branch id plus `-compensate` is
        // 101: the create is rejected, `compensateCompleted` logs and continues,
        // and the completed branch is never rolled back. On a saga that took
        // payment, that unrun rollback is the refund.
        const longId = `b${"0".repeat(89)}`;
        const step = makeStep([okOutcome({ paid: true }), errorOutcome(new Error("boom"))]);
        const { create, deps } = makeDeps(step);
        const log = makeLog();

        await createParallel({ ...deps, log: log as unknown as FanOutDeps["log"] })([
            branch("charge", undefined, { compensateWith: "refund", id: longId }),
            branch("second"),
        ]).catch(() => undefined);

        const compensations = create.mock.calls.map((call) => call[0]?.id).filter((id) => id !== longId && id !== "parent-1-c0");

        expect(compensations).toHaveLength(1);
        expect(compensations.filter((id) => engineRejectsInstanceId(id))).toStrictEqual([]);
        // The rollback actually landed: a swallowed create rejection leaves the
        // group failing exactly as it does here, with only this log to show for it.
        expect(log.error).not.toHaveBeenCalled();
    });

    it("takes an already-finished attached child's status as its outcome instead of waiting for an event that will never come", async () => {
        expect.assertions(3);

        // `instance.restart()` on a parent that already fanned out: the restart wipes
        // the parent's step cache AND its event map, so the spawn steps re-run and
        // re-attach to children that have already sent — and consumed — their
        // completion events. Waiting on those events hibernates until the branch
        // timeout (24 h by default) and then fails the group.
        const step = makeNeverJoiningStep();
        const { create, deps, get } = makeDeps(step);

        create.mockRejectedValue(new Error("instance already exists"));
        get.mockImplementation(async (id: string) => finishedInstance(id, { output: id.endsWith("c0") ? { a: 1 } : { b: 2 }, status: "complete" }));

        await expect(createParallel(deps)([branch("first"), branch("second")])).resolves.toStrictEqual([{ a: 1 }, { b: 2 }]);
        expect(get).toHaveBeenCalledTimes(2);
        // The join never hibernated: the terminal status was already the answer.
        expect(step.waitForEvent).not.toHaveBeenCalled();
    });

    it("bounds an attached child's oversized output instead of returning it into the durable step cache", async () => {
        expect.assertions(2);

        // The attach path returns the child's outcome as the SPAWN STEP's value, so
        // it is persisted by the workflow host exactly like an event payload is
        // sent: miniflare's engine answers a step output over 1 MiB with
        // `Step … output is too large`, and production Workflows caps it the same
        // way. Only the event path was bounded, so a large-output child taken over
        // by the attach path failed the step (and burned its retries) instead of
        // failing the branch with a message that names the byte count.
        const step = makeNeverJoiningStep();
        const { create, deps, get } = makeDeps(step);

        create.mockRejectedValue(new Error("instance already exists"));
        get.mockImplementation(async (id: string) => finishedInstance(id, { output: { blob: "x".repeat(1_048_576) }, status: "complete" }));

        const settled = await createParallel(deps)([branch("first")]).then(
            () => "resolved with the blob",
            (error: unknown) => (error as Error).message,
        );
        const spawned: unknown = await (step.do as ReturnType<typeof vi.fn>).mock.results[0]?.value;

        expect(settled).toContain("1048576-byte");
        // What the step returns is what the host persists — bounded, not the blob.
        expect(JSON.stringify(spawned).length).toBeLessThan(1024);
    });

    it("fails the group from an attached child that already errored, without waiting on its consumed event", async () => {
        expect.assertions(2);

        const step = makeNeverJoiningStep();
        const { create, deps, get } = makeDeps(step);

        create.mockRejectedValue(new Error("instance already exists"));
        get.mockImplementation(async (id: string) => finishedInstance(id, { error: { message: "child blew up", name: "Error" }, status: "errored" }));

        const error = await createParallel(deps)([branch("first")]).catch((error_: unknown) => error_);

        expect((error as Error).name).toBe("NonRetryableError");
        expect((error as Error).message).toContain("child blew up");
    });

    it("still joins on the event when the attached child is still running", async () => {
        expect.assertions(2);

        // The ordinary idempotency case — a spawn step that failed *after* its
        // create landed — must keep waiting for the child's signal.
        const step = makeStep([okOutcome({ a: 1 })]);
        const { create, deps, get } = makeDeps(step);

        create.mockRejectedValue(new Error("instance already exists"));
        get.mockImplementation(async (id: string) => finishedInstance(id, { status: "running" }));

        await expect(createParallel(deps)([branch("first")])).resolves.toStrictEqual([{ a: 1 }]);
        expect(step.waitForEvent).toHaveBeenCalledTimes(1);
    });

    it("fans out from a host-issued parent id the Cloudflare engine would not accept", async () => {
        expect.assertions(2);

        // `@lunora/platform-node` runs this same orchestrator, and its run ids come
        // from `@visulima/workflow`'s `generateRunId` — `<definitionId>:<uuid>`,
        // which no Cloudflare grammar allows and which that host does not let us
        // override. The parent id is the HOST's; only the suffix is ours. Refusing a
        // derived id on Cloudflare's grammar took `ctx.spawn`/`ctx.parallel` out
        // entirely on every non-Cloudflare host.
        const hostId = "parent:94c2d980-6116-430f-8581-d5beb8de975c";
        const step = makeStep([okOutcome({ a: 1 }), errorOutcome(new Error("boom"))]);
        // NOT `makeCreate()`: this models a different engine, not a laxer double.
        // The Node host's `create({ id })` aliases any string to the run it minted.
        const create = vi.fn<(options?: { id?: string; params?: Record<string, unknown> }) => Promise<WorkflowInstanceLike>>(async (options) =>
            makeInstance(options?.id ?? "auto"),
        );
        const { deps } = makeDeps(step);
        let counter = 0;

        const hostDeps: FanOutDeps = {
            ...deps,
            instanceId: hostId,
            nextChildId: (explicit?: string) => {
                if (explicit !== undefined) {
                    return explicit;
                }

                const id = `${hostId}-c${String(counter)}`;
                counter += 1;

                return id;
            },
            // This host's `create` aliases any string, exactly as the Node host does.
            resolveBinding: () => {
                return { create, get: async (id: string) => makeInstance(id) };
            },
        };

        const error = await createParallel(hostDeps)([branch("first", undefined, { compensateWith: "undoFirst" }), branch("second")]).catch(
            (error_: unknown) => error_,
        );

        // The group fails on its branch, not on its ids — and the rollback still ran.
        expect((error as Error).message).toContain('branch "second"');
        expect(create.mock.calls.map((call) => call[0]?.id)).toStrictEqual([`${hostId}-c0`, `${hostId}-c1`, `${hostId}-c0-compensate`]);
    });

    it("throws (non-retryable) on duplicate branch ids without spawning anything", async () => {
        expect.assertions(3);

        const { create, deps } = makeDeps(makeStep());

        const error = await createParallel(deps)([branch("first", undefined, { id: "dup" }), branch("second", undefined, { id: "dup" })]).catch(
            (error_: unknown) => error_,
        );

        expect((error as Error).name).toBe("NonRetryableError");
        expect((error as Error).message).toContain("duplicate branch id");
        // No branch is spawned — the collision is caught before any create.
        expect(create).not.toHaveBeenCalled();
    });

    it("group saga: a failed compensation (unresolvable binding) does not strand the other siblings' rollbacks", async () => {
        expect.assertions(2);

        // b0 ok (compensateWith undoFirst), b1 ok (compensateWith undoSecond), b2 fails.
        // Reverse order compensates undoSecond (c1) first — its binding is unresolvable;
        // undoFirst (c0) must still be compensated, and the failure is logged.
        const step = makeStep([okOutcome({ a: 1 }), okOutcome({ b: 2 }), errorOutcome(new Error("boom"))]);
        const create = makeCreate();
        const get = vi.fn<(id: string) => Promise<WorkflowInstanceLike>>(async (id) => makeInstance(id));
        const log = makeLog();
        let counter = 0;
        const deps: FanOutDeps = {
            env: {},
            instanceId: "parent-1",
            log: log as unknown as FanOutDeps["log"],
            nextChildId: (explicit?: string) => {
                if (explicit !== undefined) {
                    return explicit;
                }

                const id = `parent-1-c${String(counter)}`;
                counter += 1;

                return id;
            },
            parentBinding: "WORKFLOW_PARENT",
            resolveBinding: (workflow: string) => {
                if (workflow === "undoSecond") {
                    throw new Error("no Workflow binding for undoSecond");
                }

                return { create, get };
            },
            step,
        };

        await createParallel(deps)([
            branch("first", undefined, { compensateWith: "undoFirst" }),
            branch("second", undefined, { compensateWith: "undoSecond" }),
            branch("third"),
        ]).catch(() => undefined);

        const compensations = create.mock.calls.map((call) => call[0]).filter((options) => String(options?.id).endsWith("-compensate"));

        expect(compensations.map((options) => options?.id)).toEqual(["parent-1-c0-compensate"]);
        expect(log.error).toHaveBeenCalledTimes(1);
    });
});

describe("createSpawn", () => {
    it("creates the child once (via step.do) and returns a live handle", async () => {
        expect.assertions(3);

        const step = makeStep();
        const { create, deps, get } = makeDeps(step);

        const instance = await createSpawn(deps)("child", { y: 2 });

        expect(create).toHaveBeenCalledWith({ id: "parent-1-c0", params: { y: 2 } });
        expect(get).toHaveBeenCalledWith("parent-1-c0");
        expect(instance.id).toBe("parent-1-c0");
    });

    it("rejects a caller-supplied reserved branch marker without touching the step API", async () => {
        expect.assertions(5);

        const step = makeStep();
        const { create, deps } = makeDeps(step);

        const forged = { eventType: "lunora:branch:victim", index: 0, parentBinding: "WORKFLOW_PARENT", parentId: "victim" };

        const error = await createSpawn(deps)("child", { [BRANCH_MARKER_KEY]: forged }).catch((error_: unknown) => error_);

        expect((error as Error).name).toBe("LunoraError");
        expect((error as { code?: string }).code).toBe("BAD_REQUEST");
        // Shared across all five create-surface rejections (plan 262 review).
        expect((error as Error).message).toContain(BRANCH_MARKER_REJECTION);
        expect(step.do).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
    });
});

describe("branch marker helpers", () => {
    it("extracts a well-formed marker and ignores anything else", () => {
        expect.assertions(3);

        const marker = { eventType: "lunora:branch:x", index: 0, parentBinding: "WORKFLOW_PARENT", parentId: "p1" };

        expect(extractBranchMarker({ [BRANCH_MARKER_KEY]: marker, other: 1 })).toEqual(marker);
        expect(extractBranchMarker({ other: 1 })).toBeUndefined();
        expect(extractBranchMarker({ [BRANCH_MARKER_KEY]: { eventType: "x" } })).toBeUndefined();
    });

    it("rejects a shape-valid marker whose parentBinding is not a WORKFLOW_ binding", () => {
        expect.assertions(1);

        // Attacker-chosen env key that is not a Workflow binding must not be dereferenced.
        const forged = { eventType: "lunora:branch:x", index: 0, parentBinding: "SECRETS", parentId: "p1" };

        expect(extractBranchMarker({ [BRANCH_MARKER_KEY]: forged })).toBeUndefined();
    });

    it("rejects a shape-valid marker whose eventType is outside the branch namespace", () => {
        expect.assertions(1);

        // Attacker-chosen event type outside `lunora:branch:*` must not be sent.
        const forged = { eventType: "attacker:event", index: 0, parentBinding: "WORKFLOW_PARENT", parentId: "p1" };

        expect(extractBranchMarker({ [BRANCH_MARKER_KEY]: forged })).toBeUndefined();
    });

    it("strips the marker from a child's params", () => {
        expect.assertions(2);

        expect(stripBranchMarker({ [BRANCH_MARKER_KEY]: { index: 0 }, keep: true })).toEqual({ keep: true });
        expect(stripBranchMarker("scalar")).toBe("scalar");
    });

    it("hasBranchMarker (shared/branch-marker.ts): detects a top-level key, ignores a nested one and non-objects", () => {
        expect.assertions(5);

        expect(hasBranchMarker({ [BRANCH_MARKER_KEY]: {}, other: 1 })).toBe(true);
        // A nested marker is inert — only the top-level own-property is checked.
        expect(hasBranchMarker({ nested: { [BRANCH_MARKER_KEY]: {} } })).toBe(false);
        expect(hasBranchMarker({ other: 1 })).toBe(false);
        expect(hasBranchMarker("scalar")).toBe(false);
        expect(hasBranchMarker(undefined)).toBe(false);
    });
});

describe("spawn create-or-attach (a step body that failed after `create` landed)", () => {
    /** A `step.do` double that RETRIES its callback the way Cloudflare does — a completed step is memoized, a failed one is re-run. */
    const retryingStep = (): WorkflowStepLike => {
        const memoized = new Map<string, unknown>();

        return {
            do: vi.fn<(name: string, callback: (context: unknown) => Promise<unknown>) => Promise<unknown>>(async (name, callback) => {
                if (memoized.has(name)) {
                    return memoized.get(name);
                }

                let lastError: unknown;

                for (let attempt = 1; attempt <= 3; attempt += 1) {
                    try {
                        // eslint-disable-next-line no-await-in-loop -- the point of the double is a serial retry loop
                        const value = await callback({ attempt });

                        memoized.set(name, value);

                        return value;
                    } catch (error: unknown) {
                        lastError = error;
                    }
                }

                throw lastError;
            }),
            sleep: vi.fn<() => Promise<void>>(),
            sleepUntil: vi.fn<() => Promise<void>>(),
            waitForEvent: vi.fn<(name: string, options: { type: string }) => Promise<{ payload: unknown; type: string }>>(async (_name, options) => {
                return { payload: { status: "ok", value: 1 }, type: options.type };
            }),
        } as unknown as WorkflowStepLike;
    };

    /** A binding whose FIRST `create` applies and then throws (transport died after the side effect), and which rejects a repeated id. */
    const flakyBinding = (): { created: string[]; resolveBinding: FanOutDeps["resolveBinding"] } => {
        const created: string[] = [];
        let failedOnce = false;

        const create = vi.fn<(options?: { id?: string; params?: Record<string, unknown> }) => Promise<WorkflowInstanceLike>>(async (options) => {
            const id = options?.id ?? "auto";

            if (created.includes(id)) {
                throw new Error(`instance.create: instance with id "${id}" already exists`);
            }

            created.push(id);

            if (!failedOnce) {
                failedOnce = true;

                throw new Error("RPC transport closed after create was applied");
            }

            return makeInstance(id);
        });
        const read = vi.fn<(id: string) => Promise<WorkflowInstanceLike>>(async (id) => makeInstance(id));

        return {
            created,
            resolveBinding: () => {
                return { create, get: read };
            },
        };
    };

    it("ctx.spawn returns the existing child instead of failing on 'already exists'", async () => {
        expect.assertions(2);

        const binding = flakyBinding();
        const { deps } = makeDeps(retryingStep());

        const instance = await createSpawn({ ...deps, resolveBinding: binding.resolveBinding })("child");

        expect(instance.id).toBe("parent-1-c0");
        // Exactly one child ran — the retry attached to it rather than starting a second.
        expect(binding.created).toEqual(["parent-1-c0"]);
    });

    it("ctx.parallel joins the branch whose create had already landed", async () => {
        expect.assertions(2);

        const binding = flakyBinding();
        const { deps } = makeDeps(retryingStep());

        await expect(createParallel({ ...deps, resolveBinding: binding.resolveBinding })([branch("child")])).resolves.toEqual([1]);
        expect(binding.created).toEqual(["parent-1-c0"]);
    });

    it("a non-duplicate create rejection still fails the spawn", async () => {
        expect.assertions(1);

        const create = vi.fn<() => Promise<WorkflowInstanceLike>>(async () => {
            throw new Error("Workflows service unavailable");
        });
        const read = vi.fn<(id: string) => Promise<WorkflowInstanceLike>>(async (id) => makeInstance(id));
        const { deps } = makeDeps(retryingStep());

        await expect(
            createSpawn({
                ...deps,
                resolveBinding: () => {
                    return { create, get: read };
                },
            })("child"),
        ).rejects.toThrow("Workflows service unavailable");
    });
});

describe("signalBranchParent", () => {
    const marker = { eventType: "lunora:branch:c0", index: 0, parentBinding: "WORKFLOW_PARENT", parentId: "parent-1" };

    it("sends the outcome event to the parent instance", async () => {
        expect.assertions(2);

        const parent = makeInstance("parent-1");
        const env = { WORKFLOW_PARENT: { get: vi.fn<(id: string) => Promise<WorkflowInstanceLike>>(async () => parent) } };

        await signalBranchParent({ env, step: makeStep() }, marker, okOutcome({ done: true }));

        expect(env.WORKFLOW_PARENT.get).toHaveBeenCalledWith("parent-1");
        expect(parent.sendEvent).toHaveBeenCalledWith({ payload: { status: "ok", value: { done: true } }, type: "lunora:branch:c0" });
    });

    it("replaces an over-the-limit outcome with a bounded failure the parent can actually receive", async () => {
        expect.assertions(2);

        const parent = makeInstance("parent-1");
        const env = { WORKFLOW_PARENT: { get: vi.fn<(id: string) => Promise<WorkflowInstanceLike>>(async () => parent) } };

        // Just over Cloudflare's 1 MiB event-payload cap. Sent verbatim it rejects on
        // every retry, so the parent hibernated to its join timeout (24 h by default)
        // and then compensated a branch that had actually succeeded.
        await signalBranchParent({ env, step: makeStep() }, marker, okOutcome({ blob: "x".repeat(1_048_576) }));

        const sent = (parent.sendEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { payload: BranchOutcome };

        expect(sent.payload).toStrictEqual({
            error: {
                message: expect.stringContaining("over Cloudflare's 1048576-byte event payload limit"),
                name: "BranchOutputTooLarge",
            },
            status: "error",
        });
        expect(JSON.stringify(sent.payload).length).toBeLessThan(1024);
    });

    it("replaces an unserialisable outcome with a bounded failure instead of stranding the parent", async () => {
        expect.assertions(2);

        const parent = makeInstance("parent-1");
        const env = { WORKFLOW_PARENT: { get: vi.fn<(id: string) => Promise<WorkflowInstanceLike>>(async () => parent) } };

        // A cyclic child output: `JSON.stringify` throws inside the size check, and
        // `signalBranchParentSafe` only logs — so the parent got no terminal event
        // and hibernated to its join timeout (24 h by default) on a branch that had
        // actually finished.
        const cyclic: Record<string, unknown> = {};

        cyclic.self = cyclic;

        await signalBranchParent({ env, step: makeStep() }, marker, okOutcome(cyclic));

        const sent = (parent.sendEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { payload: BranchOutcome };

        expect(sent.payload).toStrictEqual({
            error: {
                message: expect.stringContaining("cannot be serialised"),
                name: "BranchOutputUnserializable",
            },
            status: "error",
        });
        expect(JSON.stringify(sent.payload).length).toBeLessThan(1024);
    });

    it("still reports the outcome when the serialization failure cannot be stringified", async () => {
        expect.assertions(4);

        const parent = makeInstance("parent-1");
        const env = { WORKFLOW_PARENT: { get: vi.fn<(id: string) => Promise<WorkflowInstanceLike>>(async () => parent) } };

        // A branch handler's own `toJSON` decides what `JSON.stringify` throws, so
        // the thrown value is as arbitrary as any other user value. Two shapes
        // defeated the naive `instanceof Error ? .message : String()`: an `Error`
        // carrying a non-string `message` (`.slice` is not a function) and a
        // null-prototype object (`String()` throws). Either way the diagnostic
        // threw INSIDE the guard, `signalBranchParentSafe` swallowed it, and the
        // parent hibernated to its 24 h join timeout on a finished branch.
        const numericMessage = Object.assign(new Error("ignored"), { message: 42 });

        await signalBranchParent(
            { env, step: makeStep() },
            marker,
            okOutcome({
                toJSON: () => {
                    throw numericMessage;
                },
            }),
        );

        await signalBranchParent(
            { env, step: makeStep() },
            marker,
            okOutcome({
                toJSON: () => {
                    // No prototype, so no `toString`: `String(value)` throws
                    // "Cannot convert object to primitive value".
                    throw Object.create(null) as unknown;
                },
            }),
        );

        const sends = (parent.sendEvent as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as { payload: BranchOutcome });

        expect(sends).toHaveLength(2);

        for (const sent of sends) {
            expect(sent.payload).toStrictEqual({
                error: {
                    message: expect.stringContaining("cannot be serialised"),
                    name: "BranchOutputUnserializable",
                },
                status: "error",
            });
        }

        expect(JSON.stringify(sends[1]?.payload).length).toBeLessThan(1024);
    });

    it("is a no-op when the parent binding is absent (parent falls back to its timeout)", async () => {
        expect.assertions(1);

        const step = makeStep();

        await signalBranchParent({ env: {}, step }, marker, okOutcome(null));

        expect(step.do).not.toHaveBeenCalled();
    });
});

describe("signalBranchParentSafe", () => {
    const marker = { eventType: "lunora:branch:c0", index: 0, parentBinding: "WORKFLOW_PARENT", parentId: "parent-1" };

    it("swallows a rejecting parent send (terminated parent) and logs it instead of throwing", async () => {
        expect.assertions(2);

        // Parent binding present but `sendEvent` rejects → `signalBranchParent` throws;
        // the safe wrapper must resolve so it can never mask the handler's real error
        // nor mark a completed child as errored.
        const parent = makeInstance("parent-1");

        (parent.sendEvent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("parent terminated"));

        const env = { WORKFLOW_PARENT: { get: vi.fn<(id: string) => Promise<WorkflowInstanceLike>>(async () => parent) } };
        const log = makeLog();

        await expect(
            signalBranchParentSafe({ env, log: log as unknown as FanOutDeps["log"], step: makeStep() }, marker, okOutcome(null)),
        ).resolves.toBeUndefined();
        expect(log.error).toHaveBeenCalledTimes(1);
    });
});

describe("outcome builders", () => {
    it("builds ok and error outcomes", () => {
        expect.assertions(2);

        expect(okOutcome({ v: 1 })).toEqual({ status: "ok", value: { v: 1 } });
        expect(errorOutcome(new TypeError("nope"))).toEqual({ error: { message: "nope", name: "TypeError" }, status: "error" });
    });
});
