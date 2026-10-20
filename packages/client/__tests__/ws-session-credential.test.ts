import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";

const sockets: MockSocket[] = [];

/** A WebSocket stand-in that records every URL it was built with and every frame it was sent. */
class MockSocket {
    public readyState = 0;

    public readonly sent: string[] = [];

    private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

    public constructor(public readonly url: string) {
        sockets.push(this);
    }

    public addEventListener(type: string, listener: (event?: unknown) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    public open(): void {
        this.readyState = 1;
        this.dispatch("open");
    }

    public triggerClose(): void {
        this.readyState = 3;
        this.dispatch("close", { code: 1006, reason: "" });
    }

    public send(data: string): void {
        this.sent.push(data);
    }

    public close(): void {
        this.triggerClose();
    }

    private dispatch(type: string, event?: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}

const WebSocketImpl = MockSocket as unknown as typeof WebSocket;

/** The first frame a socket sent, parsed. The client sends `connect` before anything else. */
const firstFrame = (socket: MockSocket): { token?: string; type: string } => JSON.parse(socket.sent[0] ?? "null") as { token?: string; type: string };

/**
 * Advance fake time until a socket beyond `known` exists, then open it. A socket
 * left unopened hits the connect timeout and reconnects again, so it is opened
 * as soon as it appears. A provider-shaped credential creates its socket after
 * an await, which is why this polls rather than reading the list once.
 */
const openNextSocket = async (known: number): Promise<MockSocket> => {
    for (let step = 0; step < 100 && sockets.length <= known; step += 1) {
        // Each step lets the reconnect timer fire before the next check; the steps must run in order.
        // eslint-disable-next-line no-await-in-loop -- sequential by construction: each check needs the previous step's timers
        await vi.advanceTimersByTimeAsync(100);
    }

    const next = sockets.at(-1);

    if (next === undefined || sockets.length <= known) {
        throw new Error("no shard socket was created");
    }

    next.open();

    return next;
};

describe("lunoraClient session credential (protocol §6)", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        sockets.length = 0;
    });

    it("sends the session credential in the connect frame and never in the upgrade URL", async () => {
        expect.assertions(3);

        const client = new LunoraClient({ url: "https://app.example", WebSocket: WebSocketImpl, wsToken: "session-secret" });

        client.subscribeShape({ args: {}, name: "messagesByChannel" }, () => undefined);

        const socket = await openNextSocket(0);

        expect(socket.url).not.toContain("session-secret");
        expect(socket.url).not.toContain("token=");
        expect(firstFrame(socket)).toMatchObject({ token: "session-secret", type: "connect" });
    });

    it("keeps the session credential out of the URL and the connect frame across a reconnect", async () => {
        expect.assertions(3);

        const client = new LunoraClient({ url: "https://app.example", WebSocket: WebSocketImpl, wsToken: "session-secret" });

        client.subscribeShape({ args: {}, name: "messagesByChannel" }, () => undefined);

        const first = await openNextSocket(0);
        const known = sockets.length;

        first.triggerClose();

        const second = await openNextSocket(known);

        expect(second).not.toBe(first);
        expect(second.url).not.toContain("session-secret");
        expect(firstFrame(second)).toMatchObject({ token: "session-secret", type: "connect" });
    });

    it("re-resolves a provider-shaped session on every connect and never puts the minted value in the URL", async () => {
        expect.assertions(4);

        let mint = 0;
        const client = new LunoraClient({
            url: "https://app.example",
            WebSocket: WebSocketImpl,
            wsToken: () => {
                mint += 1;

                return `session-${String(mint)}`;
            },
        });

        client.subscribeShape({ args: {}, name: "messagesByChannel" }, () => undefined);

        const first = await openNextSocket(0);
        const known = sockets.length;

        first.triggerClose();

        const second = await openNextSocket(known);

        expect(firstFrame(first)).toMatchObject({ token: "session-1" });
        expect(firstFrame(second)).toMatchObject({ token: "session-2" });
        expect(second.url).not.toContain("session-2");
        expect(second.url).not.toContain("token=");
    });

    it("moves a rotated session onto the next connect after setWsToken", async () => {
        expect.assertions(3);

        const client = new LunoraClient({ url: "https://app.example", WebSocket: WebSocketImpl, wsToken: "old-session" });

        client.subscribeShape({ args: {}, name: "messagesByChannel" }, () => undefined);

        const first = await openNextSocket(0);
        const known = sockets.length;

        client.setWsToken("new-session");

        const rotated = await openNextSocket(known);

        expect(rotated.url).not.toContain("new-session");
        expect(firstFrame(rotated)).toMatchObject({ token: "new-session", type: "connect" });
        expect(first.url).not.toContain("old-session");
    });

    it("puts only the ticket in the URL and sends no token in connect when only a ticket is set", async () => {
        expect.assertions(2);

        const client = new LunoraClient({ url: "https://app.example", WebSocket: WebSocketImpl, wsTicket: "ephemeral-ticket" });

        client.subscribeShape({ args: {}, name: "messagesByChannel" }, () => undefined);

        const socket = await openNextSocket(0);

        expect(socket.url).toContain("token=ephemeral-ticket");
        expect(firstFrame(socket)).not.toHaveProperty("token");
    });

    it("sends the ticket in the URL and the session in connect, never mixing them", async () => {
        expect.assertions(3);

        const client = new LunoraClient({
            url: "https://app.example",
            WebSocket: WebSocketImpl,
            wsTicket: "ephemeral-ticket",
            wsToken: "session-secret",
        });

        client.subscribeShape({ args: {}, name: "messagesByChannel" }, () => undefined);

        const socket = await openNextSocket(0);

        expect(socket.url).toContain("token=ephemeral-ticket");
        expect(socket.url).not.toContain("session-secret");
        expect(firstFrame(socket)).toMatchObject({ token: "session-secret", type: "connect" });
    });

    it("sends connect before any subscription frame on every open", async () => {
        expect.assertions(2);

        const client = new LunoraClient({ url: "https://app.example", WebSocket: WebSocketImpl, wsToken: "session-secret" });

        client.subscribeShape({ args: {}, name: "messagesByChannel" }, () => undefined);

        const socket = await openNextSocket(0);
        const types = socket.sent.map((raw) => (JSON.parse(raw) as { type: string }).type);

        expect(types[0]).toBe("connect");
        expect(types.indexOf("shape_subscribe")).toBeGreaterThan(0);
    });

    it("sends connect before a listener that answers 'connected' can send a frame of its own", async () => {
        expect.assertions(2);

        const client = new LunoraClient({ url: "https://app.example", WebSocket: WebSocketImpl, wsToken: "session-secret" });

        client.onConnectionStatus((status) => {
            if (status === "connected") {
                client.subscribeShape({ args: {}, name: "messagesByChannel" }, () => undefined);
            }
        });
        client.subscribeShape({ args: {}, name: "messagesByChannel" }, () => undefined);

        const socket = await openNextSocket(0);
        const types = socket.sent.map((raw) => (JSON.parse(raw) as { type: string }).type);

        expect(types[0]).toBe("connect");
        expect(types.filter((type) => type === "shape_subscribe").length).toBeGreaterThanOrEqual(1);
    });
});
