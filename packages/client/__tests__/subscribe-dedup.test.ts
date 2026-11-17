import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import type { FunctionReference } from "../src/types";

/** A direct `client.subscribe` caller joining a still-un-acked subscription must not re-send its frame. */

interface MockSocket {
    failSends: boolean;
    open: () => void;
    receive: (payload: unknown) => void;
    sent: string[];
    triggerClose: () => void;
}

const sockets: MockSocket[] = [];

const createMockWebSocket = (): typeof WebSocket => {
    class WS {
        public failSends = false;

        public readyState = 0;

        public sent: string[] = [];

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

        public receive(payload: unknown): void {
            this.dispatch("message", { data: JSON.stringify(payload) });
        }

        public triggerClose(): void {
            this.readyState = 3;
            this.dispatch("close");
        }

        public send(data: string): void {
            if (this.failSends) {
                throw new Error("send failed");
            }

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

const subscribeFrames = (socket: MockSocket): { id: string }[] =>
    socket.sent
        .filter((raw) => raw !== "lunora-ping")
        .map((raw) => JSON.parse(raw) as { id: string; type: string })
        .filter((frame) => frame.type === "subscribe");

const fnRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

describe("subscribe frame dedup", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        sockets.length = 0;
    });

    it("sends one subscribe frame when two subscribers join before the ack", () => {
        expect.assertions(1);

        const client = new LunoraClient({ url: "https://app.example", WebSocket: createMockWebSocket() });

        client.subscribe(fnRef("todos.list"), {}, () => undefined);

        const socket = latestSocket();

        socket.open();
        client.subscribe(fnRef("todos.list"), {}, () => undefined);

        expect(subscribeFrames(socket)).toHaveLength(1);
    });

    it("re-sends the frame once after the socket closes and reopens", () => {
        expect.assertions(2);

        const client = new LunoraClient({ url: "https://app.example", WebSocket: createMockWebSocket() });

        client.subscribe(fnRef("todos.list"), {}, () => undefined);

        const first = latestSocket();

        first.open();
        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        first.triggerClose();
        vi.runOnlyPendingTimers();

        const second = latestSocket();

        second.open();
        client.subscribe(fnRef("todos.list"), {}, () => undefined);

        expect(second).not.toBe(first);
        expect(subscribeFrames(second)).toHaveLength(1);
    });

    it("re-sends the frame once on a new leader socket after a demotion before the ack", async () => {
        expect.assertions(2);

        const client = new LunoraClient({ crossTabSync: true, url: "https://app.example", WebSocket: createMockWebSocket() });
        const rogue = new BroadcastChannel(`lunora-bridge::https://app.example::${client.currentIdentity() ?? "anon"}`);

        try {
            // Solo self-promotion after the default leader-timeout window.
            await vi.advanceTimersByTimeAsync(3100);

            client.subscribe(fnRef("todos.list"), {}, () => undefined);

            const first = latestSocket();

            first.open();

            // A smaller tab id takes over before the ack arrives, then yields straight back.
            rogue.postMessage({ tabId: "aaa-earlier-tab", ts: Date.now(), type: "heartbeat" });
            await vi.advanceTimersByTimeAsync(20);
            rogue.postMessage({ tabId: "aaa-earlier-tab", type: "yield-leadership" });
            await vi.advanceTimersByTimeAsync(3100);

            const second = latestSocket();

            second.open();

            expect(second).not.toBe(first);
            expect(subscribeFrames(second)).toHaveLength(1);
        } finally {
            rogue.close();
            client.close();
        }
    });

    it("lets a later subscribe re-send a frame whose ack was lost once the pacing slot times out", () => {
        expect.assertions(2);

        const client = new LunoraClient({ url: "https://app.example", WebSocket: createMockWebSocket() });

        client.subscribe(fnRef("todos.list"), {}, () => undefined);

        const socket = latestSocket();

        socket.open();

        expect(subscribeFrames(socket)).toHaveLength(1);

        // No ack ever arrives; the pacing watchdog gives up on the frame.
        vi.advanceTimersByTime(10_000);
        client.subscribe(fnRef("todos.list"), {}, () => undefined);

        expect(subscribeFrames(socket)).toHaveLength(2);
    });

    it("lets a later subscribe re-send once the watchdog's retry was lost too", () => {
        expect.assertions(3);

        const client = new LunoraClient({ url: "https://app.example", WebSocket: createMockWebSocket() });

        client.subscribe(fnRef("todos.list"), {}, () => undefined);

        const socket = latestSocket();

        socket.open();

        // The first frame and the watchdog's retry both go unanswered.
        vi.advanceTimersByTime(10_000);

        expect(subscribeFrames(socket)).toHaveLength(2);

        // Inside the retry's own ack window a join still dedupes onto it.
        client.subscribe(fnRef("todos.list"), {}, () => undefined);

        expect(subscribeFrames(socket)).toHaveLength(2);

        vi.advanceTimersByTime(10_000);
        client.subscribe(fnRef("todos.list"), {}, () => undefined);

        expect(subscribeFrames(socket)).toHaveLength(3);
    });

    it("lets a later subscribe send when the watchdog's retry could not go out", () => {
        expect.assertions(2);

        const client = new LunoraClient({ url: "https://app.example", WebSocket: createMockWebSocket() });

        client.subscribe(fnRef("todos.list"), {}, () => undefined);

        const socket = latestSocket();

        socket.open();

        // The retry's `send` throws while the socket still reads open, and no close follows.
        socket.failSends = true;
        vi.advanceTimersByTime(10_000);
        socket.failSends = false;

        expect(subscribeFrames(socket)).toHaveLength(1);

        client.subscribe(fnRef("todos.list"), {}, () => undefined);

        expect(subscribeFrames(socket)).toHaveLength(2);
    });
});
