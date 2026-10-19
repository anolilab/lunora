import { afterEach, describe, expect, it, vi } from "vitest";

import type { SyncStatus } from "../src/lunora-client";
import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import { createInMemoryQueryCache, queryCacheKey } from "../src/query-cache";
import type { HarnessSocket } from "./lib/harness";
import { createSocketHarness, fnRef, jsonResponse, settle } from "./lib/harness";

/** One reconnect backoff step: long enough to arm the next socket, short enough to disturb nothing else. */
const STEP_MS = 20;

const FAST_RECONNECT = { initialDelayMs: 10, jitter: false, maxDelayMs: 10 } as const;

/** Drive `count` connect attempts that never reach `open`. */
const failOpens = async (sockets: HarnessSocket[], count: number): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
        sockets.at(-1)?.triggerClose();
        // eslint-disable-next-line no-await-in-loop -- each attempt must settle before the backoff timer for the next one is armed
        await vi.advanceTimersByTimeAsync(STEP_MS);
    }
};

/** An acked `todos.list` subscription on an open socket, nothing listening for sync status yet. */
const ackedClient = async () => {
    const { sockets, WebSocket } = createSocketHarness();
    const client = new LunoraClient({
        fetch: vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } })),
        heartbeatIntervalMs: 0,
        url: "http://app.test",
        WebSocket,
    });

    client.subscribe(fnRef("todos.list"), {}, () => undefined);
    await settle();
    sockets[0]?.open();
    await settle();
    sockets[0]?.receive({ id: sockets[0]?.frames()[0]?.id, type: "ack" });

    return { client, sockets };
};

const poke = (socket: HarnessSocket | undefined, shapeId: string | undefined, checkpoint: number, baseCheckpoint?: number): void => {
    const pokeId = `poke-${checkpoint.toString()}`;

    socket?.receive({ ...(baseCheckpoint === undefined ? {} : { baseCheckpoint }), epoch: "e1", pokeId, type: "pokeStart" });
    socket?.receive({ pokeId, rowsPatch: [], shapeId, type: "pokePart" });
    socket?.receive({ checkpoint, epoch: "e1", pokeId, type: "pokeEnd" });
};

describe("sync status cost", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("computes no sync status per frame while nobody listens", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const { client, sockets } = await ackedClient();
        const id = sockets[0]?.frames()[0]?.id;
        const compute = vi.spyOn(client, "syncStatus");

        for (let cursor = 1; cursor <= 3; cursor += 1) {
            sockets[0]?.receive({ cursor, epoch: "e1", id, type: "resume" });
            sockets[0]?.receive({ cursor: cursor + 10, epoch: "e1", id, type: "settled" });
            sockets[0]?.receive({ id, type: "ack" });
        }

        expect(compute).not.toHaveBeenCalled();

        client.close();
    });

    it("emits once per real change, and recomputes nothing for a frame that changes nothing", async () => {
        expect.assertions(4);

        vi.useFakeTimers();

        const { sockets, WebSocket } = createSocketHarness();
        const client = new LunoraClient({ fetch: vi.fn<typeof fetch>(), heartbeatIntervalMs: 0, url: "http://app.test", WebSocket });
        const seen: SyncStatus[] = [];
        const compute = vi.spyOn(client, "syncStatus");

        client.onSyncStatus((status) => seen.push(status));
        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        await settle();

        const id = sockets[0]?.frames()[0]?.id;

        // idle, then pending, then the socket connecting, then connected-but-unacked.
        expect(seen.map((status) => [status.connection, status.pendingSubscriptions])).toStrictEqual([
            ["idle", 0],
            ["idle", 1],
            ["connecting", 1],
            ["connected", 1],
        ]);

        sockets[0]?.receive({ id, type: "ack" });

        expect(seen.at(-1)).toStrictEqual({ connection: "connected", pendingSubscriptions: 0, pendingWrites: 0, synced: true });

        const before = seen.length;

        compute.mockClear();

        for (let cursor = 1; cursor <= 3; cursor += 1) {
            sockets[0]?.receive({ cursor, epoch: "e1", id, type: "resume" });
            sockets[0]?.receive({ cursor: cursor + 10, epoch: "e1", id, type: "settled" });
            sockets[0]?.receive({ id, type: "ack" });
        }

        expect(seen).toHaveLength(before);
        expect(compute).not.toHaveBeenCalled();

        client.close();
    });

    it("computes nothing for a poke that answers an already answered shape, even with a listener", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const { client, sockets } = await ackedClient();

        client.subscribeShape({ name: "messages" }, () => undefined);
        await settle();

        const shapeId = sockets[0]?.frames().find((frame) => frame.type === "shape_subscribe")?.id;
        const seen: SyncStatus[] = [];

        client.onSyncStatus((status) => seen.push(status));
        poke(sockets[0], shapeId, 5);

        expect(seen.at(-1)).toMatchObject({ pendingSubscriptions: 0, synced: true });

        const compute = vi.spyOn(client, "syncStatus");

        poke(sockets[0], shapeId, 6, 5);
        poke(sockets[0], shapeId, 7, 6);

        expect(compute).not.toHaveBeenCalled();

        client.close();
    });

    it("tells a listener added after silent changes about the current state, then about the next real change", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const { client, sockets } = await ackedClient();
        const first: SyncStatus[] = [];
        const stop = client.onSyncStatus((status) => first.push(status));

        // A real change while listening, so what is remembered is a live "synced".
        client.subscribe(fnRef("todos.other"), {}, () => undefined);
        await settle();
        sockets[0]?.receive({ id: sockets[0]?.frames().filter((frame) => frame.type === "subscribe")[1]?.id, type: "ack" });

        expect(first.at(-1)).toMatchObject({ pendingSubscriptions: 0, synced: true });

        stop();
        // Nobody is listening, so nothing is computed and what was remembered goes on describing a state that has passed.
        client.subscribe(fnRef("todos.third"), {}, () => undefined);
        await settle();

        const second: SyncStatus[] = [];

        client.onSyncStatus((status) => second.push(status));

        expect(second.at(-1)).toMatchObject({ pendingSubscriptions: 1, synced: false });

        // Back to the state the remembered status described: the second listener must still be told.
        sockets[0]?.receive({ id: sockets[0]?.frames().filter((frame) => frame.type === "subscribe")[2]?.id, type: "ack" });

        expect(second.at(-1)).toMatchObject({ pendingSubscriptions: 0, synced: true });

        client.close();
    });
});

