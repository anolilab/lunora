import { afterEach, describe, expect, it } from "vitest";

import { LunoraClient } from "../src/lunora-client";

/**
 * Characterization tests for the shape re-seed safety-net in LunoraClient.
 *
 * When `pokeEnd` arrives and the poke's `epoch` (from `pokeStart`) differs from
 * the subscription's `serverEpoch` (changelog timeline forked — shard reset /
 * recycled DO), or the poke's `baseCheckpoint` does not match the subscription's
 * `serverCursor` (poke gap / dropped frame), the client must NOT splice the
 * incremental ops onto the stale view. Instead it clears the local rowset, emits
 * an empty array, resets its cursor/epoch, and sends a cold `shape_subscribe`
 * so the server re-seeds the membership from scratch.
 *
 * These tests lock that branch in. A regression here would let the local view
 * drift silently after a shard reset or PITR.
 */

// ---------------------------------------------------------------------------
// Minimal mock WebSocket harness (mirrors shape-subscription.test.ts)
// ---------------------------------------------------------------------------

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

/** All `shape_subscribe` frames the socket sent (connect envelope excluded). */
const shapeSubscribeFrames = (socket: MockSocket): { [key: string]: unknown; type: string }[] =>
    socket.sent
        .filter((raw) => raw !== "lunora-ping")
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter((frame) => frame.type === "shape_subscribe");

const makeClient = (): LunoraClient =>
    new LunoraClient({
        url: "https://app.example",
        WebSocket: createMockWebSocket(),
    });

// ---------------------------------------------------------------------------
// Helpers: deliver a seed poke (checkpoint 5 / epoch "e1" / row m1)
// ---------------------------------------------------------------------------

