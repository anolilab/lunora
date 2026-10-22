import { afterEach, describe, expect, it, vi } from "vitest";

import { RESUBSCRIBE_ACK_TIMEOUT_MS, RESUBSCRIBE_CONCURRENCY } from "../src/client-tuning";
import { LunoraClient } from "../src/lunora-client";
import { createSocketHarness, fnRef, jsonResponse, settle } from "./lib/harness";

const createClient = () => {
    const { sockets, WebSocket } = createSocketHarness();
    const client = new LunoraClient({
        fetch: vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } })),
        heartbeatIntervalMs: 0,
        url: "http://app.test",
        WebSocket,
    });

    return { client, sockets };
};

describe("unsubscribing while the subscribe frame is unanswered", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("clears the frame's watchdog, so nothing is left pending and nothing is re-sent", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const { client, sockets } = createClient();
        const unsubscribe = client.subscribe(fnRef("todos.list"), {}, () => undefined);

        await settle();
        sockets[0]?.open();
        await settle();

        const timersWithWatchdog = vi.getTimerCount();

        unsubscribe();

        // Exactly the watchdog went away.
        expect(vi.getTimerCount()).toBe(timersWithWatchdog - 1);

        await vi.advanceTimersByTimeAsync(RESUBSCRIBE_ACK_TIMEOUT_MS * 2);

        const types = sockets[0]?.frames().map((frame) => frame.type);

        expect(types).toStrictEqual(["subscribe", "unsubscribe"]);
        expect(client.syncStatus().pendingSubscriptions).toBe(0);

        client.close();
    });

    it("frees the pacing slot, so the next queued subscribe goes out at once", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const { client, sockets } = createClient();
        const unsubscribers = Array.from({ length: RESUBSCRIBE_CONCURRENCY + 1 }, (_unused, index) =>
            client.subscribe(fnRef("todos.list"), { index }, () => undefined),
        );

        await settle();
        sockets[0]?.open();
        await settle();

        const subscribes = (): number => (sockets[0]?.frames() ?? []).filter((frame) => frame.type === "subscribe").length;

        // The window is full, and the last subscription waits behind it.
        expect(subscribes()).toBe(RESUBSCRIBE_CONCURRENCY);

        unsubscribers[0]?.();

        expect(subscribes()).toBe(RESUBSCRIBE_CONCURRENCY + 1);

        client.close();
    });
});