describe("sync status of an ackless subscription", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("does not count a cached value as the answer of a polling connection", async () => {
        expect.assertions(5);

        vi.useFakeTimers();

        const { sockets, WebSocket } = createSocketHarness();
        const cache = createInMemoryQueryCache();

        // Written while signed out, so it matches this signed-out client.
        await cache.put(queryCacheKey("messages:list", "{}"), { identity: null, serverCursor: 7, ts: 1, value: { count: 1 } });

        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
            const { calls } = JSON.parse(init?.body as string) as { calls: unknown[] };

            return jsonResponse({
                results: calls.map((_call, id) => {
                    return { body: { result: { count: 2 } }, id, status: 200 };
                }),
            });
        });
        const client = new LunoraClient({
            fetch: fetchImpl,
            heartbeatIntervalMs: 0,
            pollingFallback: { afterFailedAttempts: 2, intervalMs: 1000 },
            queryCache: cache,
            reconnect: FAST_RECONNECT,
            url: "https://app.example",
            WebSocket,
        });
        const seen: SyncStatus[] = [];

        await settle();
        // The first poll is what proves the origin is reachable, which is what makes the status `polling`.
        client.subscribe(fnRef("other:list"), {}, () => undefined);
        await failOpens(sockets, 2);
        await settle();
        client.onSyncStatus((status) => seen.push(status));

        expect(client.syncStatus()).toMatchObject({ connection: "polling", pendingSubscriptions: 0, synced: true });

        // Opened while polling, over a hydrated cache: the cached value is on screen, nothing has been polled for it.
        client.subscribe(fnRef("messages:list"), {}, () => undefined);

        expect(client.syncStatus()).toMatchObject({ connection: "polling", pendingSubscriptions: 1, synced: false });

        await vi.advanceTimersByTimeAsync(1000);

        expect(client.syncStatus()).toMatchObject({ connection: "polling", pendingSubscriptions: 0, synced: true });
        expect(seen.at(-1)).toMatchObject({ connection: "polling", pendingSubscriptions: 0, synced: true });

        // A reconnect attempt that fails while polling replaces nothing: the poll's answer stands.
        await failOpens(sockets, 1);

        expect(client.syncStatus()).toMatchObject({ connection: "polling", pendingSubscriptions: 0, synced: true });

        client.close();
    });
});

