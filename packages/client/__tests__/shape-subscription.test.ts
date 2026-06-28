import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";

/**
 * Phase 6 — the client half of the poke protocol. `subscribeShape` sends a
 * `shape_subscribe` envelope, then materializes the shape's rowset from the
 * server's atomically-applied poke frames (`pokeStart` → `pokePart*` →
 * `pokeEnd`). These tests drive a controllable mock socket through a seed poke,
 * a live membership diff, and a reconnect-resume.
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

const makeClient = (): LunoraClient =>
    new LunoraClient({
        url: "https://app.example",
        WebSocket: createMockWebSocket(),
    });

describe("lunoraClient subscribeShape", () => {
    beforeEach(() => {
        vi.useRealTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        sockets.length = 0;
    });

    it("seeds + diffs a shape from atomic poke frames", () => {
        const client = makeClient();
        const seen: Record<string, unknown>[][] = [];

        client.subscribeShape({ args: { channelId: "c1" }, name: "messagesByChannel" }, (rows) => seen.push(rows));

        const socket = latestSocket();

        socket.open();

        // The shape_subscribe envelope went out on open (cold — no resume cursor).
        const subscribe = frames(socket).find((frame) => frame.type === "shape_subscribe");

        expect(subscribe).toMatchObject({ shape: { args: { channelId: "c1" }, name: "messagesByChannel" }, type: "shape_subscribe" });

        const shapeId = subscribe?.id as string;

        // Seed poke: one insert, committed at checkpoint 5 / epoch e1.
        socket.receive({ epoch: "e1", pokeId: "p1", type: "pokeStart" });
        socket.receive({
            pokeId: "p1",
            rowsPatch: [{ key: "m1", op: "insert", table: "messages", value: { _id: "m1", text: "a" } }],
            shapeId,
            type: "pokePart",
        });
        socket.receive({ checkpoint: 5, epoch: "e1", pokeId: "p1", type: "pokeEnd" });

        expect(seen.at(-1)).toStrictEqual([{ _id: "m1", text: "a" }]);

        // Live poke: add m2, drop m1 — applied atomically at pokeEnd.
        socket.receive({ epoch: "e1", pokeId: "p2", type: "pokeStart" });
        socket.receive({
            pokeId: "p2",
            rowsPatch: [
                { key: "m2", op: "insert", table: "messages", value: { _id: "m2", text: "b" } },
                { key: "m1", op: "delete", table: "messages" },
            ],
            shapeId,
            type: "pokePart",
        });
        socket.receive({ checkpoint: 9, epoch: "e1", pokeId: "p2", type: "pokeEnd" });

        expect(seen.at(-1)).toStrictEqual([{ _id: "m2", text: "b" }]);
    });

    it("does not apply a poke missing its pokeStart (connected mid-poke)", () => {
        const client = makeClient();
        const seen: Record<string, unknown>[][] = [];

        client.subscribeShape({ name: "all" }, (rows) => seen.push(rows));
        const socket = latestSocket();

        socket.open();
        const shapeId = frames(socket).find((frame) => frame.type === "shape_subscribe")?.id as string;

        // A pokePart/pokeEnd with no opening pokeStart must be ignored.
        socket.receive({ pokeId: "orphan", rowsPatch: [{ key: "x", op: "insert", table: "t", value: { _id: "x" } }], shapeId, type: "pokePart" });
        socket.receive({ checkpoint: 1, pokeId: "orphan", type: "pokeEnd" });

        expect(seen).toStrictEqual([]);
    });

    it("resumes from the last applied checkpoint on reconnect", () => {
        vi.useFakeTimers();

        const client = makeClient();

        client.subscribeShape({ args: { channelId: "c1" }, name: "messagesByChannel" }, () => undefined);

        const first = latestSocket();

        first.open();
        const shapeId = frames(first).find((frame) => frame.type === "shape_subscribe")?.id as string;

        first.receive({ epoch: "e1", pokeId: "p1", type: "pokeStart" });
        first.receive({ pokeId: "p1", rowsPatch: [{ key: "m1", op: "insert", table: "messages", value: { _id: "m1" } }], shapeId, type: "pokePart" });
        first.receive({ checkpoint: 7, epoch: "e1", pokeId: "p1", type: "pokeEnd" });

        // Drop the socket; the client arms a backoff-timed reconnect that opens a new one.
        first.triggerClose();
        vi.runOnlyPendingTimers();
        const second = latestSocket();

        expect(second).not.toBe(first);

        second.open();

        // The resumed subscribe carries the checkpoint + epoch we last applied.
        const resume = frames(second).find((frame) => frame.type === "shape_subscribe");

        expect(resume).toMatchObject({ sinceCheckpoint: 7, sinceEpoch: "e1" });
    });
});
