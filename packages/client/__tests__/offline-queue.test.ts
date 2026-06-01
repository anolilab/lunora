import { describe, expect, test, vi } from "vitest";

import { OfflineQueue } from "../src/offline-queue.js";
import { createInMemoryPersistence } from "../src/persistence.js";

describe("offlineQueue", () => {
    test("fIFO drain order", () => {
        expect.assertions(2);

        const queue = new OfflineQueue();
        const order: string[] = [];

        for (const path of ["a", "b", "c"]) {
            queue.enqueue({
                functionPath: path,
                args: {},
                resolve: () => order.push(`done:${path}`),
                reject: () => order.push(`fail:${path}`),
            });
        }

        const drained = queue.drain();

        expect(drained.map((d) => d.functionPath)).toEqual(["a", "b", "c"]);
        expect(queue.size).toBe(0);
    });

    test("bounded by maxItems — oldest entry is rejected on overflow", () => {
        expect.assertions(4);

        const queue = new OfflineQueue({ maxItems: 2 });
        const rejected = vi.fn<(error: unknown) => void>();

        queue.enqueue({
            functionPath: "old",
            args: {},
            resolve: () => undefined,
            reject: rejected,
        });
        queue.enqueue({ functionPath: "mid", args: {}, resolve: () => undefined, reject: () => undefined });
        queue.enqueue({ functionPath: "new", args: {}, resolve: () => undefined, reject: () => undefined });

        expect(queue.size).toBe(2);
        expect(rejected).toHaveBeenCalledTimes(1);

        const error = rejected.mock.calls[0]?.[0] as Error & { code?: string };

        expect(error.code).toBe("OFFLINE_QUEUE_OVERFLOW");

        const drained = queue.drain();

        expect(drained.map((d) => d.functionPath)).toEqual(["mid", "new"]);
    });

    test("clear() rejects pending mutations with CLIENT_CLOSED and empties the queue", () => {
        expect.assertions(4);

        const queue = new OfflineQueue();
        const rejected = vi.fn<(error: unknown) => void>();

        queue.enqueue({ functionPath: "a", args: {}, resolve: () => undefined, reject: rejected });
        queue.clear();

        expect(queue.size).toBe(0);
        expect(rejected).toHaveBeenCalledTimes(1);

        const error = rejected.mock.calls[0]?.[0] as Error & { code?: string };

        expect(error.message).toBe("CLIENT_CLOSED");
        expect(error.code).toBe("CLIENT_CLOSED");
    });
});

describe("offlineQueue — persistence", () => {
    test("enqueue mirrors the mutation to durable storage with an assigned id", async () => {
        expect.assertions(4);

        const persistence = createInMemoryPersistence();
        const queue = new OfflineQueue({}, persistence);

        queue.enqueue({ functionPath: "posts:create", args: { title: "hi" }, shardKey: "room-1", resolve: () => undefined, reject: () => undefined });

        const persisted = await persistence.load();

        expect(persisted).toHaveLength(1);
        expect(persisted[0]).toMatchObject({ functionPath: "posts:create", args: { title: "hi" }, shardKey: "room-1" });
        // Runtime check that enqueue minted a non-empty string id. `toBeTypeOf`
        // (not `expectTypeOf`) is deliberate: the field is statically
        // `string | undefined`, so a compile-time type assertion would verify
        // nothing — we need to confirm an id was actually assigned at runtime.
        expect(persisted[0]?.id).toBeTypeOf("string");
        expect(persisted[0]?.id).not.toBe("");
    });

    test("overflow un-persists the dropped (oldest) entry", async () => {
        expect.assertions(1);

        const persistence = createInMemoryPersistence();
        const queue = new OfflineQueue({ maxItems: 1 }, persistence);

        queue.enqueue({ functionPath: "old", args: {}, resolve: () => undefined, reject: () => undefined });
        queue.enqueue({ functionPath: "new", args: {}, resolve: () => undefined, reject: () => undefined });

        const persisted = await persistence.load();

        expect(persisted.map((m) => m.functionPath)).toEqual(["new"]);
    });

    test("hydrate restores persisted mutations in FIFO order and reports distinct shard keys", async () => {
        expect.assertions(3);

        const persistence = createInMemoryPersistence();

        await persistence.append({ functionPath: "a", args: {}, id: "1", shardKey: "room-1" });
        await persistence.append({ functionPath: "b", args: {}, id: "2", shardKey: "room-2" });
        await persistence.append({ functionPath: "c", args: {}, id: "3", shardKey: "room-1" });

        const queue = new OfflineQueue({}, persistence);
        const shardKeys = await queue.hydrate();

        expect(queue.size).toBe(3);
        expect([...shardKeys].sort()).toEqual(["room-1", "room-2"]);

        const drained = queue.drain();

        expect(drained.map((d) => d.functionPath)).toEqual(["a", "b", "c"]);
    });

    test("hydrate re-appends nothing and skips ids already queued", async () => {
        expect.assertions(1);

        const persistence = createInMemoryPersistence();

        await persistence.append({ functionPath: "a", args: {}, id: "1" });

        const queue = new OfflineQueue({}, persistence);

        await queue.hydrate();
        // A second hydrate (or one after the live enqueue assigned the same id)
        // must not duplicate the entry.
        await queue.hydrate();

        expect(queue.size).toBe(1);
    });

    test("restored mutations carry no-op resolve/reject so replay can settle them", async () => {
        expect.assertions(1);

        const persistence = createInMemoryPersistence();

        await persistence.append({ functionPath: "a", args: {}, id: "1" });

        const queue = new OfflineQueue({}, persistence);

        await queue.hydrate();

        const [restored] = queue.drain();

        expect(() => {
            restored?.resolve(undefined);
            restored?.reject(new Error("ignored"));
        }).not.toThrow();
    });

    test("clear() leaves durable storage intact so a future session can restore it", async () => {
        expect.assertions(2);

        const persistence = createInMemoryPersistence();
        const queue = new OfflineQueue({}, persistence);

        queue.enqueue({ functionPath: "a", args: {}, resolve: () => undefined, reject: () => undefined });
        queue.clear();

        expect(queue.size).toBe(0);
        await expect(persistence.load()).resolves.toHaveLength(1);
    });
});