describe("sync status of a refused poll slot", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("stops counting a query a poll refused or could not encode, and counts it again on the next connection", async () => {
        expect.assertions(6);

        vi.useFakeTimers();

        const { sockets, WebSocket } = createSocketHarness();
        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
            const { calls } = JSON.parse(init?.body as string) as { calls: { functionPath: string }[] };

            return jsonResponse({
                results: calls.map(({ functionPath }, id) =>
                    functionPath === "denied:list"
                        ? { body: { error: { code: "FORBIDDEN", message: "denied" } }, id, status: 403 }
                        : { body: { result: { count: 2 } }, id, status: 200 },
                ),
            });
        });
        const client = new LunoraClient({
            fetch: fetchImpl,
            heartbeatIntervalMs: 0,
            pollingFallback: { afterFailedAttempts: 2, intervalMs: 1000 },
            reconnect: FAST_RECONNECT,
            url: "https://app.example",
            WebSocket,
        });
        const seen: SyncStatus[] = [];
        const errors: string[] = [];
        const onError = (error: { code?: string }): void => {
            errors.push(error.code ?? "unknown");
        };
        const filter: Record<string, unknown> = {};

        client.onSyncStatus((status) => seen.push(status));
        client.subscribe(fnRef("denied:list"), {}, () => undefined, { onError });
        client.subscribe(fnRef("search:list"), { filter }, () => undefined, { onError });
        // The caller mutates its args after subscribing, to a value the codec refuses.
        filter.pattern = /x/u;
        await settle();
        await failOpens(sockets, 2);
        await settle();

        expect(client.connectionStatus()).toBe("polling");
        expect(errors.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["FORBIDDEN", "WIRE_ENCODE_FAILED"]);
        // Both refusals answered their request: neither stays pending for as long as the shard polls.
        expect(client.syncStatus()).toMatchObject({ pendingSubscriptions: 0, synced: true });
        expect(seen.at(-1)).toMatchObject({ pendingSubscriptions: 0, synced: true });

        // A later connection answers for itself: the old refusals are not its verdict.
        sockets.at(-1)?.open();
        await settle();

        expect(client.syncStatus()).toMatchObject({ pendingSubscriptions: 2, synced: false });
        expect(seen.at(-1)).toMatchObject({ pendingSubscriptions: 2, synced: false });

        client.close();
    });
});

describe("sync status across shards", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("counts a polling shard's delivered value even while another shard holds an open socket", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const { sockets, WebSocket } = createSocketHarness();
        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
            const { calls } = JSON.parse(init?.body as string) as { calls: unknown[] };

            return jsonResponse({
                results: calls.map((_call, id) => {
                    return { body: { result: { count: 2 } }, id, status: 200 };
                }),
            });
        });
        const client = new LunoraClient({
            fetch: fetchImpl,
            heartbeatIntervalMs: 0,
            pollingFallback: { afterFailedAttempts: 2, intervalMs: 1000 },
            reconnect: FAST_RECONNECT,
            url: "https://app.example",
            WebSocket,
        });

        // Shard A: an open socket, acked.
        client.subscribe(fnRef("todos.list"), {}, () => undefined, { shardKey: "a" });
        await settle();
        sockets[0]?.open();
        await settle();
        sockets[0]?.receive({ id: sockets[0]?.frames()[0]?.id, type: "ack" });

        // Shard B never reaches `open`, so it falls back to polling.
        client.subscribe(fnRef("messages.list"), {}, () => undefined, { shardKey: "b" });
        await settle();
        await failOpens(sockets, 2);
        await settle();

        // The first poll is what proves the origin reachable, and it already delivered shard B's value.
        expect(client.syncStatus()).toMatchObject({ connection: "connected", pendingSubscriptions: 0, synced: true });

        // An acked socket is not evidence for the other shard: a fresh subscription on B waits for its own poll.
        client.subscribe(fnRef("other.list"), {}, () => undefined, { shardKey: "b" });

        expect(client.syncStatus()).toMatchObject({ connection: "connected", pendingSubscriptions: 1, synced: false });

        await vi.advanceTimersByTimeAsync(1000);

        expect(client.syncStatus()).toMatchObject({ connection: "connected", pendingSubscriptions: 0, synced: true });

        client.close();
    });
});

