import { afterEach, describe, expect, it, vi } from "vitest";

import { RESUBSCRIBE_ACK_TIMEOUT_MS } from "../src/client-tuning";
import { LunoraClient } from "../src/lunora-client";
import type { HarnessSocket } from "./lib/harness";
import { createSocketHarness, fnRef, settle } from "./lib/harness";

const subscribeFrames = (socket: { frames: () => { id?: string; type: string }[] }) => socket.frames().filter((frame) => frame.type === "subscribe");

const createClient = () => {
    const { sockets, WebSocket } = createSocketHarness();
    const client = new LunoraClient({ fetch: vi.fn<typeof fetch>(), heartbeatIntervalMs: 0, url: "http://app.test", WebSocket });

    return { client, sockets };
};

describe("subscribe the server never answers", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("re-sends a subscribe sent on an already-open socket, once", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const { client, sockets } = createClient();

        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        await settle();

        // The second subscription is sent directly on the open socket, not through the resubscribe drain.
        client.subscribe(fnRef("todos.other"), {}, () => undefined);

        const socket = sockets[0] as HarnessSocket;

        expect(subscribeFrames(socket)).toHaveLength(2);

        await vi.advanceTimersByTimeAsync(RESUBSCRIBE_ACK_TIMEOUT_MS + 100);

        expect(subscribeFrames(socket)).toHaveLength(4);

        await vi.advanceTimersByTimeAsync(RESUBSCRIBE_ACK_TIMEOUT_MS * 3);

        expect(subscribeFrames(socket)).toHaveLength(4);

        client.close();
    });

    it("does not re-send a subscribe the server acknowledged", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const { client, sockets } = createClient();

        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        await settle();

        const socket = sockets[0] as HarnessSocket;
        const [frame] = subscribeFrames(socket);

        socket.receive({ id: frame?.id, type: "ack" });
        await vi.advanceTimersByTimeAsync(RESUBSCRIBE_ACK_TIMEOUT_MS * 2);

        expect(subscribeFrames(socket)).toHaveLength(1);

        client.close();
    });
});
