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
import type { WorkflowInstanceLike, WorkflowStepLike } from "../src/types";

/** A fake instance handle — only the methods the fan-out path touches are real. */
const makeInstance = (id: string): WorkflowInstanceLike => {
    return {
        id,
        pause: vi.fn<() => Promise<void>>(),
        restart: vi.fn<() => Promise<void>>(),
        resume: vi.fn<() => Promise<void>>(),
        sendEvent: vi.fn<(event: { payload: unknown; type: string }) => Promise<void>>(async () => undefined),
        status: vi.fn<() => Promise<never>>(),
        terminate: vi.fn<() => Promise<void>>(),
    };
};

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
const makeDeps = (step: WorkflowStepLike): { create: ReturnType<typeof vi.fn>; deps: FanOutDeps; get: ReturnType<typeof vi.fn> } => {
    const create = vi.fn<(options?: { id?: string }) => Promise<WorkflowInstanceLike>>(async (options) => makeInstance(options?.id ?? "auto"));
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

        const compensations = create.mock.calls.map((call) => call[0]).filter((options) => String(options?.id).endsWith(":compensate"));

        // Reverse declaration order: c1 (second) is compensated before c0 (first).
        expect(compensations.map((options) => options?.id)).toEqual(["parent-1-c1:compensate", "parent-1-c0:compensate"]);
        // Compensation params carry the completed branch's output + the failing sibling's error.
        expect(compensations[0]?.params).toStrictEqual({ branch: "second", error: { message: "boom", name: "Error" }, index: 1, output: { b: 2 } });
    });

    it("group saga: a group with no compensateWith fails fast with zero compensation spawns", async () => {
        expect.assertions(2);

        const step = makeStep([okOutcome({ a: 1 }), errorOutcome(new Error("boom"))]);
        const { create, deps } = makeDeps(step);

        const error = await createParallel(deps)([branch("first"), branch("second")]).catch((error_: unknown) => error_);

        expect((error as Error).name).toBe("NonRetryableError");
        expect(create.mock.calls.some((call) => String(call[0]?.id).endsWith(":compensate"))).toBe(false);
    });

    it("group saga: skips completed siblings that declared no compensateWith", async () => {
        expect.assertions(2);

        // b0 ok (no compensateWith), b1 ok (compensateWith), b2 fails → only b1 is compensated.
        const step = makeStep([okOutcome({ a: 1 }), okOutcome({ b: 2 }), errorOutcome(new Error("boom"))]);
        const { create, deps } = makeDeps(step);

        await createParallel(deps)([branch("first"), branch("second", undefined, { compensateWith: "undoSecond" }), branch("third")]).catch(() => undefined);

        const compensations = create.mock.calls.map((call) => call[0]).filter((options) => String(options?.id).endsWith(":compensate"));

        expect(compensations).toHaveLength(1);
        expect(compensations[0]?.id).toBe("parent-1-c1:compensate");
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

        const compensations = create.mock.calls.map((call) => call[0]).filter((options) => String(options?.id).endsWith(":compensate"));

        expect(compensations.map((options) => options?.id)).toEqual(["parent-1-c0:compensate"]);
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
        const create = vi.fn<(options?: { id?: string }) => Promise<WorkflowInstanceLike>>(async (options) => makeInstance(options?.id ?? "auto"));
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

        const compensations = create.mock.calls.map((call) => call[0]).filter((options) => String(options?.id).endsWith(":compensate"));

        expect(compensations.map((options) => options?.id)).toEqual(["parent-1-c0:compensate"]);
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

        const create = vi.fn<(options?: { id?: string }) => Promise<WorkflowInstanceLike>>(async (options) => {
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
