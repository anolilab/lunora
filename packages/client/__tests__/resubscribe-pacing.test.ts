import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import type { FunctionReference } from "../src/types";

/**
 * Pacing of the bulk resubscribe (issue #796).
 *
 * Every re-sent `subscribe` runs its query server-side to build a snapshot, and
 * most apps put most queries on the default shard — so a reconnect that sends
 * all of them in one tick lands the whole burst on one Durable Object. These
 * tests pin the window, and — more importantly — pin that a burst which is
 * never answered still drains, because a client that quietly stops
 * re-subscribing loses live data, which is worse than the burst.
 */

interface MockSocket {
    open: () => void;
    readyState: number;
    receive: (payload: unknown) => void;
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

/** Ids of the `subscribe` frames this socket has put on the wire, in order. */
const subscribeIds = (socket: MockSocket): string[] =>
    socket.sent
        .filter((raw) => raw !== "lunora-ping")
        .map((raw) => JSON.parse(raw) as { id?: string; type: string })
        .filter((frame) => frame.type === "subscribe")
        .map((frame) => frame.id as string);

/** Ack every frame the socket has sent, and everything the drain releases in response. Returns each batch, in order. */
const ackEveryFrame = (socket: MockSocket, alreadyAnswered: string[] = []): string[][] => {
    const acked = new Set<string>(alreadyAnswered);
    const batches: string[][] = [];

    for (let guard = 0; guard < 100; guard += 1) {
        const inFlight = subscribeIds(socket).filter((id) => !acked.has(id));

        if (inFlight.length === 0) {
            return batches;
        }

        batches.push(inFlight);

        for (const id of inFlight) {
            acked.add(id);
            socket.receive({ id, type: "ack" });
        }
    }

    throw new Error("drain did not settle");
};

const fnRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

const makeClient = (): LunoraClient =>
    new LunoraClient({
        url: "https://app.example",
        WebSocket: createMockWebSocket(),
    });

/** Open N subscriptions on the default shard and return the (not yet opened) socket they share. */
const subscribeMany = (client: LunoraClient, count: number): MockSocket => {
    for (let index = 0; index < count; index += 1) {
        client.subscribe(fnRef(`queries:q${String(index)}`), {}, () => undefined);
    }

    return latestSocket();
};

/** Reconnect the shard's socket: close the live one and let the backoff timer build its replacement. */
const reconnect = (socket: MockSocket): MockSocket => {
    socket.triggerClose();
    vi.runOnlyPendingTimers();

    return latestSocket();
};

// Matches `RESUBSCRIBE_CONCURRENCY` / `RESUBSCRIBE_ACK_TIMEOUT_MS` in the client.
const WINDOW = 3;
const ACK_TIMEOUT_MS = 10_000;

describe("resubscribe pacing", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        sockets.length = 0;
    });

    it("keeps at most three subscribe frames in flight on reconnect, releasing one slot per ack", () => {
        expect.assertions(6);

        const client = makeClient();
        const first = subscribeMany(client, 9);

        first.open();

        // Drain the FIRST open so the reconnect below starts from a clean,
        // fully-acked registry — the burst under test is the resend, not the
        // initial subscribe.
        ackEveryFrame(first);

        expect(subscribeIds(first)).toHaveLength(9);

        const second = reconnect(first);

        second.open();

        // The whole point: nine subscriptions, three frames.
        expect(subscribeIds(second)).toHaveLength(WINDOW);

        // One ack frees exactly one slot.
        const ackedFirst = subscribeIds(second)[0] as string;

        second.receive({ id: ackedFirst, type: "ack" });

        expect(subscribeIds(second)).toHaveLength(WINDOW + 1);

        // A `data` frame is just as good an answer as an `ack` — the drain must
        // not depend on which one the server chose to send first.
        const ackedSecond = subscribeIds(second)[1] as string;

        second.receive({ cursor: 1, data: [], id: ackedSecond, type: "data" });

        expect(subscribeIds(second)).toHaveLength(WINDOW + 2);

        // Acking the rest drains all nine, never more than the window at a time.
        const batches = ackEveryFrame(second, [ackedFirst, ackedSecond]);

        expect(Math.max(...batches.map((batch) => batch.length))).toBeLessThanOrEqual(WINDOW);
        expect(new Set(subscribeIds(second)).size).toBe(9);

        client.close();
    });

    it("moves on when a sent subscribe is never answered, instead of wedging the rest forever", () => {
        expect.assertions(3);

        const client = makeClient();
        const first = subscribeMany(client, 5);

        first.open();

        ackEveryFrame(first);

        const second = reconnect(first);

        second.open();

        // Three on the wire, two waiting — and the server answers none of them.
        expect(subscribeIds(second)).toHaveLength(WINDOW);

        vi.advanceTimersByTime(ACK_TIMEOUT_MS);

        // The watchdog released all three stalled slots, so the two stragglers
        // went out. Without it those queries would sit dark forever.
        expect(subscribeIds(second)).toHaveLength(5);
        expect(new Set(subscribeIds(second)).size).toBe(5);

        client.close();
    });

    it("re-sends everything on the next open when the socket closes mid-drain", () => {
        expect.assertions(3);

        const client = makeClient();
        const first = subscribeMany(client, 7);

        first.open();

        ackEveryFrame(first);

        const second = reconnect(first);

        second.open();

        expect(subscribeIds(second)).toHaveLength(WINDOW);

        // Drop the socket with three frames unanswered and four still queued.
        // The in-flight slots belong to a socket that no longer exists; if they
        // were not released, the next connection would resubscribe nothing.
        const third = reconnect(second);

        third.open();

        expect(subscribeIds(third)).toHaveLength(WINDOW);

        ackEveryFrame(third);

        expect(new Set(subscribeIds(third)).size).toBe(7);

        client.close();
    });

    it("paces the cross-tab leader handover, which replays every tab's subscriptions at once", () => {
        expect.assertions(2);

        const client = new LunoraClient({
            crossTabSync: true,
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        for (let index = 0; index < 8; index += 1) {
            client.subscribe(fnRef(`queries:q${String(index)}`), {}, () => undefined);
        }

        // A sole tab self-promotes once the leader-claim window elapses; that
        // fires `onBecomeLeader`, which opens the sockets and replays every
        // subscription it holds.
        vi.advanceTimersByTime(5000);

        const socket = latestSocket();

        socket.open();

        expect(subscribeIds(socket)).toHaveLength(WINDOW);

        socket.receive({ id: subscribeIds(socket)[0], type: "ack" });

        expect(subscribeIds(socket)).toHaveLength(WINDOW + 1);

        client.close();
    });
});
