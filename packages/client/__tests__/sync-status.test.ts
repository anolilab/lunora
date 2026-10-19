import { afterEach, describe, expect, it, vi } from "vitest";

import type { SyncStatus } from "../src/lunora-client";
import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import type { SubscriptionState } from "../src/subscription";
import type { TabLeadershipHost } from "../src/tab-leadership";
import { onFollowerSubscriptionData } from "../src/tab-leadership";
import type { HarnessSocket } from "./lib/harness";
import { createSocketHarness, fnRef, jsonResponse, settle } from "./lib/harness";

const createClient = (options: { offline?: boolean } = {}) => {
    const { sockets, WebSocket } = createSocketHarness();
    const client = new LunoraClient({
        fetch: vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } })),
        heartbeatIntervalMs: 0,
        ...(options.offline ? { offlineQueue: { queueBeforeFirstConnect: true }, persistence: createInMemoryPersistence() } : {}),
        url: "http://app.test",
        WebSocket,
    });

    return { client, sockets };
};

describe("sync status", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("does not read as synced while a subscription is connected but unacknowledged", async () => {
        expect.assertions(6);

        vi.useFakeTimers();

        const { client, sockets } = createClient();

        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        await settle();

        // The socket is open, which is all `connectionStatus()` looks at.
        expect(client.connectionStatus()).toBe("connected");
        expect(client.syncStatus()).toStrictEqual({ connection: "connected", pendingSubscriptions: 1, pendingWrites: 0, synced: false });

        const [frame] = sockets[0]?.frames() ?? [];

        sockets[0]?.receive({ id: frame?.id, type: "ack" });

        expect(client.syncStatus()).toStrictEqual({ connection: "connected", pendingSubscriptions: 0, pendingWrites: 0, synced: true });

        // A reconnect un-acks everything until the server answers again.
        sockets[0]?.triggerClose();

        expect(client.syncStatus().synced).toBe(false);
        expect(client.syncStatus().pendingSubscriptions).toBe(1);
        expect(client.syncStatus().connection).not.toBe("connected");

        client.close();
    });

    it("does not read as synced while a write is queued", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const { client, sockets } = createClient({ offline: true });

        client.mutation(fnRef("todos.set"), { text: "a" }).catch(() => undefined);
        await settle();

        expect(client.syncStatus().pendingWrites).toBe(1);

        sockets[0]?.open();
        await settle();

        // Flushed over HTTP and nothing is subscribed: nothing left to wait for.
        expect(client.syncStatus()).toMatchObject({ pendingWrites: 0, synced: true });

        client.close();
    });

    it("notifies listeners as acknowledgements and the queue move", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const { client, sockets } = createClient();
        const seen: SyncStatus[] = [];

        client.onSyncStatus((status) => {
            seen.push(status);
        });
        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        await settle();

        const [frame] = sockets[0]?.frames() ?? [];

        sockets[0]?.receive({ id: frame?.id, type: "ack" });

        expect(seen.at(-1)?.synced).toBe(true);
        expect(seen.some((status) => !status.synced && status.connection === "connected")).toBe(true);

        client.close();
    });

    it("tells a follower tab's listeners when its first value arrives, since it sees no acknowledgement", () => {
        expect.assertions(1);

        const state = { callbacks: new Set(), optimisticLayers: [], serverBase: undefined } as unknown as SubscriptionState;
        const emitConnectionStatus = vi.fn<() => void>();
        const host = {
            dropCacheSeed: () => undefined,
            emitConnectionStatus,
            identityFingerprint: () => null,
            subscription: () => state,
        } as unknown as TabLeadershipHost;

        onFollowerSubscriptionData(host, "key", { n: 1 }, undefined, undefined, undefined);
        // Later frames change no answered-count, so they do not re-announce.
        onFollowerSubscriptionData(host, "key", { n: 2 }, undefined, undefined, undefined);

        expect(emitConnectionStatus).toHaveBeenCalledTimes(1);
    });

    it("hands back the same ready promise to callers that pass no signal", () => {
        expect.assertions(1);

        const { client } = createClient();

        expect(client.whenReady()).toBe(client.whenReady());

        client.close();
    });
});

