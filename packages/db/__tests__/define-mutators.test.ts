import { describe, expect, expectTypeOf, it, vi } from "vitest";

// Capture every `createTransaction` config and run `mutate` synchronously, so the
// test can drive the optimistic body + inspect the `mutationFn` without standing
// up TanStack's full transaction lifecycle.
const { configs } = vi.hoisted(() => {
    return { configs: [] as { metadata?: Record<string, unknown>; mutationFn: () => Promise<unknown> }[] };
});

vi.mock(
    import("@tanstack/db"),
    () =>
        ({
            // The real `createTransaction` is generic with a rich `Transaction` return; the
            // test only needs `mutate` + the captured config, so the whole module shape is
            // cast away (`as unknown as`) rather than reconstructed.
            createTransaction: (config: { metadata?: Record<string, unknown>; mutationFn: () => Promise<unknown> }) => {
                // `autoCommit` transactions settle `isPersisted` with the outcome of
                // `mutationFn`. The suite drives `mutationFn` by hand, so the captured
                // one is wrapped to settle this deferred — enough fidelity for the
                // `onWriteRejected` path, which reads `isPersisted.promise`.
                let settle: (error?: Error) => void = (_error?: Error) => undefined;
                const promise = new Promise<void>((resolve, reject) => {
                    settle = (error?: Error) => {
                        if (error === undefined) {
                            resolve();
                        } else {
                            reject(error);
                        }
                    };
                });

                // The fake harness is not the code under test: a test that never
                // observes a rejected `isPersisted` must not fail the run with an
                // unhandled rejection.
                promise.catch(() => undefined);

                configs.push({
                    ...config,
                    mutationFn: async () => {
                        try {
                            const result = await config.mutationFn();

                            settle();

                            return result;
                        } catch (error) {
                            settle(error instanceof Error ? error : new Error("mutationFn rejected with a non-Error"));

                            throw error;
                        }
                    },
                });

                return {
                    isPersisted: { promise },
                    mutate: (callback: () => void) => {
                        callback();
                    },
                };
            },
        }) as unknown as typeof import("@tanstack/db"),
);

// eslint-disable-next-line import/first -- must follow the vi.mock above
import { readFileSync } from "node:fs";
// eslint-disable-next-line import/first -- must follow the vi.mock above
import { createRequire } from "node:module";
// eslint-disable-next-line import/first -- must follow the vi.mock above
import { dirname, join } from "node:path";

// eslint-disable-next-line import/first -- must follow the vi.mock above
import type { FunctionReference } from "@lunora/client";
// eslint-disable-next-line import/first -- must follow the vi.mock above
import type { Collection } from "@tanstack/db";

// eslint-disable-next-line import/first -- must follow the vi.mock above
import { createCheckpointRegistry, getShardCheckpoints } from "../src/collection-options";
// eslint-disable-next-line import/first -- must follow the vi.mock above
import type { MutatorRejectedEvent } from "../src/define-mutators";
// eslint-disable-next-line import/first -- must follow the vi.mock above
import { bindMutators, defineMutator, DIRECT_TRANSACTION_METADATA_KEY, initMutators } from "../src/define-mutators";
// eslint-disable-next-line import/first -- must follow the vi.mock above
import type { Row } from "../src/internals";

/** The `serverRef` guidance thrown by `defineMutator` for any unusable reference. */
const MUTATOR_REF_ERROR_RE = /must be a generated mutator reference/;

/** A checkpoint registry stub that records what the runtime asked of it. */
const stubCheckpoints = () => {
    const acknowledged: number[] = [];
    const awaited: number[] = [];

    return {
        acknowledged,
        awaited,
        registry: {
            acknowledge: ({ mutationId }: { mutationId?: number }) => {
                if (mutationId !== undefined) {
                    acknowledged.push(mutationId);
                }
            },
            awaitCheckpoint: async () => undefined,
            awaitMutationId: async (id: number) => {
                awaited.push(id);
            },
            dispose: () => undefined,
            resolve: () => undefined,
            stats: () => {
                return { fallbacks: 0, pendingCheckpointWaiters: 0, pendingMutationWaiters: 0 };
            },
        },
    };
};

