import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import { createSocketHarness, fnRef, jsonResponse, settle } from "./lib/harness";

/** A React Native-style client (bearer on the upgrade) with one open, identified socket. */
const openClient = async (reauthStatus: number, reauthBody?: unknown, hang = false) => {
    const { sockets, WebSocket } = createSocketHarness();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
        if (!(input as string).includes("/_lunora/ws/reauth")) {
            return jsonResponse({ result: { ok: true } });
        }

        if (hang) {
            // A worker or proxy that never answers: only the client's own deadline ends the wait.
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => {
                    reject(new Error("aborted"));
                });
            });
        }

        return jsonResponse(reauthBody ?? { ok: reauthStatus === 200 }, { status: reauthStatus });
    });
    const client = new LunoraClient({
        authTokenOnUpgrade: true,
        fetch: fetchMock,
        heartbeatIntervalMs: 0,
        reconnect: { initialDelayMs: 0, jitter: false, maxDelayMs: 0 },
        url: "http://app.test",
        WebSocket,
    });

    client.setAuthToken("token-1", "user-1");
    client.subscribe(fnRef("todos.list"), {}, () => undefined);
    await settle();
    sockets[0]?.open();
    sockets[0]?.receive({ connectionId: "conn-1", subject: "user-1", type: "identity" });
    await settle();

    const reauthCalls = () => fetchMock.mock.calls.filter(([input]) => (input as string).includes("/_lunora/ws/reauth"));

    return { client, reauthCalls, sockets };
};

describe("socket re-authentication on a token refresh", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("hands the refreshed bearer to the open socket instead of reconnecting it", async () => {
        expect.assertions(5);

        const { client, reauthCalls, sockets } = await openClient(200);

        client.setAuthToken("token-2", "user-1");
        await settle();

        const [url, init] = reauthCalls()[0] ?? [];

        expect(reauthCalls()).toHaveLength(1);
        expect(url).toBe("http://app.test/_lunora/ws/reauth");
        expect(init?.body).toBe(JSON.stringify({ connectionId: "conn-1" }));
        expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer token-2");
        // The socket and its subscriptions stay as they are.
        expect(sockets[0]?.readyState).toBe(1);

        client.close();
    });

    it("reconnects the socket, as before, when the server refuses the refresh", async () => {
        expect.assertions(4);

        const { client, reauthCalls, sockets } = await openClient(409);

        client.setAuthToken("token-2", "user-1");
        await settle();

        expect(reauthCalls()).toHaveLength(1);
        expect(sockets[0]?.readyState).toBe(3);

        // The browser's `close` event, then the replacement socket replays the subscription.
        sockets[0]?.triggerClose();
        await vi.advanceTimersByTimeAsync(0);
        await settle();
        sockets[1]?.open();
        await settle();

        expect(sockets).toHaveLength(2);
        expect((sockets[1]?.frames() ?? []).some((frame) => frame.type === "subscribe")).toBe(true);

        client.close();
    });

    it("counts only the route's own ok body, not any 200, as a refreshed socket", async () => {
        expect.assertions(1);

        // A catch-all (an SPA fallback, a proxy) answering 200 with something else.
        const { client, sockets } = await openClient(200, { html: true });

        client.setAuthToken("token-2", "user-1");
        await settle();

        expect(sockets[0]?.readyState).toBe(3);

        client.close();
    });

    it("falls back to a reconnect when the refresh never answers", async () => {
        expect.assertions(2);

        const { client, sockets } = await openClient(200, undefined, true);

        client.setAuthToken("token-2", "user-1");
        await settle();

        expect(sockets[0]?.readyState).toBe(1);

        await vi.advanceTimersByTimeAsync(10_000);

        expect(sockets[0]?.readyState).toBe(3);

        client.close();
    });
});
