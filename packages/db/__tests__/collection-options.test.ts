import { createCollection } from "@tanstack/db";
import { describe, expect, it, vi } from "vitest";

import { createCheckpointRegistry, getShardCheckpoints, lunoraCollectionOptions, releaseShardCheckpoints } from "../src/collection-options";

/** A fake `FunctionReference` — the binding only forwards it to the client. */
const ref = (name: string) => ({ __lunoraRef: name }) as never;

interface ShapeSubscribeCall {
    name: string;
    onCheckpoint?: (watermark: { checkpoint?: number; mutationId?: number }) => void;
    onRows: (rows: Record<string, unknown>[]) => void;
    shapeArgs: Record<string, unknown> | undefined;
    shardKey?: string;
    unsubscribe: ReturnType<typeof vi.fn>;
}

/** A mock `LunoraClient` recording every `subscribeShape` / `subscribe`. */
const makeClient = () => {
    const shapeSubscribes: ShapeSubscribeCall[] = [];
    const client = {
        confirmedMutationWatermark: vi.fn<(shardKey?: string) => number>(() => 0),
        subscribe: vi.fn<(...arguments_: unknown[]) => () => void>(),
        subscribeShape: vi.fn<
            (
                shape: { args?: Record<string, unknown>; name: string },
                onRows: (rows: Record<string, unknown>[]) => void,
                options?: { onCheckpoint?: (watermark: { checkpoint?: number; mutationId?: number }) => void; shardKey?: string },
            ) => () => void
        >(
            (
                shape: { args?: Record<string, unknown>; name: string },
                onRows: (rows: Record<string, unknown>[]) => void,
                options?: { onCheckpoint?: (watermark: { checkpoint?: number; mutationId?: number }) => void; shardKey?: string },
            ) => {
                const unsubscribe = vi.fn<() => void>();

                shapeSubscribes.push({
                    name: shape.name,
                    onCheckpoint: options?.onCheckpoint,
                    onRows,
                    shapeArgs: shape.args,
                    shardKey: options?.shardKey,
                    unsubscribe,
                });

                return unsubscribe;
            },
        ),
    };

    return { client: client as never, shapeSubscribes };
};

/** Let a microtask (collection sync) flush. */
const flush = () =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

type WriterOp = { key: string; type: "delete" } | { type: "insert" | "update"; value: Record<string, unknown> };

/**
 * A fake TanStack sync writer that records the diff ops `makeDiffEmit` writes.
 * Drives the `config.sync.sync(writer)` seam directly so a sync session's
 * lifecycle (start → rows → cleanup → restart) is exercised deterministically,
 * without waiting on TanStack's gc timers.
 */
const recordingWriter = (): { ops: WriterOp[]; writer: { begin: () => void; commit: () => void; markReady: () => void; write: (op: WriterOp) => void } } => {
    const ops: WriterOp[] = [];

    return {
        ops,
        writer: {
            begin: () => {},
            commit: () => {},
            markReady: () => {},
            write: (op) => {
                ops.push(op);
            },
        },
    };
};

/** Grab the `sync.sync` starter off a built config (returns the cleanup fn each call). */
const syncStarterOf = (config: { sync?: unknown }): ((writer: never) => () => void) => (config.sync as { sync: (writer: never) => () => void }).sync;

/**
 * Phase 6 — the checkpoint registry that drops a TanStack optimistic overlay
 * exactly when the server confirms the write's watermark. The gates are
 * monotonic: a threshold already passed resolves immediately, and a single
 * `resolve` settles every waiter at or below the new mark.
 */