const deliverSeedPoke = (socket: MockSocket, shapeId: string): void => {
    socket.receive({ epoch: "e1", pokeId: "p1", type: "pokeStart" });
    socket.receive({
        pokeId: "p1",
        rowsPatch: [{ key: "m1", op: "insert", table: "messages", value: { _id: "m1", text: "a" } }],
        shapeId,
        type: "pokePart",
    });
    socket.receive({ checkpoint: 5, epoch: "e1", pokeId: "p1", type: "pokeEnd" });
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lunoraClient shape re-seed on epoch fork / base divergence", () => {
    afterEach(() => {
        sockets.length = 0;
    });

    it.each([
        {
            label: "epoch fork (server DO recycled / shard reset)",
            secondPokeStart: { epoch: "e2", pokeId: "p2", type: "pokeStart" },
        },
        {
            label: "base divergence (poke built on wrong base checkpoint)",
            secondPokeStart: { baseCheckpoint: 99, epoch: "e1", pokeId: "p2", type: "pokeStart" },
        },
    ])("$label: clears the local view and sends a cold re-subscribe", ({ secondPokeStart }) => {
        expect.assertions(4);

        const client = makeClient();
        const seen: Record<string, unknown>[][] = [];

        client.subscribeShape({ args: { channelId: "c1" }, name: "messagesByChannel" }, (rows) => seen.push(rows));

        const socket = latestSocket();

        socket.open();

        const shapeId = shapeSubscribeFrames(socket)[0]?.id as string;

        // Seed poke: establishes serverEpoch = "e1", serverCursor = 5, rows = { m1 }.
        deliverSeedPoke(socket, shapeId);

        // After seed: subscriber sees the initial rowset.
        expect(seen.at(-1)).toStrictEqual([{ _id: "m1", text: "a" }]);

        // Second poke: epoch or baseCheckpoint diverges — triggers re-seed.
        socket.receive(secondPokeStart);
        socket.receive({
            pokeId: "p2",
            rowsPatch: [{ key: "m2", op: "insert", table: "messages", value: { _id: "m2", text: "b" } }],
            shapeId,
            type: "pokePart",
        });
        socket.receive({ checkpoint: 9, epoch: "e2", pokeId: "p2", type: "pokeEnd" });

        // Re-seed: the incremental ops are NOT applied; the view is cleared and
        // the callback receives an empty array (not a stale or partially-updated
        // view).
        expect(seen.at(-1)).toStrictEqual([]);

        // A cold shape_subscribe re-fires on the same open socket: cursor and
        // epoch were both cleared, so neither sinceCheckpoint nor sinceEpoch
        // appears in the frame.
        const subscribes = shapeSubscribeFrames(socket);

        expect(subscribes).toHaveLength(2);
        expect(subscribes[1]).toStrictEqual({
            id: shapeId,
            shape: { args: { channelId: "c1" }, name: "messagesByChannel" },
            type: "shape_subscribe",
        });
    });

    it("applies the diff and fires onCheckpoint when epoch and baseCheckpoint match (happy path)", () => {
        expect.assertions(3);

        const client = makeClient();
        const seen: Record<string, unknown>[][] = [];
        const watermarks: { checkpoint?: number; mutationId?: number }[] = [];

        client.subscribeShape({ args: { channelId: "c1" }, name: "messagesByChannel" }, (rows) => seen.push(rows), {
            onCheckpoint: (wm) => watermarks.push(wm),
        });

        const socket = latestSocket();

        socket.open();

        const shapeId = shapeSubscribeFrames(socket)[0]?.id as string;

        // Seed poke at checkpoint 5 / epoch "e1", echoing lastMutationId 2.
        socket.receive({ epoch: "e1", pokeId: "p1", type: "pokeStart" });
        socket.receive({
            lastMutationId: 2,
            pokeId: "p1",
            rowsPatch: [{ key: "m1", op: "insert", table: "messages", value: { _id: "m1", text: "a" } }],
            shapeId,
            type: "pokePart",
        });
        socket.receive({ checkpoint: 5, epoch: "e1", pokeId: "p1", type: "pokeEnd" });

        // Diff poke: same epoch, baseCheckpoint matches the cursor just established.
        // No fork / divergence — must apply the diff cleanly.
        socket.receive({ baseCheckpoint: 5, epoch: "e1", pokeId: "p2", type: "pokeStart" });
        socket.receive({
            lastMutationId: 4,
            pokeId: "p2",
            rowsPatch: [{ key: "m2", op: "insert", table: "messages", value: { _id: "m2", text: "b" } }],
            shapeId,
            type: "pokePart",
        });
        socket.receive({ checkpoint: 9, epoch: "e1", pokeId: "p2", type: "pokeEnd" });

        // Diff applied: both rows are visible (m1 from seed + m2 from diff).
        expect(seen.at(-1)).toStrictEqual([
            { _id: "m1", text: "a" },
            { _id: "m2", text: "b" },
        ]);

        // onCheckpoint fires with the watermark from the diff poke.
        expect(watermarks.at(-1)).toStrictEqual({ checkpoint: 9, mutationId: 4 });

        // No re-subscribe was sent: only the initial cold shape_subscribe.
        expect(shapeSubscribeFrames(socket)).toHaveLength(1);
    });

    it("does not re-seed when neither poke carries an epoch (legacy / no-epoch server)", () => {
        expect.assertions(3);

        const client = makeClient();
        const seen: Record<string, unknown>[][] = [];

        client.subscribeShape({ name: "all" }, (rows) => seen.push(rows));

        const socket = latestSocket();

        socket.open();

        const shapeId = shapeSubscribeFrames(socket)[0]?.id as string;

        // Seed without epoch: buffer.epoch = undefined, state.serverEpoch stays
        // undefined. epochForked = false (condition requires both to be defined).
        socket.receive({ pokeId: "p1", type: "pokeStart" });
        socket.receive({
            pokeId: "p1",
            rowsPatch: [{ key: "x", op: "insert", table: "t", value: { _id: "x" } }],
            shapeId,
            type: "pokePart",
        });
        socket.receive({ checkpoint: 3, pokeId: "p1", type: "pokeEnd" });

        expect(seen.at(-1)).toStrictEqual([{ _id: "x" }]);

        // Second poke without epoch either: still no fork — diff applies.
        socket.receive({ pokeId: "p2", type: "pokeStart" });
        socket.receive({
            pokeId: "p2",
            rowsPatch: [{ key: "y", op: "insert", table: "t", value: { _id: "y" } }],
            shapeId,
            type: "pokePart",
        });
        socket.receive({ checkpoint: 6, pokeId: "p2", type: "pokeEnd" });

        expect(seen.at(-1)).toStrictEqual([{ _id: "x" }, { _id: "y" }]);

        // No cold re-subscribe was triggered — only the original subscribe.
        expect(shapeSubscribeFrames(socket)).toHaveLength(1);
    });

    it("does not re-seed when baseCheckpoint is absent from the poke (server omitted it)", () => {
        expect.assertions(3);

        const client = makeClient();
        const seen: Record<string, unknown>[][] = [];

        client.subscribeShape({ name: "all" }, (rows) => seen.push(rows));

        const socket = latestSocket();

        socket.open();

        const shapeId = shapeSubscribeFrames(socket)[0]?.id as string;

        deliverSeedPoke(socket, shapeId);

        expect(seen.at(-1)).toStrictEqual([{ _id: "m1", text: "a" }]);

        // Second poke: same epoch, no baseCheckpoint → baseDiverged = false
        // (condition requires buffer.baseCheckpoint !== undefined).
        socket.receive({ epoch: "e1", pokeId: "p2", type: "pokeStart" });
        socket.receive({
            pokeId: "p2",
            rowsPatch: [{ key: "m2", op: "insert", table: "messages", value: { _id: "m2", text: "b" } }],
            shapeId,
            type: "pokePart",
        });
        socket.receive({ checkpoint: 9, epoch: "e1", pokeId: "p2", type: "pokeEnd" });

        // Diff applied: both rows visible.
        expect(seen.at(-1)).toStrictEqual([
            { _id: "m1", text: "a" },
            { _id: "m2", text: "b" },
        ]);

        // No re-subscribe.
        expect(shapeSubscribeFrames(socket)).toHaveLength(1);
    });
});
