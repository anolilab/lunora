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

/** A mock collection that records the optimistic ops an `apply` body issues. */
const mockCollection = () => {
    const inserted: unknown[] = [];

    return { collection: { insert: (row: unknown) => inserted.push(row) } as never, inserted };
};

describe(bindMutators, () => {
    it("runs the optimistic body and pushes the server write under a monotonic clientSeq", async () => {
        configs.length = 0;
        const callMutator = vi.fn<(path: string, args: Record<string, unknown>, options: { clientSeq: number; shardKey?: string }) => Promise<unknown>>(
            async () => "ok",
        );
        const client = { callMutator } as never;
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
        // The transaction carries the watermark metadata.
        expect(configs[0]?.metadata).toStrictEqual({ clientSeq: 1, serverRef: "messages:send" });

        // Driving the mutationFn pushes the authoritative write with clientSeq 1.
        await configs[0]?.mutationFn();

        expect(callMutator).toHaveBeenCalledWith("messages:send", { text: "first" }, { clientSeq: 1, shardKey: "room-1" });

        // A second call increments the per-client sequence.
        bound.send({ text: "second" });

        expect(configs[1]?.metadata).toStrictEqual({ clientSeq: 2, serverRef: "messages:send" });
    });

    it("holds the overlay until the checkpoint registry echoes the watermark", async () => {
        configs.length = 0;
        const client = { callMutator: async () => "ok" } as never;
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
});