describe("sync status of queued writes in flight", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("keeps counting a write the flush has sent and not yet settled", async () => {
        expect.assertions(5);

        vi.useFakeTimers();

        const { sockets, WebSocket } = createSocketHarness();
        const reply = Promise.withResolvers<Response>();
        const fetchImpl = vi.fn<typeof fetch>(async () => reply.promise);
        const client = new LunoraClient({
            fetch: fetchImpl,
            heartbeatIntervalMs: 0,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence: createInMemoryPersistence(),
            url: "http://app.test",
            WebSocket,
        });
        const seen: SyncStatus[] = [];

        client.mutation(fnRef("todos.set"), { text: "a" }).catch(() => undefined);
        await settle();

        client.onSyncStatus((status) => seen.push(status));
        sockets[0]?.open();
        await settle();

        // The queue has handed the write to the replay request, which has not answered.
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(client.syncStatus()).toMatchObject({ pendingWrites: 1, synced: false });
        expect(seen.some((status) => status.connection === "connected" && status.synced)).toBe(false);

        reply.resolve(jsonResponse({ result: { ok: true } }));
        await settle();

        expect(client.syncStatus()).toMatchObject({ pendingWrites: 0, synced: true });
        expect(seen.at(-1)).toMatchObject({ pendingWrites: 0, synced: true });

        client.close();
    });

    it("keeps counting every write of a batched replay until the batch answers", async () => {
        expect.assertions(4);

        vi.useFakeTimers();

        const { sockets, WebSocket } = createSocketHarness();
        const reply = Promise.withResolvers<Response>();
        const fetchImpl = vi.fn<typeof fetch>(async () => reply.promise);
        const client = new LunoraClient({
            fetch: fetchImpl,
            heartbeatIntervalMs: 0,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence: createInMemoryPersistence(),
            url: "http://app.test",
            WebSocket,
        });

        client.mutation(fnRef("todos.set"), { text: "a" }).catch(() => undefined);
        client.mutation(fnRef("todos.set"), { text: "b" }).catch(() => undefined);
        await settle();
        sockets[0]?.open();
        await settle();

        // Two queued writes ride one `/rpc-batch` request.
        expect(vi.mocked(fetchImpl).mock.calls[0]?.[0] as string).toContain("rpc-batch");
        expect(client.syncStatus()).toMatchObject({ pendingWrites: 2, synced: false });

        reply.resolve(
            jsonResponse({
                results: [
                    { body: { result: { ok: true } }, id: 0, status: 200 },
                    { body: { result: { ok: true } }, id: 1, status: 200 },
                ],
            }),
        );
        await settle();

        expect(client.syncStatus()).toMatchObject({ pendingWrites: 0, synced: true });
        expect(client.pendingCount()).toBe(0);

        client.close();
    });

    it("counts the write again as queued when the replay fails transiently", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const { sockets, WebSocket } = createSocketHarness();
        const fetchImpl = vi.fn<typeof fetch>(async () => {
            throw new TypeError("network down");
        });
        const client = new LunoraClient({
            fetch: fetchImpl,
            heartbeatIntervalMs: 0,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence: createInMemoryPersistence(),
            url: "http://app.test",
            WebSocket,
        });

        client.mutation(fnRef("todos.set"), { text: "a" }).catch(() => undefined);
        await settle();
        sockets[0]?.open();
        await settle();

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(client.pendingCount()).toBe(1);
        expect(client.syncStatus()).toMatchObject({ pendingWrites: 1, synced: false });

        client.close();
    });
});

