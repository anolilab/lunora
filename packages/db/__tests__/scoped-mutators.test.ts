import { createCollection } from "@tanstack/db";
import { describe, expect, it, vi } from "vitest";

import { bindMutators, defineMutator, getShardCheckpoints, lunoraCollectionOptions } from "../src";

/**
 * The documented partial-replication setup, end to end: a shape collection that
 * follows its scope, and custom mutators bound with the same `scopeBy`. Reads and
 * writes must meet on the scoped channel's shard, and the optimistic row must stay
 * until that shard's echo resolves the checkpoint — not until the fallback timer.
 */

interface ShapeSubscription {
    onCheckpoint: (watermark: { checkpoint?: number; mutationId?: number; rowsFollow?: boolean }) => void;
    onRows: (rows: Record<string, unknown>[]) => void;
    shardKey?: string;
}

interface Push {
    args: Record<string, unknown>;
    clientSeq: number;
    shardKey?: string;
}

const makeClient = () => {
    const shapes: ShapeSubscription[] = [];
    const pushes: Push[] = [];
    const client = {
        callMutator: vi.fn<
            (serverRef: string, args: Record<string, unknown>, options: { clientSeq: number; shardKey?: string }) => Promise<{ applied: boolean }>
        >(async (_serverRef: string, args: Record<string, unknown>, options: { clientSeq: number; shardKey?: string }) => {
            pushes.push({ args, clientSeq: options.clientSeq, shardKey: options.shardKey });

            return { applied: true };
        }),
        confirmedMutationWatermark: () => 0,
        currentIdentity: () => null,
        subscribe: () => () => undefined,
        subscribeShape: (
            _shape: unknown,
            onRows: ShapeSubscription["onRows"],
            options: { onCheckpoint: ShapeSubscription["onCheckpoint"]; shardKey?: string },
        ) => {
            shapes.push({ onCheckpoint: options.onCheckpoint, onRows, shardKey: options.shardKey });

            return () => undefined;
        },
    };

    return { client: client as never, pushes, shapes };
};

/** The documented wiring (docs "Shapes — partial replication" + "Custom mutators"). */
const documentedSetup = () => {
    const { client, pushes, shapes } = makeClient();
    // Destructured once, at creation — before any scope exists.
    const { checkpoints, config, scope } = lunoraCollectionOptions<{ _id: string; channelId: string; text: string }>({
        client,
        scopeBy: "channelId",
        shape: { args: { channelId: "general" }, name: "messagesByChannel" },
    });
    const messages = createCollection(config);

    messages.subscribeChanges(() => undefined);
    scope({ channelId: "general" });

    const send = bindMutators(
        client,
        { checkpoints, collections: { messages }, scopeBy: "channelId" },
        {
            sendMessage: defineMutator<{ channelId: string; id: string; text: string }>({
                apply: (_context, { channelId, id, text }) => {
                    messages.insert({ _id: id, channelId, text });
                },
                serverRef: "mutators:sendMessage",
            }),
        },
    );

    return { checkpoints, client, messages, pushes, send, shapes };
};

/** Settle `promise`, or report that it was still pending after `ms`. */
const within = async (promise: Promise<unknown>, ms: number): Promise<"pending" | "settled"> =>
    Promise.race([
        promise.then(() => "settled" as const),
        new Promise<"pending">((resolve) => {
            setTimeout(resolve, ms, "pending");
        }),
    ]);

const SCOPE_BY_RE = /scopeBy/u;

describe("scope-following shape collection + scoped mutators", () => {
    it("pushes to the scoped shard and holds the optimistic row until that shard's echo resolves it", async () => {
        const { checkpoints, messages, pushes, send, shapes } = documentedSetup();

        expect(shapes.at(-1)?.shardKey).toBe("general");

        const transaction = send.sendMessage({ channelId: "general", id: "m1", text: "hi" });

        await vi.waitFor(() => {
            expect(pushes).toHaveLength(1);
        });

        expect(pushes[0]?.shardKey).toBe("general");
        expect(messages.get("m1")).toMatchObject({ text: "hi" });
        // Accepted but not yet echoed: the overlay is held, not dropped on the ack.
        await expect(within(transaction.isPersisted.promise, 50)).resolves.toBe("pending");
        expect(messages.get("m1")).toMatchObject({ text: "hi" });

        // The general shard echoes the write: the row, stamped with this client's watermark.
        const shape = shapes.at(-1)!;

        shape.onCheckpoint({ checkpoint: 1, mutationId: pushes[0]!.clientSeq, rowsFollow: true });
        shape.onRows([{ _id: "m1", channelId: "general", text: "hi" }]);

        // Resolved by the echo, well inside the fallback window.
        await expect(within(transaction.isPersisted.promise, 1000)).resolves.toBe("settled");
        expect(checkpoints.stats().fallbacks).toBe(0);
        expect(messages.get("m1")).toMatchObject({ text: "hi" });
    });

    it("keeps a checkpoints registry destructured before scoping pointed at the current scope's shard", async () => {
        const { checkpoints, client } = documentedSetup();

        const general = checkpoints.awaitMutationId(7);

        getShardCheckpoints(client, "general").resolve({ mutationId: 7 });

        await expect(within(general, 100)).resolves.toBe("settled");
        await expect(within(checkpoints.awaitMutationId(8), 50)).resolves.toBe("pending");
    });

    it("routes a mutator call to the shard its own args name, not the current scope", async () => {
        const { pushes, send } = documentedSetup();

        send.sendMessage({ channelId: "random", id: "m2", text: "elsewhere" });

        await vi.waitFor(() => {
            expect(pushes).toHaveLength(1);
        });

        expect(pushes[0]?.shardKey).toBe("random");
    });

    it("refuses to bind a scope-following checkpoint registry to mutators that do not follow the scope", () => {
        const { client } = makeClient();
        const { checkpoints, config } = lunoraCollectionOptions({ client, scopeBy: "channelId", shape: { name: "messagesByChannel" } });
        const messages = createCollection(config);

        expect(() => bindMutators(client, { checkpoints, collections: { messages } }, {})).toThrow(SCOPE_BY_RE);
    });
});
