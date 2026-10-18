import { encodeWire } from "@lunora/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";

/** A WebSocket stand-in that records what was sent and lets a test fire its events. */
class FakeSocket {
    public static readonly instances: FakeSocket[] = [];

    public closed = false;

    public readonly sent: string[] = [];

    private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

    public constructor(public readonly url: string) {
        FakeSocket.instances.push(this);
    }

    public addEventListener(type: string, listener: (event?: unknown) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    public close(): void {
        this.closed = true;
    }

    public fire(type: string, event?: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }

    public send(data: string): void {
        this.sent.push(data);
    }
}

const WebSocketImpl = FakeSocket as unknown as typeof WebSocket;

const makeClient = (): LunoraClient => new LunoraClient({ url: "https://app.example", WebSocket: WebSocketImpl });

const lastSocket = (): FakeSocket => FakeSocket.instances.at(-1)!;

describe("connectWebSocket", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        FakeSocket.instances.length = 0;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("opens a dedicated socket at the route path", () => {
        expect.assertions(1);

        const client = makeClient();

        client.connectWebSocket("/chat", { onMessage: () => undefined });

        expect(lastSocket().url).toBe("wss://app.example/chat");
    });

    it("wire-encodes an outgoing message", () => {
        expect.assertions(1);

        const client = makeClient();
        const chat = client.connectWebSocket<{ text: string }>("/chat", { onMessage: () => undefined });

        chat.send({ text: "hi" });

        expect(lastSocket().sent).toEqual([JSON.stringify(encodeWire({ text: "hi" }))]);
    });

    it("decodes an inbound message frame and hands it to onMessage", () => {
        expect.assertions(2);

        const client = makeClient();
        const onMessage = vi.fn<(message: { text: string }) => void>();

        client.connectWebSocket<{ text: string }>("/chat", { onMessage });

        // A `message` frame is the route's wire-encoded payload; a non-JSON
        // frame (the keepalive pong) must be ignored.
        lastSocket().fire("message", { data: "lunora-pong" });
        lastSocket().fire("message", {
            data: JSON.stringify({ data: encodeWire({ text: "hello" }), topic: "__lunora_socket__:sockets:chat", type: "message" }),
        });

        expect(onMessage).toHaveBeenCalledTimes(1);
        expect(onMessage).toHaveBeenCalledWith({ text: "hello" });
    });

    it("closes the socket on close()", () => {
        expect.assertions(1);

        const client = makeClient();
        const chat = client.connectWebSocket("/chat", { onMessage: () => undefined });

        chat.close();

        expect(lastSocket().closed).toBe(true);
    });

    it("opens nothing once the client is closed", () => {
        expect.assertions(1);

        const client = makeClient();

        client.close();
        client.connectWebSocket("/chat", { onMessage: () => undefined });

        // teardown already swept; a socket opened now would never be closed
        expect(FakeSocket.instances).toHaveLength(0);
    });

    it("keeps a configured URL's query and puts the route path before it", () => {
        expect.assertions(1);

        const client = new LunoraClient({ url: "https://app.example", wsUrl: "wss://app.example/_lunora/ws?tenant=a", WebSocket: WebSocketImpl });

        client.connectWebSocket("/chat", { onMessage: () => undefined });

        expect(lastSocket().url).toBe("wss://app.example/chat?tenant=a");
    });

    it("does not open on a token minted under a credential that was replaced while pending", async () => {
        expect.assertions(2);

        let resolveStale!: (token: string) => void;
        const client = new LunoraClient({
            url: "https://app.example",
            WebSocket: WebSocketImpl,
            wsToken: () =>
                new Promise<string>((resolve) => {
                    resolveStale = resolve;
                }),
        });

        client.connectWebSocket("/chat", { onMessage: () => undefined });
        // Rotate while the first provider is still pending.
        client.setWsToken("fresh");
        resolveStale("stale");
        await vi.advanceTimersByTimeAsync(0);

        expect(FakeSocket.instances.some((socket) => socket.url.includes("token=stale"))).toBe(false);
        expect(FakeSocket.instances.filter((socket) => socket.url.includes("token=fresh"))).toHaveLength(1);
    });
});