describe("sync status across a leadership change", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("tells listeners when a follower with nothing subscribed becomes the leader", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        let deliver: (message: unknown) => void = vi.fn<(message: unknown) => void>();

        class FakeChannel {
            // eslint-disable-next-line class-methods-use-this -- test double
            public addEventListener(_type: string, handler: (event: { data: unknown }) => void): void {
                deliver = (message) => {
                    handler({ data: message });
                };
            }

            // eslint-disable-next-line class-methods-use-this -- test double
            public close(): void {}

            // eslint-disable-next-line class-methods-use-this -- test double
            public postMessage(): void {}
        }

        vi.stubGlobal("BroadcastChannel", FakeChannel);

        const { WebSocket } = createSocketHarness();
        const client = new LunoraClient({ crossTabSync: true, fetch: vi.fn<typeof fetch>(), heartbeatIntervalMs: 0, url: "http://app.test", WebSocket });
        const seen: SyncStatus[] = [];

        client.onSyncStatus((status) => seen.push(status));
        // The leader we mirror reports a live connection.
        deliver({ status: "connected", tabId: "other-tab", type: "connection-status" });

        expect(seen.at(-1)).toMatchObject({ connection: "connected" });

        // Nobody answers the claim, so this tab takes over: it owns no socket and has nothing to wait for.
        await vi.advanceTimersByTimeAsync(3500);

        expect(client.syncStatus()).toMatchObject({ connection: "idle" });
        expect(seen.at(-1)).toMatchObject({ connection: "idle" });

        client.close();
    });

    it("stops counting a demoted leader's socket answers, for queries and shapes alike", async () => {
        expect.assertions(4);

        vi.useFakeTimers();

        const handlers: ((event: { data: unknown }) => void)[] = [];

        class FakeChannel {
            // eslint-disable-next-line class-methods-use-this -- test double
            public addEventListener(_type: string, handler: (event: { data: unknown }) => void): void {
                handlers.push(handler);
            }

            // eslint-disable-next-line class-methods-use-this -- test double
            public close(): void {}

            // eslint-disable-next-line class-methods-use-this -- test double
            public postMessage(): void {}
        }

        vi.stubGlobal("BroadcastChannel", FakeChannel);

        const { sockets, WebSocket } = createSocketHarness();
        const client = new LunoraClient({ crossTabSync: true, fetch: vi.fn<typeof fetch>(), heartbeatIntervalMs: 0, url: "http://app.test", WebSocket });
        const seen: SyncStatus[] = [];

        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        client.subscribeShape({ name: "messages" }, () => undefined);
        // Nobody answers the claim, so this tab leads and opens its socket.
        await vi.advanceTimersByTimeAsync(3500);
        sockets[0]?.open();
        await settle();
        sockets[0]?.receive({ id: sockets[0]?.frames().find((frame) => frame.type === "subscribe")?.id, type: "ack" });
        poke(sockets[0], sockets[0]?.frames().find((frame) => frame.type === "shape_subscribe")?.id, 5);
        client.onSyncStatus((status) => seen.push(status));

        expect(seen.at(-1)).toMatchObject({ connection: "connected", pendingSubscriptions: 0, synced: true });

        // A tab that outranks this one claims the leadership: this socket closes with both answers on it.
        for (const handler of handlers) {
            handler({ data: { tabId: "aaa-leader-tab", ts: Date.now(), type: "heartbeat" } });
        }

        expect(client.syncStatus()).toMatchObject({ pendingSubscriptions: 2, synced: false });
        expect(seen.at(-1)).toMatchObject({ pendingSubscriptions: 2, synced: false });

        // The new leader delivers the query's value, which is what answers it again; nothing has answered the shape.
        for (const handler of handlers) {
            handler({ data: { data: [], key: "todos.list::{}::", tabId: "aaa-leader-tab", type: "subscription-data" } });
        }

        expect(client.syncStatus()).toMatchObject({ pendingSubscriptions: 1, synced: false });

        client.close();
    });

    it("keeps a follower pending on a settled frame alone, and synced once a value arrives", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const handlers: ((event: { data: unknown }) => void)[] = [];

        class FakeChannel {
            // eslint-disable-next-line class-methods-use-this -- test double
            public addEventListener(_type: string, handler: (event: { data: unknown }) => void): void {
                handlers.push(handler);
            }

            // eslint-disable-next-line class-methods-use-this -- test double
            public close(): void {}

            // eslint-disable-next-line class-methods-use-this -- test double
            public postMessage(): void {}
        }

        vi.stubGlobal("BroadcastChannel", FakeChannel);

        const { WebSocket } = createSocketHarness();
        const client = new LunoraClient({ crossTabSync: true, fetch: vi.fn<typeof fetch>(), heartbeatIntervalMs: 0, url: "http://app.test", WebSocket });
        const send = (data: unknown): void => {
            for (const handler of handlers) {
                handler({ data });
            }
        };

        // A tab that outranks this one leads, so this tab follows it.
        send({ tabId: "aaa-leader-tab", ts: Date.now(), type: "heartbeat" });
        send({ status: "connected", tabId: "aaa-leader-tab", type: "connection-status" });
        client.subscribe(fnRef("todos.list"), {}, () => undefined);

        // The leader's snapshot went out before this tab subscribed; only a later settled frame reaches it.
        send({ cursor: 3, epoch: "e1", key: "todos.list::{}::", tabId: "aaa-leader-tab", type: "subscription-settled" });

        expect(client.syncStatus()).toMatchObject({ pendingSubscriptions: 1, synced: false });

        send({ data: [], key: "todos.list::{}::", tabId: "aaa-leader-tab", type: "subscription-data" });

        expect(client.syncStatus()).toMatchObject({ pendingSubscriptions: 0, synced: true });

        // A later settled frame changes nothing about an answered subscription.
        send({ cursor: 4, epoch: "e1", key: "todos.list::{}::", tabId: "aaa-leader-tab", type: "subscription-settled" });

        expect(client.syncStatus()).toMatchObject({ pendingSubscriptions: 0 });

        client.close();
    });
});