/** Drain the microtask queue deterministically — enough for a settled promise's handlers to run. */
const flush = async (): Promise<void> => {
    for (let index = 0; index < 8; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- draining the microtask queue deterministically
        await Promise.resolve();
    }
};

/** The reissue-exhaustion error message the runtime throws after `maxReissues`. */
const REISSUE_EXHAUSTED = /could not claim a fresh client sequence/;

/** A mock collection that records the optimistic ops an `apply` body issues. */
const mockCollection = () => {
    const inserted: unknown[] = [];

    return { collection: { insert: (row: unknown) => inserted.push(row) } as never, inserted };
};

describe(bindMutators, () => {
    it("runs the optimistic body and pushes the server write under a monotonic clientSeq", async () => {
        configs.length = 0;
        const callMutator = vi.fn<
            (path: string, args: Record<string, unknown>, options: { clientSeq: number; shardKey?: string }) => Promise<{ applied: boolean; result: unknown }>
        >(async () => {
            return { applied: true, result: "ok" };
        });
        const client = { callMutator, confirmedMutationWatermark: () => 0 } as never;
        const { collection, inserted } = mockCollection();

        const mutators = {
            send: defineMutator<{ text: string }>({
                apply: (context, args) => {
                    (context.collections.messages as unknown as { insert: (row: unknown) => void }).insert({ _id: "tmp", text: args.text });
                },
                serverRef: "messages:send",
            }),
        };

        const bound = bindMutators(client, { collections: { messages: collection }, shardKey: "room-1" }, mutators);

        bound.send({ text: "first" });

        // The optimistic body wrote the predicted row.
        expect(inserted).toStrictEqual([{ _id: "tmp", text: "first" }]);
        // The transaction carries the mutator ref (the sequence is claimed inside
        // the serialized push, not at dispatch) plus TanStack's direct-transaction
        // marker, without which the predicted row is discarded as stale on completion.
        expect(configs[0]?.metadata).toStrictEqual({ [DIRECT_TRANSACTION_METADATA_KEY]: true, serverRef: "messages:send" });

        // Driving the mutationFn pushes the authoritative write with clientSeq 1.
        await configs[0]?.mutationFn();

        expect(callMutator).toHaveBeenCalledWith("messages:send", { text: "first" }, { clientSeq: 1, shardKey: "room-1" });

        // A second call increments the per-client sequence.
        bound.send({ text: "second" });
        await configs[1]?.mutationFn();

        expect(callMutator).toHaveBeenLastCalledWith("messages:send", { text: "second" }, { clientSeq: 2, shardKey: "room-1" });
    });

    it("acknowledges then awaits the watermark on the checkpoint registry", async () => {
        configs.length = 0;
        const client = {
            callMutator: async () => {
                return { applied: true, result: "ok" };
            },
            confirmedMutationWatermark: () => 0,
        } as never;
        const { collection } = mockCollection();
        const { acknowledged, awaited, registry } = stubCheckpoints();

        const bound = bindMutators(
            client,
            { checkpoints: registry, collections: { messages: collection } },
            {
                touch: defineMutator({ apply: () => undefined, serverRef: "messages:touch" }),
            },
        );

        bound.touch({});
        await configs[0]?.mutationFn();

        // `acknowledge` first (the write is durable — arm the fallback), then hold the
        // overlay on `awaitMutationId`. Reversing the two would make a dropped poke
        // hang forever, since the fallback would never be armed.
        expect(acknowledged).toStrictEqual([1]);
        expect(awaited).toStrictEqual([1]);
    });

    it("does not gate on a derived registry that has no sync source attached", async () => {
        configs.length = 0;
        const client = {
            callMutator: async () => {
                return { applied: true, result: "ok" };
            },
            confirmedMutationWatermark: () => 0,
        } as never;
        const { collection } = mockCollection();

        // No `lunoraCollectionOptions` call for this client, so nothing would ever
        // advance the shard registry. Gating here would stall every write for the
        // whole fallback window — worse than not waiting at all.
        const registry = getShardCheckpoints(client, "unattached-shard");
        const awaitMutationId = vi.spyOn(registry, "awaitMutationId");

        const bound = bindMutators(
            client,
            { collections: { messages: collection }, shardKey: "unattached-shard" },
            { touch: defineMutator({ apply: () => undefined, serverRef: "messages:touch" }) },
        );

        bound.touch({});
        await configs[0]?.mutationFn();

        expect(awaitMutationId).not.toHaveBeenCalled();
    });

    it("skips the overlay gate entirely when checkpoints are disabled", async () => {
        configs.length = 0;
        const client = {
            callMutator: async () => {
                return { applied: true, result: "ok" };
            },
            confirmedMutationWatermark: () => 0,
        } as never;
        const { collection } = mockCollection();

        const bound = bindMutators(
            client,
            { checkpoints: false, collections: { messages: collection } },
            { touch: defineMutator({ apply: () => undefined, serverRef: "messages:touch" }) },
        );

        bound.touch({});

        // Resolves without any watermark ever arriving.
        await expect(configs[0]?.mutationFn()).resolves.toBeUndefined();
    });

    it("releases the overlay via the fallback when the confirming sync frame never arrives", async () => {
        configs.length = 0;
        vi.useFakeTimers();

        try {
            const client = {
                callMutator: async () => {
                    return { applied: true, result: "ok" };
                },
                confirmedMutationWatermark: () => 0,
            } as never;
            const { collection } = mockCollection();
            const fallbacks: unknown[] = [];
            const checkpoints = createCheckpointRegistry({ fallbackMs: 3000, onFallback: (event) => fallbacks.push(event) });

            const bound = bindMutators(
                client,
                { checkpoints, collections: { messages: collection } },
                { touch: defineMutator({ apply: () => undefined, serverRef: "messages:touch" }) },
            );

            bound.touch({});

            const settled = configs[0]?.mutationFn();
            let done = false;

            void settled?.then(() => {
                done = true;
            });

            // The push is acked but no poke echoes the watermark: still held.
            await vi.advanceTimersByTimeAsync(2000);

            expect(done).toBe(false);

            // Past the fallback window the overlay is released and reported, instead
            // of `isPersisted` hanging forever on a dropped poke.
            await vi.advanceTimersByTimeAsync(1500);
            await settled;

            expect(done).toBe(true);
            expect(fallbacks).toStrictEqual([{ kind: "mutationId", waitedMs: 3000, watermark: 1 }]);
            expect(checkpoints.stats().fallbacks).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("accepts a generated mutator reference and resolves it to the dispatch path", async () => {
        configs.length = 0;
        const callMutator = vi.fn<
            (path: string, args: Record<string, unknown>, options: { clientSeq: number; shardKey?: string }) => Promise<{ applied: boolean; result: unknown }>
        >(async () => {
            return { applied: true, result: "ok" };
        });
        const client = { callMutator, confirmedMutationWatermark: () => 0 } as never;
        const { collection } = mockCollection();

        // Shape of a codegen `api.mutators.*` entry — the phantom marker is type-only,
        // so at runtime only `__lunoraRef` exists. Binding the path this way makes a
        // rename a type error instead of a mutation that fails at runtime.
        const reference = { __lunoraRef: "mutators:sendMessage" } as const;

        const bound = bindMutators(
            client,
            { checkpoints: false, collections: { messages: collection } },
            { send: defineMutator({ apply: () => undefined, serverRef: reference }) },
        );

        bound.send({});
        await configs[0]?.mutationFn();

        expect(callMutator).toHaveBeenCalledWith("mutators:sendMessage", {}, { clientSeq: 1, shardKey: undefined });
        expect(configs[0]?.metadata).toStrictEqual({ [DIRECT_TRANSACTION_METADATA_KEY]: true, serverRef: "mutators:sendMessage" });
    });

    it("infers the client body's args from a typed api.mutators reference", async () => {
        configs.length = 0;

        const callMutator = vi.fn<
            (path: string, args: Record<string, unknown>, options: { clientSeq: number; shardKey?: string }) => Promise<{ applied: boolean; result: unknown }>
        >(async () => {
            return { applied: true, result: "ok" };
        });
        const client = { callMutator, confirmedMutationWatermark: () => 0 } as never;
        const { collection } = mockCollection();

        // Exactly what `@lunora/codegen` emits for a `defineMutator` in
        // `lunora/mutators.ts`: `api.mutators.sendMessage` typed as a
        // `FunctionReference<"mutation", Args, Return>`. The phantom is type-only, so
        // the runtime value is still just `__lunoraRef`.
        const api = { mutators: { sendMessage: { __lunoraRef: "mutators:sendMessage" } } } as unknown as {
            mutators: { sendMessage: FunctionReference<"mutation", { channelId: string; text: string }, { id: string }> };
        };

        const send = defineMutator({
            apply: (_context, args) => {
                // Inferred from the server mutator's validators — NOT restated here.
                expectTypeOf(args).toEqualTypeOf<{ channelId: string; text: string }>();
            },
            serverRef: api.mutators.sendMessage,
        });

        const bound = bindMutators(client, { checkpoints: false, collections: { messages: collection } }, { send });

        expectTypeOf(bound.send).parameters.toEqualTypeOf<[{ channelId: string; text: string }]>();

        bound.send({ channelId: "c1", text: "hi" });
        await configs[0]?.mutationFn();

        expect(callMutator).toHaveBeenCalledWith("mutators:sendMessage", { channelId: "c1", text: "hi" }, { clientSeq: 1, shardKey: undefined });
    });

    it("rejects a serverRef that is neither a reference nor a path", () => {
        expect(() => defineMutator({ apply: () => undefined, serverRef: {} as never })).toThrow(MUTATOR_REF_ERROR_RE);
    });

    it.each([
        ["null", null],
        ["undefined", undefined],
    ])("rejects a %s serverRef with the guidance error rather than a TypeError", (_label, serverRef) => {
        expect.assertions(2);

        // The parameter type forbids these, but an untyped caller reaches here anyway —
        // and `serverRef.__lunoraRef` on null throws "Cannot read properties of null",
        // which says nothing about what a `serverRef` should be.
        const declare = () => defineMutator({ apply: () => undefined, serverRef: serverRef as never });

        expect(declare).toThrow(MUTATOR_REF_ERROR_RE);
        expect(declare).not.toThrow(TypeError);
    });

    it("releases parked overlay gates on teardown so a hot reload cannot hang isPersisted", async () => {
        configs.length = 0;

        const client = {
            callMutator: async () => {
                return { applied: true, result: "ok" };
            },
            confirmedMutationWatermark: () => 0,
        } as never;
        const { collection } = mockCollection();

        // Fallback disabled: this is the "the confirming frame will NEVER come"
        // case, which is exactly what a replaced module leaves behind — the
        // subscription that would have resolved the gate is gone with the old module.
        const checkpoints = createCheckpointRegistry({ fallbackMs: 0 });

        const bound = bindMutators(
            client,
            { checkpoints, collections: { messages: collection } },
            { touch: defineMutator({ apply: () => undefined, serverRef: "messages:touch" }) },
        );

        bound.touch({});

        const settled = configs[0]?.mutationFn();
        let done = false;

        void settled?.then(() => {
            done = true;
        });

        await Promise.resolve();
        await Promise.resolve();

        expect(done).toBe(false);

        // The teardown path resolves the parked waiter instead of leaving it pending
        // for the lifetime of the page.
        checkpoints.resolve({ mutationId: Number.POSITIVE_INFINITY });
        await settled;

        expect(done).toBe(true);
    });

    it("pins the upstream direct-transaction metadata key", () => {
        // `@tanstack/db` does not export this constant from its package root, so the
        // literal is pinned in `@lunora/db`. Read the upstream module off disk (via the
        // one path its exports map does expose) so an upstream rename fails HERE, with
        // a clear message, instead of silently reverting every optimistic edit.
        const require_ = createRequire(import.meta.url);
        const packageJsonPath = require_.resolve("@tanstack/db/package.json");
        const source = readFileSync(join(dirname(packageJsonPath), "dist", "esm", "collection", "transaction-metadata.js"), "utf8");

        expect(source).toContain(DIRECT_TRANSACTION_METADATA_KEY);
    });

    it("seeds clientSeq from the server's confirmed watermark so a reload doesn't reissue a stale sequence", async () => {
        configs.length = 0;
        // A reload reset the in-memory counter, but the server already advanced
        // this client's durable watermark to 5 (echoed back via the client).
        const callMutator = vi.fn<
            (path: string, args: Record<string, unknown>, options: { clientSeq: number; shardKey?: string }) => Promise<{ applied: boolean; result: unknown }>
        >(async () => {
            return { applied: true, result: "ok" };
        });
        const client = { callMutator, confirmedMutationWatermark: () => 5 } as never;
        const { collection } = mockCollection();

        const bound = bindMutators(
            client,
            { collections: { messages: collection }, shardKey: "room-1" },
            { send: defineMutator<{ text: string }>({ apply: () => undefined, serverRef: "messages:send" }) },
        );

        bound.send({ text: "after reload" });
        await configs[0]?.mutationFn();

        // The first post-reload push starts at watermark + 1, not 1.
        expect(callMutator).toHaveBeenCalledWith("messages:send", { text: "after reload" }, { clientSeq: 6, shardKey: "room-1" });
    });

    it("reissues above the echoed watermark when the server swallows a stale push as a replay", async () => {
        configs.length = 0;
        // Cold start: the client doesn't yet know the watermark (0), so its first
        // push uses clientSeq 1 — which the DO has already applied. The replay ack
        // (`applied: false`) teaches the client the real watermark (3); the runtime
        // then reissues above it instead of treating the benign ack as a write.
        let watermark = 0;
        const calls: number[] = [];
        const callMutator = vi.fn<
            (path: string, args: Record<string, unknown>, options: { clientSeq: number; shardKey?: string }) => Promise<{ applied: boolean; result: unknown }>
        >(async (_path, _args, options) => {
            calls.push(options.clientSeq);

            if (options.clientSeq <= 3) {
                watermark = 3;

                return { applied: false, result: null };
            }

            watermark = options.clientSeq;

            return { applied: true, result: "ok" };
        });
        const client = { callMutator, confirmedMutationWatermark: () => watermark } as never;
        const { collection } = mockCollection();

        const bound = bindMutators(
            client,
            { collections: { messages: collection }, shardKey: "room-1" },
            { send: defineMutator<{ text: string }>({ apply: () => undefined, serverRef: "messages:send" }) },
        );

        bound.send({ text: "fresh" });
        await configs[0]?.mutationFn();

        // First push at 1 (stale → replay ack), reissued at 4 (watermark 3 + 1).
        expect(calls).toStrictEqual([1, 4]);
    });

    it("throws rather than reissuing forever when a push is never accepted", async () => {
        configs.length = 0;
        // Pathological server: every push is rejected as a replay and the watermark
        // keeps racing ahead, so the runtime can never claim a fresh sequence.
        let watermark = 0;
        const callMutator = vi.fn<
            (path: string, args: Record<string, unknown>, options: { clientSeq: number; shardKey?: string }) => Promise<{ applied: boolean; result: unknown }>
        >(async (_path, _args, options) => {
            watermark = options.clientSeq + 10;

            return { applied: false, result: null };
        });
        const client = { callMutator, confirmedMutationWatermark: () => watermark } as never;
        const { collection } = mockCollection();

        const bound = bindMutators(
            client,
            { collections: { messages: collection }, shardKey: "room-1" },
            { send: defineMutator({ apply: () => undefined, serverRef: "messages:send" }) },
        );

        bound.send({});

        await expect(configs[0]?.mutationFn()).rejects.toThrow(REISSUE_EXHAUSTED);
    });

    it("serializes concurrent pushes so each claims a contiguous sequence in watermark order", async () => {
        configs.length = 0;
        // The DO advances its watermark only once a push is acked. If two pushes
        // raced the network, the second (clientSeq 2 against watermark 0) would be
        // an OUT_OF_ORDER gap and the write would be lost — so the runtime must not
        // issue the second until the first has acked.
        let watermark = 0;
        const calls: number[] = [];
        const gates: (() => void)[] = [];
        const callMutator = vi.fn<
            (path: string, args: Record<string, unknown>, options: { clientSeq: number; shardKey?: string }) => Promise<{ applied: boolean; result: unknown }>
        >(async (_path, _args, options) => {
            calls.push(options.clientSeq);

            // Block until the test releases this push, advancing the watermark to
            // the acked sequence (mirroring the DO's commit-then-advance order).
            await new Promise<void>((resolve) => {
                gates.push(() => {
                    watermark = options.clientSeq;
                    resolve();
                });
            });

            return { applied: true, result: "ok" };
        });
        const client = { callMutator, confirmedMutationWatermark: () => watermark } as never;
        const { collection } = mockCollection();

        const bound = bindMutators(
            client,
            { collections: { messages: collection }, shardKey: "room-1" },
            { send: defineMutator<{ text: string }>({ apply: () => undefined, serverRef: "messages:send" }) },
        );

        bound.send({ text: "a" });
        bound.send({ text: "b" });

        // Drive both transactions "concurrently" — the second must queue behind
        // the first rather than push immediately.
        const first = configs[0]?.mutationFn();
        const second = configs[1]?.mutationFn();

        await flush();

        // Only the first push is in flight; the second is held behind the chain.
        expect(calls).toStrictEqual([1]);

        // Release the first; its ack advances the watermark to 1, so the second
        // now issues at the contiguous sequence 2 (never a gap).
        gates[0]?.();
        await first;
        await flush();

        expect(calls).toStrictEqual([1, 2]);

        gates[1]?.();
        await second;

        expect(calls).toStrictEqual([1, 2]);
    });

    describe("onWriteRejected", () => {
        it("reports a rejected push and consumes the rejection so a fire-and-forget call is safe", async () => {
            expect.assertions(4);

            configs.length = 0;

            const rejected: MutatorRejectedEvent[] = [];
            const failure = Object.assign(new Error("shard rejected the write"), { code: "FORBIDDEN" });
            const client = {
                callMutator: async () => {
                    throw failure;
                },
                confirmedMutationWatermark: () => 0,
            } as never;
            const { collection } = mockCollection();

            const bound = bindMutators(
                client,
                {
                    checkpoints: false,
                    collections: { messages: collection },
                    onWriteRejected: (event) => rejected.push(event),
                },
                { touch: defineMutator({ apply: () => undefined, serverRef: "messages:touch" }) },
            );

            // Deliberately NOT awaited and NOT `.catch`-ed — the shape that used to
            // leave an unhandled rejection and forced an app-level wrapper on every
            // call site.
            bound.touch({ id: "m1" });

            await expect(configs[0]?.mutationFn()).rejects.toThrow("shard rejected the write");

            await flush();

            expect(rejected).toHaveLength(1);

            // The outbox wraps a coded failure in a `NonRetriableError` (that verdict is
            // what makes it terminal), so the hook reports the wrapper — carrying the
            // server's `code` and the original message.
            expect(rejected[0]).toMatchObject({ args: { id: "m1" }, code: "FORBIDDEN", mutator: "touch", serverRef: "messages:touch" });
            expect(rejected[0]?.error.message).toContain("shard rejected the write");
        });

        it("survives a throwing listener rather than manufacturing a second rejection", async () => {
            expect.assertions(1);

            configs.length = 0;

            const client = {
                callMutator: async () => {
                    throw new Error("nope");
                },
                confirmedMutationWatermark: () => 0,
            } as never;
            const { collection } = mockCollection();

            const bound = bindMutators(
                client,
                {
                    checkpoints: false,
                    collections: { messages: collection },
                    onWriteRejected: () => {
                        throw new Error("listener blew up");
                    },
                },
                { touch: defineMutator({ apply: () => undefined, serverRef: "messages:touch" }) },
            );

            bound.touch({});

            await expect(configs[0]?.mutationFn()).rejects.toThrow("nope");

            await flush();
        });

        it("leaves the rejection unhandled when no hook is supplied", async () => {
            expect.assertions(2);

            configs.length = 0;

            // No silent `.catch`: swallowing failures for callers who never opted in
            // would hide dropped writes entirely.
            const client = {
                callMutator: async () => {
                    throw new Error("nope");
                },
                confirmedMutationWatermark: () => 0,
            } as never;
            const { collection } = mockCollection();

            const bound = bindMutators(
                client,
                { checkpoints: false, collections: { messages: collection } },
                { touch: defineMutator({ apply: () => undefined, serverRef: "messages:touch" }) },
            );

            const transaction = bound.touch({});

            await expect(configs[0]?.mutationFn()).rejects.toThrow("nope");

            // The caller can still observe it per-call.
            await expect(transaction.isPersisted.promise).rejects.toThrow("nope");
        });
    });

    describe(initMutators, () => {
        it("types context.collections and takes concrete collections without a cast", async () => {
            expect.assertions(2);

            configs.length = 0;

            interface NodeRow extends Row {
                id: string;
                text: string;
            }

            const updates: { id: string; text: string }[] = [];
            const nodes = {
                update: (id: string, mutate: (draft: NodeRow) => void) => {
                    const draft = { id, text: "" } as NodeRow;

                    mutate(draft);
                    updates.push({ id: draft.id, text: draft.text });
                },
            } as unknown as Collection<NodeRow, string>;

            // Bound ONCE to this project's map — the cast-free equivalent of the
            // `nodes: collection as never` every entry used to need.
            const { bindMutators: bindTyped, defineMutator: defineTyped } = initMutators<{ nodes: Collection<NodeRow, string> }>();

            const api = { mutators: { setText: { __lunoraRef: "mutators:setText" } } } as unknown as {
                mutators: { setText: FunctionReference<"mutation", { id: string; text: string }, void> };
            };

            const setText = defineTyped({
                apply: ({ collections }, args) => {
                    // Typed end-to-end: the collection at its real row type, and args
                    // still inferred from the generated reference.
                    expectTypeOf(collections.nodes).toEqualTypeOf<Collection<NodeRow, string>>();
                    expectTypeOf(args).toEqualTypeOf<{ id: string; text: string }>();

                    collections.nodes.update(args.id, (draft) => {
                        // eslint-disable-next-line no-param-reassign -- mutating the draft IS TanStack DB's update API
                        draft.text = args.text;
                    });
                },
                serverRef: api.mutators.setText,
            });

            const callMutator = vi.fn(async () => {
                return { applied: true, result: undefined };
            });
            const bound = bindTyped({ callMutator, confirmedMutationWatermark: () => 0 } as never, { checkpoints: false, collections: { nodes } }, { setText });

            bound.setText({ id: "n1", text: "hello" });
            await configs[0]?.mutationFn();

            expect(updates).toStrictEqual([{ id: "n1", text: "hello" }]);
            expect(callMutator).toHaveBeenCalledWith("mutators:setText", { id: "n1", text: "hello" }, { clientSeq: 1, shardKey: undefined });
        });

        it("returns the same runtime functions it narrows", () => {
            expect.assertions(2);

            const typed = initMutators<{ nodes: Collection<Row, string> }>();

            expect(typed.bindMutators).toBe(bindMutators);
            expect(typed.defineMutator).toBe(defineMutator);
        });
    });
});
