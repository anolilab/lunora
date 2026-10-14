import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeWire } from "../../../shared/wire-codec";
import { LunoraClient } from "../src/lunora-client";
import type { FunctionReference } from "../src/types";

/**
 * Resilience of the socket-driven subscription paths: a single bad
 * subscription, a frame the wire codec refuses, and two consumers that happen
 * to share one callback reference. Each of these used to take out something
 * much larger than itself — the whole reconnect, the whole message listener, or
 * the other consumer's registration.
 */

interface MockSocket {
    addEventListener: (type: string, listener: (event?: unknown) => void) => void;
    close: () => void;
    open: () => void;
    readyState: number;
    receive: (payload: unknown) => void;
    send: (data: string) => void;
    sent: string[];
    triggerClose: () => void;
    url: string;
}

const sockets: MockSocket[] = [];

const createMockWebSocket = (): typeof WebSocket => {
    class WS {
        public readonly url: string;

        public readyState = 0;

        public sent: string[] = [];

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        public constructor(url: string) {
            this.url = url;
            sockets.push(this);
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            const existing = this.listeners.get(type) ?? [];

            existing.push(listener);
            this.listeners.set(type, existing);
        }

        public open(): void {
            this.readyState = 1;
            this.dispatch("open");
        }

        public receive(payload: unknown): void {
            const data = typeof payload === "string" ? payload : JSON.stringify(payload);

            this.dispatch("message", { data });
        }

        public triggerClose(): void {
            this.readyState = 3;
            this.dispatch("close");
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

    return WS as unknown as typeof WebSocket;
};

const latestSocket = (): MockSocket => {
    const last = sockets.at(-1);

    if (!last) {
        throw new Error("no socket created");
    }

    return last;
};

/** Parsed control frames a socket sent, excluding the `connect` envelope + keepalive pings. */
const frames = (socket: MockSocket): { [key: string]: unknown; type: string }[] =>
    socket.sent
        .filter((raw) => raw !== "lunora-ping")
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter((frame) => frame.type !== "connect");

const fnRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

const makeClient = (): LunoraClient =>
    new LunoraClient({
        url: "https://app.example",
        WebSocket: createMockWebSocket(),
    });

/** A `bigint` token `encodeWire` will happily produce but `decodeWire` refuses (digit cap). */
const OVER_LONG_BIGINT = ["$lunora.wire$", "bigint", "9".repeat(2000)];

describe("subscription resilience", () => {
    beforeEach(() => {
        vi.useRealTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        sockets.length = 0;
    });

    it("resubscribes every subscription on reconnect even when one's args were mutated to something unencodable", () => {
        expect.assertions(4);

        vi.useFakeTimers();

        const client = makeClient();
        const mutableArgs: Record<string, unknown> = { q: "ok" };

        client.subscribe(fnRef("poisoned:one"), mutableArgs, () => undefined);
        client.subscribe(fnRef("healthy:two"), { q: "fine" }, () => undefined);

        const first = latestSocket();

        first.open();

        // The caller keeps its own reference to the args object and mutates it
        // after subscribing. The registration must not depend on that object
        // still being wire-encodable.
        mutableArgs.q = /boom/;

        first.triggerClose();
        vi.runOnlyPendingTimers();

        const second = latestSocket();

        expect(second).not.toBe(first);
        expect(() => {
            second.open();
        }).not.toThrow();

        const resent = frames(second).filter((frame) => frame.type === "subscribe");

        // Both legs of the resubscribe loop ran, and the poisoned one went out
        // with the args as they were at subscribe time.
        expect(resent.map((frame) => (frame.query as { functionPath: string }).functionPath)).toStrictEqual(["poisoned:one", "healthy:two"]);
        expect(decodeWire((resent[0]?.query as { args: unknown }).args)).toStrictEqual({ q: "ok" });

        client.close();
    });

    it("routes a frame the wire codec cannot decode to onError instead of throwing out of the message listener", () => {
        expect.assertions(4);

        const client = makeClient();
        const received: unknown[] = [];
        const errors: { code?: string; message: string }[] = [];

        client.subscribe(fnRef("messages:list"), {}, (data) => received.push(data), { onError: (error) => errors.push(error) });

        const socket = latestSocket();

        socket.open();

        const id = frames(socket).find((frame) => frame.type === "subscribe")?.id as string;

        socket.receive({ cursor: 1, data: [{ _id: "a", n: 1 }], id, type: "data" });

        expect(() => {
            socket.receive({ cursor: 2, data: { n: OVER_LONG_BIGINT }, id, type: "data" });
        }).not.toThrow();
        expect(errors).toHaveLength(1);

        // The undecodable frame neither advanced the resume cursor nor replaced
        // the value the subscriber is displaying.
        expect(client.debug().subscriptions[0]?.serverCursor).toBe(1);
        expect(received).toStrictEqual([[{ _id: "a", n: 1 }]]);

        client.close();
    });

    it("does not let an undecodable whisper frame escape the message listener", () => {
        expect.assertions(2);

        const client = makeClient();
        const seen: unknown[] = [];

        client.whisperSubscribe("presence", (data) => seen.push(data));

        const socket = latestSocket();

        socket.open();

        expect(() => {
            socket.receive({ data: { n: OVER_LONG_BIGINT }, topic: "presence", type: "whisper" });
        }).not.toThrow();
        expect(seen).toStrictEqual([]);

        client.close();
    });

    it("keeps a shared registration alive for the second consumer when both passed the same callback reference", () => {
        expect.assertions(4);

        const client = makeClient();
        let hits = 0;
        const handler = (): void => {
            hits += 1;
        };

        const unsubscribeOne = client.subscribe(fnRef("messages:list"), {}, handler);
        const unsubscribeTwo = client.subscribe(fnRef("messages:list"), {}, handler);

        const socket = latestSocket();

        socket.open();

        const id = frames(socket).find((frame) => frame.type === "subscribe")?.id as string;

        socket.receive({ cursor: 1, data: [{ _id: "a" }], id, type: "data" });

        // Two consumers, two deliveries.
        expect(hits).toBe(2);

        unsubscribeOne();

        expect(frames(socket).some((frame) => frame.type === "unsubscribe")).toBe(false);

        socket.receive({ cursor: 2, data: [{ _id: "b" }], id, type: "data" });

        expect(hits).toBe(3);

        unsubscribeTwo();

        expect(frames(socket).some((frame) => frame.type === "unsubscribe")).toBe(true);

        client.close();
    });
});