describe(createCheckpointRegistry, () => {
    it("resolves awaitMutationId once the echoed watermark reaches the threshold", async () => {
        const registry = createCheckpointRegistry();
        const order: string[] = [];

        const pending = registry.awaitMutationId(3).then(() => order.push("settled"));

        // A lower watermark does not settle a higher waiter.
        registry.resolve({ mutationId: 2 });
        await Promise.resolve();

        expect(order).toStrictEqual([]);

        registry.resolve({ mutationId: 3 });
        await pending;

        expect(order).toStrictEqual(["settled"]);
    });

    it("settles a threshold already passed immediately", async () => {
        const registry = createCheckpointRegistry();

        registry.resolve({ checkpoint: 10, mutationId: 5 });

        await expect(registry.awaitCheckpoint(7)).resolves.toBeUndefined();
        await expect(registry.awaitMutationId(5)).resolves.toBeUndefined();
    });

    it("keeps checkpoint and mutation-id gates independent", async () => {
        const registry = createCheckpointRegistry();
        let checkpointSettled = false;

        const pendingCheckpoint = registry.awaitCheckpoint(4).then(() => {
            checkpointSettled = true;

            return true;
        });

        // Advancing only the mutation gate must not settle a checkpoint waiter.
        registry.resolve({ mutationId: 99 });
        await Promise.resolve();

        expect(checkpointSettled).toBe(false);

        registry.resolve({ checkpoint: 4 });
        await pendingCheckpoint;

        expect(checkpointSettled).toBe(true);
    });

    it("does not regress the high-water mark on an out-of-order resolve", async () => {
        const registry = createCheckpointRegistry();

        registry.resolve({ mutationId: 8 });
        registry.resolve({ mutationId: 3 });

        // Still satisfied at 8 despite the later lower resolve.
        await expect(registry.awaitMutationId(8)).resolves.toBeUndefined();
    });

    it("dispose clears armed fallback timers so none fire afterward", () => {
        vi.useFakeTimers();

        try {
            const onFallback = vi.fn<() => void>();
            const registry = createCheckpointRegistry({ fallbackMs: 1000, onFallback });

            // Arm a fallback: acknowledged watermarks the sync stream hasn't echoed yet.
            registry.acknowledge({ checkpoint: 7, mutationId: 5 });
            registry.dispose();

            vi.advanceTimersByTime(5000);

            // No armed timer survives the dispose — the closures can't hold an event loop open.
            expect(onFallback).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe(releaseShardCheckpoints, () => {
    it("clears a released client's armed fallback timers", () => {
        vi.useFakeTimers();

        try {
            const { client } = makeClient();
            const onFallback = vi.fn<() => void>();
            const registry = getShardCheckpoints(client, "", { fallbackMs: 1000, onFallback });

            // Arm a fallback, then tear the client's registries down (HMR dispose / sign-out).
            registry.acknowledge({ checkpoint: 7, mutationId: 5 });
            releaseShardCheckpoints(client);

            vi.advanceTimersByTime(5000);

            expect(onFallback).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});

/**
 * Phase 6/7 — the replication-shape sync source. A `shape` collection live-syncs
 * a named shape's rowset through `client.subscribeShape` (the poke protocol)
 * instead of a full-table `list` query subscription.
 */
describe("lunoraCollectionOptions (shape source)", () => {
    it("rejects passing neither `list` nor `shape`", () => {
        const { client } = makeClient();

        expect(() => lunoraCollectionOptions({ client })).toThrow("pass exactly one of `list` or `shape`");
    });

    it("rejects passing both `list` and `shape`", () => {
        const { client } = makeClient();

        expect(() => lunoraCollectionOptions({ client, list: ref("messages:list"), shape: { name: "channelMessages" } })).toThrow(
            "pass exactly one of `list` or `shape`",
        );
    });

    it("defaults the collection id to `shape:<name>`", () => {
        const { client } = makeClient();

        const options = lunoraCollectionOptions({ client, shape: { name: "channelMessages" } });

        expect(options.config.id).toBe("shape:channelMessages");
    });

    it("opens a shape subscription with the shape's name + args (and shardKey) and syncs the rowset in", async () => {
        const { client, shapeSubscribes } = makeClient();

        const options = lunoraCollectionOptions({
            client,
            shape: { args: { channelId: "c1" }, name: "channelMessages", shardKey: "c1" },
        });
        const collection = createCollection(options.config);

        const subscription = collection.subscribeChanges(() => {});
        await flush();

        const call = shapeSubscribes.find((s) => s.name === "channelMessages");

        expect(call).toBeDefined();
        expect(call?.shapeArgs).toStrictEqual({ channelId: "c1" });
        expect(call?.shardKey).toBe("c1");

        // The seed poke's rowset arrives → the collection reflects it.
        call?.onRows([
            { _creationTime: 0, _id: "m1", channelId: "c1", text: "hi" },
            { _creationTime: 1, _id: "m2", channelId: "c1", text: "yo" },
        ]);
        await flush();

        expect(collection.size).toBe(2);
        expect(collection.get("m1")).toMatchObject({ text: "hi" });

        subscription.unsubscribe();
    });

    it("does not touch the full-table `subscribe` path for a shape collection", async () => {
        const { client } = makeClient();

        const options = lunoraCollectionOptions({ client, shape: { name: "channelMessages" } });
        const collection = createCollection(options.config);

        collection.subscribeChanges(() => {});
        await flush();

        expect((client as unknown as { subscribe: ReturnType<typeof vi.fn> }).subscribe).not.toHaveBeenCalled();
        expect((client as unknown as { subscribeShape: ReturnType<typeof vi.fn> }).subscribeShape).toHaveBeenCalledTimes(1);
    });

    it("advances the returned checkpoints registry as the shape syncs watermarks", async () => {
        const { client, shapeSubscribes } = makeClient();

        const options = lunoraCollectionOptions({ client, shape: { name: "channelMessages" } });
        const collection = createCollection(options.config);

        collection.subscribeChanges(() => {});
        await flush();

        const call = shapeSubscribes.find((s) => s.name === "channelMessages");

        expect(call?.onCheckpoint).toBeTypeOf("function");

        // A waiter on mutation id 4 stays pending until the shape's poke confirms it.
        const order: string[] = [];
        const pending = options.checkpoints.awaitMutationId(4).then(() => order.push("dropped"));

        call?.onCheckpoint?.({ checkpoint: 5, mutationId: 3 });
        await Promise.resolve();

        expect(order).toStrictEqual([]);

        // The next poke syncs the write's watermark → the overlay drop unblocks.
        call?.onCheckpoint?.({ checkpoint: 9, mutationId: 4 });
        await pending;

        expect(order).toStrictEqual(["dropped"]);
    });
});

/**
 * The full-table `list` sync source. A `list` collection live-syncs through
 * `client.subscribe`; a write that touches the read tables but produces a
 * byte-identical result emits no data frame (server-side frame suppression), so
 * the server's `settled` frame drives `onCheckpoint` to drop the optimistic
 * overlay — without it, a custom-mutator overlay would hang forever.
 */
describe("lunoraCollectionOptions (list source)", () => {
    const subscribeOptionsFrom = (client: never): { onCheckpoint?: (watermark: { checkpoint?: number; mutationId?: number }) => void } => {
        const subscribeMock = (client as unknown as { subscribe: ReturnType<typeof vi.fn> }).subscribe;

        return (subscribeMock.mock.calls[0]?.[3] ?? {}) as { onCheckpoint?: (watermark: { checkpoint?: number; mutationId?: number }) => void };
    };

    it("wires an onCheckpoint into the list subscription", async () => {
        const { client } = makeClient();

        const options = lunoraCollectionOptions({ client, list: ref("messages:list") });
        const collection = createCollection(options.config);

        collection.subscribeChanges(() => {});
        await flush();

        expect((client as unknown as { subscribe: ReturnType<typeof vi.fn> }).subscribe).toHaveBeenCalledTimes(1);
        expect(subscribeOptionsFrom(client).onCheckpoint).toBeTypeOf("function");
    });

    it("maps load: 'eager' to TanStack startSync, and defaults to lazy (omitted)", () => {
        const { client } = makeClient();

        const lazy = lunoraCollectionOptions({ client, list: ref("messages:list") });
        const eager = lunoraCollectionOptions({ client, list: ref("teams:list"), load: "eager" });

        // Lazy is the default: `startSync` is omitted (TanStack's default false →
        // sync starts on the first subscriber), keeping the config byte-identical.
        expect((lazy.config as { startSync?: boolean }).startSync).toBeUndefined();
        // Eager opts the collection into syncing at creation (instant reference data).
        expect((eager.config as { startSync?: boolean }).startSync).toBe(true);
    });

    it("drops a stuck overlay when a settled frame's onCheckpoint advances the watermark", async () => {
        const { client } = makeClient();

        const options = lunoraCollectionOptions({ client, list: ref("messages:list") });
        const collection = createCollection(options.config);

        collection.subscribeChanges(() => {});
        await flush();

        const { onCheckpoint } = subscribeOptionsFrom(client);
        const order: string[] = [];

        // A confirmed write at seq 7 whose authoritative result did not change the
        // list. No data frame arrives — only the suppressed-frame `settled`
        // watermark, forwarded here.
        const pending = options.checkpoints.awaitMutationId(7).then(() => order.push("dropped"));

        onCheckpoint?.({ checkpoint: 3, mutationId: 6 });
        await Promise.resolve();

        expect(order).toStrictEqual([]);

        onCheckpoint?.({ checkpoint: 4, mutationId: 7 });
        await pending;

        expect(order).toStrictEqual(["dropped"]);
    });

    it("routes the list subscription and its fallback watermark to the config shardKey", async () => {
        expect.assertions(2);

        const { client } = makeClient();
        const subscribeMock = (client as unknown as { subscribe: ReturnType<typeof vi.fn> }).subscribe;
        const watermark = (client as unknown as { confirmedMutationWatermark: ReturnType<typeof vi.fn> }).confirmedMutationWatermark;

        const options = lunoraCollectionOptions({ client, list: ref("messages:list"), shardKey: "room-7" });
        const collection = createCollection(options.config);

        collection.subscribeChanges(() => {});
        await flush();

        // The subscription is opened against the shard.
        expect(subscribeMock.mock.calls[0]?.[3]).toMatchObject({ shardKey: "room-7" });

        // A data frame arrives → the list-path fallback advances the checkpoint
        // gate from THIS shard's confirmed watermark, not the default ("") bucket
        // (whose sequence line is unrelated to a per-shard mutator's).
        const onRows = subscribeMock.mock.calls[0]?.[2] as (data: unknown) => void;

        onRows([{ _creationTime: 0, _id: "m1", channelId: "room-7", text: "hi" }]);

        expect(watermark).toHaveBeenCalledWith("room-7");
    });

    it("re-inserts the full snapshot after a sync restart (gc cleanup clears the diff cache)", () => {
        expect.assertions(2);

        const { client } = makeClient();
        const subscribeMock = (client as unknown as { subscribe: ReturnType<typeof vi.fn> }).subscribe;
        const options = lunoraCollectionOptions({ client, list: ref("messages:list") });
        const runSync = syncStarterOf(options.config);

        // Session 1: TanStack starts sync → the server's snapshot arrives.
        const first = recordingWriter();
        const cleanup1 = runSync(first.writer as never);

        (subscribeMock.mock.calls[0]?.[2] as (data: unknown) => void)([{ _id: "a", text: "hi" }]);

        expect(first.ops).toStrictEqual([{ type: "insert", value: { _id: "a", text: "hi" } }]);

        // gc cleanup: TanStack drops its synced store; the diff cache must reset.
        cleanup1();

        // Restart: the server re-delivers the identical snapshot. The row must be
        // RE-INSERTED into the now-empty store — not diffed away to zero writes,
        // which would leave the collection permanently empty.
        const second = recordingWriter();

        runSync(second.writer as never);
        (subscribeMock.mock.calls[1]?.[2] as (data: unknown) => void)([{ _id: "a", text: "hi" }]);

        expect(second.ops).toStrictEqual([{ type: "insert", value: { _id: "a", text: "hi" } }]);
    });
});

/**
 * The scope/sync lifecycle for a `scopeBy` collection: a sync restart (after gc
 * cleanup) must re-open the last scope, and a `scope(...)` issued before sync
 * first starts must still deliver the source's initial snapshot.
 */
describe("lunoraCollectionOptions (scoped lifecycle)", () => {
    it("reopens the last scope after a sync restart so a gc'd scoped collection refills", () => {
        expect.assertions(3);

        const { client } = makeClient();
        const subscribeMock = (client as unknown as { subscribe: ReturnType<typeof vi.fn> }).subscribe;
        const options = lunoraCollectionOptions({ client, list: ref("messages:list"), scopeBy: "channelId" });
        const runSync = syncStarterOf(options.config);

        // Session 1: sync starts (scoped → nothing subscribed), then scope points it.
        const cleanup1 = runSync(recordingWriter().writer as never);

        expect(subscribeMock).not.toHaveBeenCalled();

        options.scope({ channelId: "c1" });

        expect(subscribeMock).toHaveBeenCalledTimes(1);

        // gc cleanup tears the session down; the scope target is remembered.
        cleanup1();

        // Restart: sync.sync must re-open the remembered scope (not remount empty).
        runSync(recordingWriter().writer as never);

        expect(subscribeMock).toHaveBeenCalledTimes(2);
    });

    it("applies a scope set before sync starts and delivers its initial snapshot", () => {
        expect.assertions(3);

        const { client } = makeClient();
        const subscribeMock = (client as unknown as { subscribe: ReturnType<typeof vi.fn> }).subscribe;
        const options = lunoraCollectionOptions({ client, list: ref("messages:list"), scopeBy: "channelId" });
        const runSync = syncStarterOf(options.config);

        // scope() BEFORE TanStack ever calls sync.sync (emit undefined): the
        // subscription is deferred, not opened against a dead emit that would
        // silently drop the first frame.
        options.scope({ channelId: "c1" });

        expect(subscribeMock).not.toHaveBeenCalled();

        // Sync starts → the deferred scope opens with a live emit.
        const writer = recordingWriter();

        runSync(writer.writer as never);

        expect(subscribeMock).toHaveBeenCalledTimes(1);

        // The source's initial frame is emitted (previously dropped).
        (subscribeMock.mock.calls[0]?.[2] as (data: unknown) => void)([{ _creationTime: 0, _id: "m1", channelId: "c1", text: "hi" }]);

        expect(writer.ops).toStrictEqual([{ type: "insert", value: { _creationTime: 0, _id: "m1", channelId: "c1", text: "hi" } }]);
    });
});
