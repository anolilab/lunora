import { afterEach, describe, expect, it, vi } from "vitest";

import type { SyncStatus } from "../src/lunora-client";
import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
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
});
