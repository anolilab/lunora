import { describe, expect, it, vi } from "vitest";

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
                configs.push(config);

                return {
                    mutate: (callback: () => void) => {
                        callback();
                    },
                };
            },
        }) as unknown as typeof import("@tanstack/db"),
);

// eslint-disable-next-line import/first -- must follow the vi.mock above
import { bindMutators, defineMutator } from "../src/define-mutators";

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
        // the serialized push, not at dispatch).
        expect(configs[0]?.metadata).toStrictEqual({ serverRef: "messages:send" });

        // Driving the mutationFn pushes the authoritative write with clientSeq 1.
        await configs[0]?.mutationFn();

        expect(callMutator).toHaveBeenCalledWith("messages:send", { text: "first" }, { clientSeq: 1, shardKey: "room-1" });

        // A second call increments the per-client sequence.
        bound.send({ text: "second" });
        await configs[1]?.mutationFn();

        expect(callMutator).toHaveBeenLastCalledWith("messages:send", { text: "second" }, { clientSeq: 2, shardKey: "room-1" });
    });

    it("holds the overlay until the checkpoint registry echoes the watermark", async () => {
        configs.length = 0;
        const client = {
            callMutator: async () => {
                return { applied: true, result: "ok" };
            },
            confirmedMutationWatermark: () => 0,
        } as never;
        const { collection } = mockCollection();

        let resolved = false;
        const checkpoints = {
            awaitCheckpoint: async () => undefined,
            awaitMutationId: vi.fn<(id: number) => Promise<void>>(async (id) => {
                resolved = id === 1;
            }),
            resolve: () => undefined,
        };

        const bound = bindMutators(
            client,
            { checkpoints, collections: { messages: collection } },
            {
                touch: defineMutator({ apply: () => undefined, serverRef: "messages:touch" }),
            },
        );

        bound.touch({});
        await configs[0]?.mutationFn();

        expect(checkpoints.awaitMutationId).toHaveBeenCalledWith(1);
        expect(resolved).toBe(true);
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

        const flush = async (): Promise<void> => {
            for (let index = 0; index < 8; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- draining the microtask queue deterministically
                await Promise.resolve();
            }
        };

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
});
