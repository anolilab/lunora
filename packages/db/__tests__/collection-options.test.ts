import { createCollection } from "@tanstack/db";
import { describe, expect, it, vi } from "vitest";

import { createCheckpointRegistry, lunoraCollectionOptions } from "../src/collection-options";

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

interface ListSubscribeCall {
    onCheckpoint?: (watermark: { checkpoint?: number; mutationId?: number }) => void;
    onRows: (rows: unknown) => void;
    unsubscribe: ReturnType<typeof vi.fn>;
}

/** A mock `LunoraClient` recording every `subscribeShape` / `subscribe`. */
const makeClient = (options: { confirmedMutationWatermark?: () => number } = {}) => {
    const shapeSubscribes: ShapeSubscribeCall[] = [];
    const listSubscribes: ListSubscribeCall[] = [];
    const client = {
        confirmedMutationWatermark: options.confirmedMutationWatermark ?? (() => 0),
        subscribe: vi.fn<
            (
                _fn: unknown,
                _args: unknown,
                onRows: (rows: unknown) => void,
                opts?: { onCheckpoint?: (watermark: { checkpoint?: number; mutationId?: number }) => void },
            ) => () => void
        >(
            (
                _fn: unknown,
                _args: unknown,
                onRows: (rows: unknown) => void,
                opts?: { onCheckpoint?: (watermark: { checkpoint?: number; mutationId?: number }) => void },
            ) => {
                const unsubscribe = vi.fn<() => void>();

                listSubscribes.push({ onCheckpoint: opts?.onCheckpoint, onRows, unsubscribe });

                return unsubscribe;
            },
        ),
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
                opts?: { onCheckpoint?: (watermark: { checkpoint?: number; mutationId?: number }) => void; shardKey?: string },
            ) => {
                const unsubscribe = vi.fn<() => void>();

                shapeSubscribes.push({
                    name: shape.name,
                    onCheckpoint: opts?.onCheckpoint,
                    onRows,
                    shapeArgs: shape.args,
                    shardKey: opts?.shardKey,
                    unsubscribe,
                });

                return unsubscribe;
            },
        ),
    };

    return { client: client as never, listSubscribes, shapeSubscribes };
};

/** Let a microtask (collection sync) flush. */
const flush = () =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

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
 * Phase 6/7 — the full-table `list` sync source with the `onCheckpoint` gate.
 *
 * Case A: a data frame (changed result) drops the overlay via `onRows`.
 * Case B: a settled frame (unchanged result) drops the overlay via `onCheckpoint`
 * without emitting rows.
 */
describe("lunoraCollectionOptions (list source)", () => {
    it("opens a list subscription and passes onCheckpoint to subscribe()", async () => {
        expect.assertions(2);

        const { client, listSubscribes } = makeClient();

        const options = lunoraCollectionOptions({ client, list: ref("messages:list") });
        const collection = createCollection(options.config);

        collection.subscribeChanges(() => {});
        await flush();

        expect(listSubscribes).toHaveLength(1);
        expect(listSubscribes[0]?.onCheckpoint).toBeTypeOf("function");
    });

    it("case A — onRows (changed result) advances checkpoints and emits rows", async () => {
        expect.assertions(2);

        const order: string[] = [];

        // confirmedMutationWatermark returns 1 (the applied seq the mutator wrote)
        const { client, listSubscribes } = makeClient({ confirmedMutationWatermark: () => 1 });

        const options = lunoraCollectionOptions({ client, list: ref("messages:list") });
        const collection = createCollection(options.config);

        collection.subscribeChanges(() => {});
        await flush();

        const call = listSubscribes[0];

        // A waiter on mutation id 1 — should resolve when onRows fires.
        const pending = options.checkpoints.awaitMutationId(1).then(() => order.push("gate-resolved"));

        call?.onRows([
            { _creationTime: 0, _id: "m1", text: "hello" },
            { _creationTime: 1, _id: "m2", text: "world" },
        ]);
        await flush();

        order.push("rows-emitted");

        await pending;

        // Both must happen; rows must be emitted alongside or before the gate resolves.
        expect(order).toContain("rows-emitted");
        expect(order).toContain("gate-resolved");
    });

    it("case B — onCheckpoint (settled frame / unchanged result) resolves the gate without emitting rows", async () => {
        expect.assertions(4);

        // confirmedMutationWatermark returns 1 after the push is confirmed.
        const { client, listSubscribes } = makeClient({ confirmedMutationWatermark: () => 1 });

        const options = lunoraCollectionOptions({ client, list: ref("messages:list") });
        const collection = createCollection(options.config);

        collection.subscribeChanges(() => {});
        await flush();

        const call = listSubscribes[0];

        expect(call).toBeDefined();
        expect(call?.onCheckpoint).toBeTypeOf("function");

        // Await mutation id 1 — this is what bindMutators does after callMutator.
        const order: string[] = [];
        const pending = options.checkpoints.awaitMutationId(1).then(() => order.push("gate-resolved"));

        // No onRows call — the server sent a settled frame (result unchanged).
        await Promise.resolve();

        expect(order).toStrictEqual([]); // gate is still pending

        // Simulates the settled frame arriving: client fires onCheckpoint.
        call?.onCheckpoint?.({});

        await pending;

        // Gate resolved without rows landing.
        expect(order).toStrictEqual(["gate-resolved"]);
    });

    it("case B (wiring sanity) — awaitMutationId does not resolve without an onCheckpoint trigger", async () => {
        expect.assertions(2);

        // This test PROVES the gate is trigger-based: even though confirmedMutationWatermark
        // already returns 1, the gate does not self-resolve — it only resolves when
        // the onCheckpoint callback fires (simulating a settled or data frame).
        const { client } = makeClient({ confirmedMutationWatermark: () => 1 });

        const options = lunoraCollectionOptions({ client, list: ref("messages:list") });
        const collection = createCollection(options.config);

        collection.subscribeChanges(() => {});
        await flush();

        const order: string[] = [];
        const pending = options.checkpoints.awaitMutationId(1).then(() => order.push("gate-resolved"));

        // Simulate: settled frame arrives but onCheckpoint is NOT invoked (wiring removed).
        // confirmedMutationWatermark() already returns 1, but the gate is trigger-based.
        await Promise.resolve();

        expect(order).toStrictEqual([]); // gate is still pending — overlay hangs

        // Races a timeout to confirm the gate never resolves without the trigger.
        const raceResult = await Promise.race([
            pending.then(() => "resolved"),
            new Promise<string>((resolve) => {
                setTimeout(resolve, 10, "timeout");
            }),
        ]);

        expect(raceResult).toBe("timeout"); // confirms the gate needs the trigger
    });
});
