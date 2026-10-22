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

    public triggerClose(code = 1006): void {
        this.readyState = 3;
        this.dispatch("close", { code, reason: "" });
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
 * Open the socket the next connect creates. The zero-length advance flushes the
 * microtasks a provider-shaped credential needs before the socket constructor
 * runs; the reconnect timer is fired only if no socket appeared yet.
 */
const openNextSocket = async (known: number): Promise<MockSocket> => {
    await vi.advanceTimersByTimeAsync(0);

    if (sockets.length <= known) {
        await vi.advanceTimersToNextTimerAsync();
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

    it("re-arms the reconnect when the socket constructor throws, rather than leaving the shard connecting", async () => {
        expect.assertions(1);

        let constructions = 0;

        class RefuseOnce extends MockSocket {
            public constructor(url: string) {
                constructions += 1;

                if (constructions === 1) {
                    throw new Error("socket constructor refused");
                }

                super(url);
            }
        }

        const client = new LunoraClient({ url: "https://app.example", WebSocket: RefuseOnce as unknown as typeof WebSocket, wsToken: "session-secret" });

        client.subscribeShape({ args: {}, name: "messagesByChannel" }, () => undefined);

        await openNextSocket(0);

        expect(constructions).toBe(2);
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

    it("keeps a leftover token from the configured URL out of every socket URL, even with no ticket", async () => {
        expect.assertions(2);

        const client = new LunoraClient({
            url: "https://app.example",
            WebSocket: WebSocketImpl,
            wsToken: "session-secret",
            wsUrl: "wss://app.example/_lunora/ws?token=old-leftover",
        });

        client.subscribeShape({ args: {}, name: "messagesByChannel" }, () => undefined);

        const socket = await openNextSocket(0);

        expect(socket.url).not.toContain("old-leftover");
        expect(firstFrame(socket)).toMatchObject({ token: "session-secret", type: "connect" });
    });

    it("notifies token-expiry once per credential when the server refuses it, not once per retry", async () => {
        expect.assertions(2);

        const client = new LunoraClient({ url: "https://app.example", WebSocket: WebSocketImpl, wsToken: "wrong-session" });
        let notified = 0;

        client.onTokenExpired(() => {
            notified += 1;
        });
        client.subscribeShape({ args: {}, name: "messagesByChannel" }, () => undefined);

        const first = await openNextSocket(0);
        const known = sockets.length;

        first.triggerClose(4003);

        const retry = await openNextSocket(known);

        retry.triggerClose(4003);

        expect(notified).toBe(1);

        const knownAfterRotation = sockets.length;

        client.setWsToken("rotated-session");

        const rotated = await openNextSocket(knownAfterRotation);

        rotated.triggerClose(4003);

        expect(notified).toBe(2);
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
