import { describe, expect, it, vi } from "vitest";

import { OfflineQueue } from "../src/offline-queue";
import { createInMemoryPersistence } from "../src/persistence";
import type { PersistenceAdapter, PersistenceErrorContext } from "../src/types";

describe("offlineQueue", () => {
    it("fIFO drain order", () => {
        expect.assertions(2);

        const queue = new OfflineQueue();
        const order: string[] = [];

        for (const path of ["a", "b", "c"]) {
            queue.enqueue({
                args: {},
                functionPath: path,
                reject: () => order.push(`fail:${path}`),
                resolve: () => order.push(`done:${path}`),
            });
        }

        const drained = queue.drain();

        expect(drained.map((d) => d.functionPath)).toEqual(["a", "b", "c"]);
        expect(queue.size).toBe(0);
    });

    it("bounded by maxItems — oldest entry is rejected on overflow", () => {
        expect.assertions(4);

        const queue = new OfflineQueue({ maxItems: 2 });
        const rejected = vi.fn<(error: unknown) => void>();

        queue.enqueue({
            args: {},
            functionPath: "old",
            reject: rejected,
            resolve: () => undefined,
        });
        queue.enqueue({ args: {}, functionPath: "mid", reject: () => undefined, resolve: () => undefined });
        queue.enqueue({ args: {}, functionPath: "new", reject: () => undefined, resolve: () => undefined });

        expect(queue.size).toBe(2);
        expect(rejected).toHaveBeenCalledTimes(1);

        const error = rejected.mock.calls[0]?.[0] as Error & { code?: string };

        expect(error.code).toBe("OFFLINE_QUEUE_OVERFLOW");

        const drained = queue.drain();

        expect(drained.map((d) => d.functionPath)).toEqual(["mid", "new"]);
    });

    it("invokes onEvict with the dropped entry and code on overflow", () => {
        expect.assertions(4);

        const onEvict = vi.fn<(entry: { functionPath: string; liveAwaiter?: boolean }, error: Error & { code?: string }) => void>();
        const queue = new OfflineQueue({ maxItems: 1 }, { onEvict });

        // A hydrated-style entry (no live awaiter) is evicted by a newer write.
        queue.enqueue({ args: {}, functionPath: "old", liveAwaiter: false, reject: () => undefined, resolve: () => undefined });
        queue.enqueue({ args: {}, functionPath: "new", liveAwaiter: true, reject: () => undefined, resolve: () => undefined });

        expect(onEvict).toHaveBeenCalledTimes(1);

        const [entry, error] = onEvict.mock.calls[0]!;

        expect(entry.functionPath).toBe("old");
        expect(entry.liveAwaiter).toBe(false);
        expect(error.code).toBe("OFFLINE_QUEUE_OVERFLOW");
    });

    it("requeue restores drained items to the front in FIFO order without re-persisting", async () => {
        expect.assertions(3);

        const persistence = createInMemoryPersistence();
        const queue = new OfflineQueue({}, { persistence });

        queue.enqueue({ args: {}, functionPath: "a", reject: () => undefined, resolve: () => undefined });
        queue.enqueue({ args: {}, functionPath: "b", reject: () => undefined, resolve: () => undefined });

        const drained = queue.drain();

        // A fresh write arrives while the drained pair is being replayed.
        queue.enqueue({ args: {}, functionPath: "c", reject: () => undefined, resolve: () => undefined });
        queue.requeue(drained);

        expect(queue.drain().map((d) => d.functionPath)).toEqual(["a", "b", "c"]);

        // requeue must not append again — the records were never unpersisted.
        const persisted = await persistence.load();

        expect(persisted.map((p) => p.functionPath)).toEqual(["a", "b", "c"]);
        expect(persisted).toHaveLength(3);
    });

    it("clear() rejects pending mutations with CLIENT_CLOSED and empties the queue", () => {
        expect.assertions(4);

        const queue = new OfflineQueue();
        const rejected = vi.fn<(error: unknown) => void>();

        queue.enqueue({ args: {}, functionPath: "a", reject: rejected, resolve: () => undefined });
        queue.clear();

        expect(queue.size).toBe(0);
        expect(rejected).toHaveBeenCalledTimes(1);

        const error = rejected.mock.calls[0]?.[0] as Error & { code?: string };

        expect(error.message).toBe("CLIENT_CLOSED");
        expect(error.code).toBe("CLIENT_CLOSED");
    });
});

