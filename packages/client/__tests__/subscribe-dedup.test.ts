import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import type { FunctionReference } from "../src/types";

/** A direct `client.subscribe` caller joining a still-un-acked subscription must not re-send its frame. */

interface MockSocket {
    open: () => void;
    receive: (payload: unknown) => void;
    sent: string[];
    triggerClose: () => void;
}

const sockets: MockSocket[] = [];

const createMockWebSocket = (): typeof WebSocket => {
    class WS {
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
});