/** Deliver one poke carrying no rows to `shapeId`, committed at `checkpoint` on top of `baseCheckpoint`. */
const poke = (socket: HarnessSocket | undefined, shapeId: string | undefined, checkpoint: number, baseCheckpoint?: number): void => {
    const pokeId = `poke-${checkpoint.toString()}`;

    socket?.receive({ ...(baseCheckpoint === undefined ? {} : { baseCheckpoint }), epoch: "e1", pokeId, type: "pokeStart" });
    socket?.receive({ pokeId, rowsPatch: [], shapeId, type: "pokePart" });
    socket?.receive({ checkpoint, epoch: "e1", pokeId, type: "pokeEnd" });
};

const shapeIdOf = (socket: HarnessSocket | undefined): string | undefined => socket?.frames().find((frame) => frame.type === "shape_subscribe")?.id;

describe("sync status listeners", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("counts a shape as unanswered after a reconnect even though it kept its resume cursor", async () => {
        expect.assertions(5);

        vi.useFakeTimers();

        const { client, sockets } = createClient();
        const seen: SyncStatus[] = [];

        client.onSyncStatus((status) => {
            seen.push(status);
        });
        client.subscribeShape({ name: "messages" }, () => undefined);
        await settle();
        sockets[0]?.open();
        await settle();
        poke(sockets[0], shapeIdOf(sockets[0]), 5);

        expect(client.syncStatus()).toMatchObject({ pendingSubscriptions: 0, synced: true });

        sockets[0]?.triggerClose();

        // Wait out the reconnect backoff, stopping at the first new socket.
        while (sockets.length < 2) {
            // eslint-disable-next-line no-await-in-loop -- each step must run before the next check
            await vi.advanceTimersByTimeAsync(100);
        }

        const reconnected = sockets[1];

        reconnected?.open();
        await settle();

        // The new socket's `shape_subscribe` has not been answered, whatever cursor rides it.
        expect(reconnected?.frames().find((frame) => frame.type === "shape_subscribe")).toMatchObject({ sinceCheckpoint: 5 });
        expect(client.syncStatus()).toMatchObject({ connection: "connected", pendingSubscriptions: 1, synced: false });
        expect(seen.at(-1)).toMatchObject({ connection: "connected", pendingSubscriptions: 1, synced: false });

        poke(reconnected, shapeIdOf(reconnected), 6, 5);

        expect(seen.at(-1)).toMatchObject({ connection: "connected", pendingSubscriptions: 0, synced: true });

        client.close();
    });

    it("tells listeners about a dropped socket's un-acknowledged subscriptions, not the previous socket's counts", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const { client, sockets } = createClient();
        const seen: SyncStatus[] = [];

        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        await settle();
        sockets[0]?.receive({ id: sockets[0]?.frames()[0]?.id, type: "ack" });

        client.onSyncStatus((status) => {
            seen.push(status);
        });
        seen.length = 0;

        sockets[0]?.triggerClose();

        expect(seen.length).toBeGreaterThan(0);
        // Nothing the listener is told after the drop may still count the dead socket's ack.
        expect(seen.every((status) => status.pendingSubscriptions === 1)).toBe(true);

        client.close();
    });

    it("notifies listeners when a shape is registered, answered and removed on a live connection", async () => {
        expect.assertions(4);

        vi.useFakeTimers();

        const { client, sockets } = createClient();
        const seen: SyncStatus[] = [];

        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        await settle();
        sockets[0]?.receive({ id: sockets[0]?.frames()[0]?.id, type: "ack" });

        client.onSyncStatus((status) => {
            seen.push(status);
        });

        expect(seen.at(-1)).toMatchObject({ pendingSubscriptions: 0, synced: true });

        const unsubscribe = client.subscribeShape({ name: "messages" }, () => undefined);

        expect(seen.at(-1)).toMatchObject({ pendingSubscriptions: 1, synced: false });

        poke(sockets[0], shapeIdOf(sockets[0]), 5);

        expect(seen.at(-1)).toMatchObject({ pendingSubscriptions: 0, synced: true });

        const unanswered = client.subscribeShape({ name: "other" }, () => undefined);

        unsubscribe();
        unanswered();

        // Removing a still-unanswered shape releases what it was holding back.
        expect(seen.at(-1)).toMatchObject({ pendingSubscriptions: 0, synced: true });

        client.close();
    });
});
