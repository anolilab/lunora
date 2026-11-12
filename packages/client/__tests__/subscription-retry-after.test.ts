import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import type { FunctionReference } from "../src/types";

// --- Test doubles -----------------------------------------------------------

interface MockSocket {
    close: () => void;
    onclose?: ((event?: unknown) => void) | null;
    onerror?: ((event?: unknown) => void) | null;
    onmessage?: ((event: { data: unknown }) => void) | null;
    onopen?: ((event?: unknown) => void) | null;
    open: () => void;
    readyState: number;
    receive: (payload: unknown) => void;
    send: (data: string) => void;
    sent: string[];
    triggerClose: () => void;
    url: string;
}

const sockets: MockSocket[] = [];

/** Browsers dispatch `close` on a later turn, so the mock does too. */
const createMockWebSocket = (): typeof WebSocket => {
    class WS {
        public readonly url: string;

        public readyState = 0;

        public sent: string[] = [];

        public onopen: ((event?: unknown) => void) | null = null;

        public onmessage: ((event: { data: unknown }) => void) | null = null;

        public onclose: ((event?: unknown) => void) | null = null;

        public onerror: ((event?: unknown) => void) | null = null;

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
            this.onopen?.();
            this.dispatch("open");
        }

        public receive(payload: unknown): void {
            const data = typeof payload === "string" ? payload : JSON.stringify(payload);

            this.onmessage?.({ data });
            this.dispatch("message", { data });
        }

        public triggerClose(): void {
            this.readyState = 3;
            this.onclose?.();
            this.dispatch("close");
        }

        public send(data: string): void {
            this.sent.push(data);
        }

        public close(): void {
            this.readyState = 3;

            setTimeout(() => {
                this.triggerClose();
            }, 0);
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
        throw new Error("no socket has been created yet");
    }

    return last;
};

/** The JSON control frames a socket sent, without the connect envelope and keepalive pings. */
const wireFrames = (socket: MockSocket) =>
    socket.sent
        .filter((frame) => frame !== "lunora-ping")
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type !== "connect");

const firstSub = (socket: MockSocket) => wireFrames(socket)[0];

/** Subscribe frames a socket sent for one subscription id. */
const subscribeFramesFor = (socket: MockSocket, id: string) =>
    wireFrames(socket).filter((frame: { id?: string; type: string }) => frame.type === "subscribe" && frame.id === id);

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
    Response.json(body, {
        headers: { "content-type": "application/json" },
        status: 200,
        ...init,
    });

// --- Tests ------------------------------------------------------------------

/**
 * A client with one live subscription on an open socket. Reconnects are pushed
 * past every test's horizon, so the only re-subscribe a test can observe is the
 * one a retry hint schedules.
 */
const openSubscription = (subscribers = 1) => {
    const client = new LunoraClient({
        fetch: async () => jsonResponse({ result: null }),
        reconnect: { initialDelayMs: 60_000, jitter: false, maxDelayMs: 60_000 },
        url: "https://app.example",
        WebSocket: createMockWebSocket(),
    });

    const unsubscribes = Array.from({ length: subscribers }, () => client.subscribe(fnRef("items:list"), { page: 1 }, () => undefined));

    const socket = latestSocket();

    socket.open();

    const id = firstSub(socket).id as string;

    return { client, id, socket, unsubscribes };
};

const refreshFailure = (id: string, retryAfterMs?: number) => {
    return {
        error: {
            code: "SUBSCRIPTION_REFRESH_FAILED",
            message: "x",
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        },
        id,
        type: "error",
    };
};

describe("lunoraClient — retry hint on a failing subscription", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        sockets.length = 0;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("re-subscribes once at the hint, not before", () => {
        expect.assertions(2);

        const { id, socket } = openSubscription(3);

        socket.receive(refreshFailure(id, 5000));

        vi.advanceTimersByTime(4999);

        expect(subscribeFramesFor(socket, id)).toHaveLength(1);

        vi.advanceTimersByTime(1);

        expect(subscribeFramesFor(socket, id)).toHaveLength(2);
    });

    it("does not re-subscribe once every subscriber has unsubscribed", () => {
        expect.assertions(1);

        const { id, socket, unsubscribes } = openSubscription(2);

        socket.receive(refreshFailure(id, 5000));

        for (const unsubscribe of unsubscribes) {
            unsubscribe();
        }

        vi.advanceTimersByTime(5000);

        expect(subscribeFramesFor(socket, id)).toHaveLength(1);
    });

    it("does not re-subscribe on a socket that closed before the hint elapsed", () => {
        expect.assertions(2);

        const { id, socket } = openSubscription();

        socket.receive(refreshFailure(id, 5000));
        socket.triggerClose();

        const sentBeforeHint = socket.sent.length;

        vi.advanceTimersByTime(5000);

        expect(socket.sent).toHaveLength(sentBeforeHint);
        expect(sockets).toHaveLength(1);
    });

    it("replaces a pending hint with a later one", () => {
        expect.assertions(2);

        const { id, socket } = openSubscription();

        socket.receive(refreshFailure(id, 5000));

        vi.advanceTimersByTime(1000);

        socket.receive(refreshFailure(id, 8000));

        vi.advanceTimersByTime(4000);

        expect(subscribeFramesFor(socket, id)).toHaveLength(1);

        vi.advanceTimersByTime(4000);

        expect(subscribeFramesFor(socket, id)).toHaveLength(2);
    });

    it("cancels the pending re-subscribe when the subscription receives data", () => {
        expect.assertions(1);

        const { id, socket } = openSubscription();

        socket.receive(refreshFailure(id, 5000));

        vi.advanceTimersByTime(1000);

        socket.receive({ cursor: 7, data: { ok: true }, id, type: "data" });

        vi.advanceTimersByTime(5000);

        expect(subscribeFramesFor(socket, id)).toHaveLength(1);
    });

    it("cancels the pending re-subscribe when a later error carries no hint", () => {
        expect.assertions(1);

        const { id, socket } = openSubscription();

        socket.receive(refreshFailure(id, 5000));

        vi.advanceTimersByTime(1000);

        socket.receive(refreshFailure(id));

        vi.advanceTimersByTime(5000);

        expect(subscribeFramesFor(socket, id)).toHaveLength(1);
    });

    it("never re-subscribes an error that carries no hint", () => {
        expect.assertions(1);

        const { id, socket } = openSubscription();

        socket.receive(refreshFailure(id));

        vi.advanceTimersByTime(5000);

        expect(subscribeFramesFor(socket, id)).toHaveLength(1);
    });
});