describe("offlineQueue — persistence", () => {
    it("enqueue mirrors the mutation to durable storage with an assigned id", async () => {
        expect.assertions(4);

        const persistence = createInMemoryPersistence();
        const queue = new OfflineQueue({}, { persistence });

        queue.enqueue({ args: { title: "hi" }, functionPath: "posts:create", reject: () => undefined, resolve: () => undefined, shardKey: "room-1" });

        const persisted = await persistence.load();

        expect(persisted).toHaveLength(1);
        expect(persisted[0]).toMatchObject({ args: { title: "hi" }, functionPath: "posts:create", shardKey: "room-1" });
        // Runtime check that enqueue minted a non-empty string id. `toBeTypeOf`
        // (not `expectTypeOf`) is deliberate: the field is statically
        // `string | undefined`, so a compile-time type assertion would verify
        // nothing — we need to confirm an id was actually assigned at runtime.
        expect(persisted[0]?.id).toBeTypeOf("string");
        expect(persisted[0]?.id).not.toBe("");
    });

    it("enqueue persists the identity stamp alongside the record", async () => {
        expect.assertions(2);

        const persistence = createInMemoryPersistence();
        const append = vi.spyOn(persistence, "append");
        const queue = new OfflineQueue({}, { persistence });

        queue.enqueue({ args: {}, functionPath: "posts:create", identity: "1:abc", reject: () => undefined, resolve: () => undefined });

        expect(append).toHaveBeenCalledTimes(1);
        expect(append.mock.calls[0]?.[0]).toMatchObject({ functionPath: "posts:create", identity: "1:abc" });
    });

    it("hydrate restores the persisted identity stamp onto the queued item", async () => {
        expect.assertions(1);

        const persistence = createInMemoryPersistence();

        await persistence.append({ args: {}, functionPath: "a", identity: "1:abc", id: "1" });

        const queue = new OfflineQueue({}, { persistence });

        await queue.hydrate();

        const [restored] = queue.drain();

        expect(restored?.identity).toBe("1:abc");
    });

    it("a legacy record without an identity hydrates with identity === undefined", async () => {
        expect.assertions(1);

        const persistence = createInMemoryPersistence();

        await persistence.append({ args: {}, functionPath: "a", id: "1" });

        const queue = new OfflineQueue({}, { persistence });

        await queue.hydrate();

        const [restored] = queue.drain();

        expect(restored?.identity).toBeUndefined();
    });

    it("overflow un-persists the dropped (oldest) entry", async () => {
        expect.assertions(1);

        const persistence = createInMemoryPersistence();
        const queue = new OfflineQueue({ maxItems: 1 }, { persistence });

        queue.enqueue({ args: {}, functionPath: "old", reject: () => undefined, resolve: () => undefined });
        queue.enqueue({ args: {}, functionPath: "new", reject: () => undefined, resolve: () => undefined });

        const persisted = await persistence.load();

        expect(persisted.map((m) => m.functionPath)).toEqual(["new"]);
    });

    it("hydrate restores persisted mutations in FIFO order and reports distinct shard keys", async () => {
        expect.assertions(3);

        const persistence = createInMemoryPersistence();

        await persistence.append({ args: {}, functionPath: "a", id: "1", shardKey: "room-1" });
        await persistence.append({ args: {}, functionPath: "b", id: "2", shardKey: "room-2" });
        await persistence.append({ args: {}, functionPath: "c", id: "3", shardKey: "room-1" });

        const queue = new OfflineQueue({}, { persistence });
        const shardKeys = await queue.hydrate();

        expect(queue.size).toBe(3);
        expect(shardKeys.toSorted((a, b) => String(a).localeCompare(String(b)))).toEqual(["room-1", "room-2"]);

        const drained = queue.drain();

        expect(drained.map((d) => d.functionPath)).toEqual(["a", "b", "c"]);
    });

    it("hydrate omits the shard key of a restored mutation that eviction dropped", async () => {
        expect.assertions(2);

        const persistence = createInMemoryPersistence();

        // Two shards, one restored mutation each — "room-1" is the older
        // (oldest-first) record, so it's the one `evictOverflow` drops once
        // `maxItems: 1` caps the restored set down to a single surviving entry.
        await persistence.append({ args: {}, functionPath: "a", id: "1", shardKey: "room-1" });
        await persistence.append({ args: {}, functionPath: "b", id: "2", shardKey: "room-2" });

        const queue = new OfflineQueue({ maxItems: 1 }, { persistence });
        const shardKeys = await queue.hydrate();

        // Without a shard key for "room-1" left in the queue, a caller that
        // called `ensureSocket()` for every returned shard key would open a
        // socket for a shard with nothing left to flush.
        expect(shardKeys).toEqual(["room-2"]);

        const drained = queue.drain();

        expect(drained.map((d) => d.functionPath)).toEqual(["b"]);
    });

    it("hydrate splices restored prior-session writes ahead of a mutation enqueued during boot-time hydration (CLIENT-03)", async () => {
        expect.assertions(1);

        const persistence = createInMemoryPersistence();

        await persistence.append({ args: {}, functionPath: "old-session-write", id: "1" });

        const queue = new OfflineQueue({}, { persistence });

        // `hydrate()` starts its async durable-store load here; the following
        // `enqueue` runs synchronously in the same tick, before that load's
        // `await` resolves — simulating a mutation issued while offline during
        // boot, which the client enqueues before hydration (an async
        // microtask-deferred persistence load) finishes restoring the prior
        // session's older writes.
        const hydratePromise = queue.hydrate();

        queue.enqueue({ args: {}, functionPath: "boot-time-write", reject: () => undefined, resolve: () => undefined });

        await hydratePromise;

        // The restored older write must replay BEFORE the boot-time write, or
        // last-writer-wins on the server would let this session's write
        // silently get clobbered by the (out-of-order-replayed) older one.
        const drained = queue.drain();

        expect(drained.map((d) => d.functionPath)).toEqual(["old-session-write", "boot-time-write"]);
    });

    it("hydrate respects maxItems — evicts the oldest restored entries down to the cap (CLIENT-03)", async () => {
        expect.assertions(4);

        const persistence = createInMemoryPersistence();

        // Persist maxItems(3) + 5 = 8 records, oldest ("m0") first.
        for (let index = 0; index < 8; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- deterministic FIFO persist order across records is the point of this fixture
            await persistence.append({ args: {}, functionPath: `m${String(index)}`, id: `id-${String(index)}` });
        }

        const onEvict = vi.fn<(entry: { functionPath: string }, error: Error & { code?: string }) => void>();
        const queue = new OfflineQueue({ maxItems: 3 }, { onEvict, persistence });

        await queue.hydrate();

        // The in-memory queue never exceeds maxItems, regardless of how many
        // records the durable store held.
        expect(queue.size).toBe(3);

        // The evicted ones are the OLDEST (m0..m4) — FIFO order preserved, the
        // newest 3 (m5, m6, m7) survive.
        const drained = queue.drain();

        expect(drained.map((d) => d.functionPath)).toEqual(["m5", "m6", "m7"]);

        // Each eviction fired onEvict with OFFLINE_QUEUE_OVERFLOW, oldest-first.
        expect(onEvict).toHaveBeenCalledTimes(5);
        expect(onEvict.mock.calls.map((call) => call[0].functionPath)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    });

    it("hydrate overflow un-persists the evicted entries, and a subsequent enqueue overflows exactly once more (CLIENT-03)", async () => {
        expect.assertions(4);

        const persistence = createInMemoryPersistence();

        for (let index = 0; index < 5; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- deterministic FIFO persist order across records is the point of this fixture
            await persistence.append({ args: {}, functionPath: `m${String(index)}`, id: `id-${String(index)}` });
        }

        const queue = new OfflineQueue({ maxItems: 2 }, { persistence });

        await queue.hydrate();

        expect(queue.size).toBe(2);

        // The 3 evicted records (m0, m1, m2) are gone from durable storage too —
        // only the surviving pair remains.
        const persisted = await persistence.load();

        expect(persisted.map((m) => m.functionPath).toSorted((a, b) => a.localeCompare(b))).toEqual(["m3", "m4"]);

        // A single live enqueue past the (already-at-cap) queue evicts exactly
        // one MORE entry (the oldest surviving one, "m3") — the cap holds going
        // forward, no double-counting or leftover slack from the hydrate-time
        // trim, and no spurious extra eviction beyond the one this enqueue causes.
        queue.enqueue({ args: {}, functionPath: "new", reject: () => undefined, resolve: () => undefined });

        expect(queue.size).toBe(2);

        const drained = queue.drain();

        expect(drained.map((d) => d.functionPath)).toEqual(["m4", "new"]);
    });

    it("hydrate re-appends nothing and skips ids already queued", async () => {
        expect.assertions(1);

        const persistence = createInMemoryPersistence();

        await persistence.append({ args: {}, functionPath: "a", id: "1" });

        const queue = new OfflineQueue({}, { persistence });

        await queue.hydrate();
        // A second hydrate (or one after the live enqueue assigned the same id)
        // must not duplicate the entry.
        await queue.hydrate();

        expect(queue.size).toBe(1);
    });

    it("hydrate restores a single copy when the durable store holds duplicate ids", async () => {
        expect.assertions(1);

        // The in-memory adapter keys by id, so a duplicate-bearing load needs a
        // hand-rolled stub (AsyncStorage's append-only log CAN hold duplicates).
        const persistence: PersistenceAdapter = {
            append: () => Promise.resolve(),
            clear: () => Promise.resolve(),
            load: () =>
                Promise.resolve([
                    { args: {}, functionPath: "a", id: "1" },
                    { args: {}, functionPath: "a", id: "1" },
                ]),
            remove: () => Promise.resolve(),
            replace: () => Promise.resolve(),
        };

        const queue = new OfflineQueue({}, { persistence });

        await queue.hydrate();

        expect(queue.size).toBe(1);
    });

    it("restored mutations carry no-op resolve/reject so replay can settle them", async () => {
        expect.assertions(1);

        const persistence = createInMemoryPersistence();

        await persistence.append({ args: {}, functionPath: "a", id: "1" });

        const queue = new OfflineQueue({}, { persistence });

        await queue.hydrate();

        const [restored] = queue.drain();

        expect(() => {
            restored?.resolve(undefined);
            restored?.reject(new Error("ignored"));
        }).not.toThrow();
    });

    it("clear() leaves durable storage intact so a future session can restore it", async () => {
        expect.assertions(2);

        const persistence = createInMemoryPersistence();
        const queue = new OfflineQueue({}, { persistence });

        queue.enqueue({ args: {}, functionPath: "a", reject: () => undefined, resolve: () => undefined });
        queue.clear();

        expect(queue.size).toBe(0);
        await expect(persistence.load()).resolves.toHaveLength(1);
    });
});

describe("offlineQueue — persistence error reporting", () => {
    it("restampIdentity rewrites the record atomically — the mutation is never absent from durable storage", async () => {
        expect.assertions(3);

        const base = createInMemoryPersistence();

        await base.append({ args: {}, functionPath: "posts:create", id: "1", identity: "old" });

        // This used to be `remove` then `append`, and the window between them is
        // not something compensation can close: a process stop after the remove
        // commits leaves the mutation in NO durable store, while the in-memory
        // entry has already advanced to the new stamp. A `remove` that never
        // happens is the only version of this that survives a crash.
        const removals: string[] = [];
        const persistence: PersistenceAdapter = {
            ...base,
            remove: async (id) => {
                removals.push(id);

                return base.remove(id);
            },
        };
        const queue = new OfflineQueue({}, { persistence });

        await queue.hydrate();

        queue.restampIdentity("old", "new");

        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        const persisted = await base.load();

        expect(removals).toStrictEqual([]);
        expect(persisted).toHaveLength(1);
        expect(persisted[0]?.identity).toBe("new");
    });

    it("restampIdentity keeps the record's place in FIFO order", async () => {
        expect.assertions(1);

        const persistence = createInMemoryPersistence();

        await persistence.append({ args: {}, functionPath: "posts:create", id: "1", identity: "old" });
        await persistence.append({ args: {}, functionPath: "posts:create", id: "2", identity: "other" });

        // Removing and re-appending put the restamped write at the BACK of the
        // queue, so a reload replayed it after writes it was issued before.
        const queue = new OfflineQueue({}, { persistence });

        await queue.hydrate();

        queue.restampIdentity("old", "new");

        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        await expect(persistence.load().then((loaded) => loaded.map((record) => record.id))).resolves.toStrictEqual(["1", "2"]);
    });

    it("restampIdentity leaves the record under its old stamp when the rewrite rejects, and reports it as 'replace'", async () => {
        expect.assertions(3);

        const base = createInMemoryPersistence();

        await base.append({ args: {}, functionPath: "posts:create", id: "1", identity: "old" });

        const replaceError = new Error("quota");
        // A rejected `replace` changed nothing durably: the record stands under
        // its old stamp, which a replay refuses with `OFFLINE_IDENTITY_CHANGED`
        // — visible and recoverable, unlike a silent loss. So there is nothing to
        // compensate, only to report, and it is reported under the op that failed.
        const persistence: PersistenceAdapter = { ...base, replace: () => Promise.reject(replaceError) };
        const handler = vi.fn<(context: PersistenceErrorContext) => void>();
        const queue = new OfflineQueue({ onPersistenceError: handler }, { persistence });

        await queue.hydrate();

        queue.restampIdentity("old", "new");

        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0]?.[0]).toMatchObject({ error: replaceError, operation: "replace" });

        const persisted = await base.load();

        expect(persisted[0]?.identity).toBe("old");
    });

    it("append failure invokes onPersistenceError handler with operation 'append'", async () => {
        expect.assertions(3);

        const appendError = new Error("quota");
        const faultyPersistence = {
            ...createInMemoryPersistence(),
            append: () => Promise.reject(appendError),
        };
        const handler = vi.fn<(context: PersistenceErrorContext) => void>();
        const queue = new OfflineQueue({ onPersistenceError: handler }, { persistence: faultyPersistence });

        queue.enqueue({ args: {}, functionPath: "posts:create", reject: () => undefined, resolve: () => undefined });

        // Allow the rejected promise microtask to settle
        await Promise.resolve();

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0]?.[0]?.operation).toBe("append");
        expect(handler.mock.calls[0]?.[0]?.error).toBe(appendError);
    });

    it("append failure passes the assigned mutationId to the handler", async () => {
        expect.assertions(2);

        const faultyPersistence = {
            ...createInMemoryPersistence(),
            append: () => Promise.reject(new Error("quota")),
        };
        const handler = vi.fn<(context: PersistenceErrorContext) => void>();
        const queue = new OfflineQueue({ onPersistenceError: handler }, { persistence: faultyPersistence });

        queue.enqueue({ args: {}, functionPath: "posts:create", reject: () => undefined, resolve: () => undefined });

        await Promise.resolve();

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0]?.[0]?.mutationId).toBeTypeOf("string");
    });

    it("append failure falls back to console.warn when no handler is configured", async () => {
        expect.assertions(2);

        const appendError = new Error("quota");
        const faultyPersistence = {
            ...createInMemoryPersistence(),
            append: () => Promise.reject(appendError),
        };
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        try {
            const queue = new OfflineQueue({}, { persistence: faultyPersistence });

            queue.enqueue({ args: {}, functionPath: "posts:create", reject: () => undefined, resolve: () => undefined });

            await Promise.resolve();

            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy.mock.calls[0]?.[0]).toContain("[lunora] offline-queue persistence append failed");
        } finally {
            warnSpy.mockRestore();
        }
    });

    it("happy path does not invoke the handler when append succeeds", async () => {
        expect.assertions(1);

        const persistence = createInMemoryPersistence();
        const handler = vi.fn<(context: PersistenceErrorContext) => void>();
        const queue = new OfflineQueue({ onPersistenceError: handler }, { persistence });

        queue.enqueue({ args: {}, functionPath: "posts:create", reject: () => undefined, resolve: () => undefined });

        await Promise.resolve();

        expect(handler).not.toHaveBeenCalled();
    });

    it("overflow remove failure invokes handler with operation 'remove'", async () => {
        expect.assertions(2);

        const removeError = new Error("remove failed");
        const faultyPersistence = {
            ...createInMemoryPersistence(),
            remove: () => Promise.reject(removeError),
        };
        const handler = vi.fn<(context: PersistenceErrorContext) => void>();
        const queue = new OfflineQueue({ maxItems: 1, onPersistenceError: handler }, { persistence: faultyPersistence });

        queue.enqueue({ args: {}, functionPath: "old", reject: () => undefined, resolve: () => undefined });
        queue.enqueue({ args: {}, functionPath: "new", reject: () => undefined, resolve: () => undefined });

        // Allow both the append and remove promise rejections to settle
        await Promise.resolve();
        await Promise.resolve();

        const removeCalls = handler.mock.calls.filter((call) => call[0]?.operation === "remove");

        expect(removeCalls).toHaveLength(1);
        expect(removeCalls[0]?.[0]?.error).toBe(removeError);
    });

    it("hydrate load failure invokes handler with operation 'load' and rejects", async () => {
        expect.assertions(4);

        const loadError = new Error("indexeddb unavailable");
        const faultyPersistence = {
            ...createInMemoryPersistence(),
            load: () => Promise.reject(loadError),
        };
        const handler = vi.fn<(context: PersistenceErrorContext) => void>();
        const queue = new OfflineQueue({ onPersistenceError: handler }, { persistence: faultyPersistence });

        await expect(queue.hydrate()).rejects.toBe(loadError);

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0]?.[0]?.operation).toBe("load");
        expect(handler.mock.calls[0]?.[0]?.error).toBe(loadError);
    });
});
