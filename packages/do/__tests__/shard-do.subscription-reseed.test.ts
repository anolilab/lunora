/**
 * Two ways a subscription seed used to hand the client the wrong value.
 *
 * 1. A seed that parks on non-storage I/O (a `.global()` D1 read, vectors, R2 —
 * the input gate is open there) while a write commits: the write's refresh
 * pushes the post-write value, and the seed then pushed its pre-write result
 * over it. The real-runtime half, including the cursor the frame carries, is
 * `workerd/subscription-seed-race.workerd.test.ts`.
 * 2. A `subscribe` for an id the socket already holds — the client's
 * re-snapshot request after a delta it could not merge. It was answered
 * `settled` (diffed against the memo the client just discarded), and refused
 * with TOO_MANY_SUBSCRIPTIONS on a socket at the cap.
 */
import type { SocketAttachment } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { ShardDOState, SubscriptionOutcome } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

/** The per-socket subscription ceiling (a protected static on the shard). */
const SUBSCRIPTION_CAP = 32;

interface FakeWebSocket {
    attachment: SocketAttachment | undefined;
    close: () => void;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

interface Frame {
    data?: unknown;
    id?: string;
    type: string;
}

const createFakeWebSocket = (): FakeWebSocket => {
    return {
        attachment: { subs: {} },
        close() {},
        deserializeAttachment() {
            return this.attachment;
        },
        send(data: string) {
            this.sent.push(data);
        },
        sent: [],
        serializeAttachment(value: unknown) {
            this.attachment = value as SocketAttachment;
        },
    };
};

/** A shard over an in-memory `messages` list; `handleRpc` appends one row, as a committed write. */
class ListShard extends ShardDO {
    public rows: string[] = ["old"];

    /** When set, the FIRST run reads the rows and then parks here — the seed's remote I/O. */
    public seedGate: Promise<void> | undefined;

    private runs = 0;

    public override async handleRpc(): Promise<unknown> {
        this.rows = [...this.rows, `row-${String(this.rows.length)}`];
        this.recordChangedTable("messages");

        return { ok: true };
    }

    protected override async executeSubscription(): Promise<SubscriptionOutcome | null> {
        this.runs += 1;

        const snapshot = [...this.rows];

        if (this.runs === 1 && this.seedGate) {
            await this.seedGate;
        }

        return { result: snapshot, tables: new Set(["messages"]) };
    }
}

const setup = (): {
    frames: (id: string) => Frame[];
    send: (frame: unknown) => Promise<void>;
    shard: ListShard;
    write: () => Promise<Response>;
    ws: FakeWebSocket;
} => {
    const sockets: FakeWebSocket[] = [];
    const state = {
        acceptWebSocket(ws: unknown) {
            sockets.push(ws as FakeWebSocket);
        },
        getWebSockets() {
            return sockets as unknown as WebSocket[];
        },
        storage: {
            sql: {
                exec: () => {
                    return { one: () => undefined, toArray: () => [], [Symbol.iterator]: [][Symbol.iterator] };
                },
            },
        },
    } as unknown as ShardDOState;
    const shard = new ListShard(state, {});
    const ws = createFakeWebSocket();

    sockets.push(ws);

    return {
        frames: (id) => ws.sent.map((line) => JSON.parse(line) as Frame).filter((frame) => frame.id === id),
        send: (frame) => shard.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(frame)),
        shard,
        write: () =>
            shard.fetch(
                new Request("https://shard.internal/rpc", {
                    body: JSON.stringify({ args: {}, functionPath: "messages:send" }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
            ),
        ws,
    };
};

const subscribe = (id: string, args: Record<string, unknown> = {}): unknown => {
    return { id, query: { args, functionPath: "messages:list" }, type: "subscribe" };
};

describe("subscription seed racing a write", () => {
    it("does not push the seed's pre-write value over the refresh's post-write one", async () => {
        expect.assertions(1);

        const { frames, send, shard, write } = setup();
        let release!: () => void;

        shard.seedGate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const seeding = send(subscribe("s1"));

        // The seed has read ["old"] and is parked. A write commits and flushes.
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        await write();

        release();
        await seeding;

        const values = frames("s1").filter((frame) => frame.type === "data" || frame.type === "delta");

        expect(values.map((frame) => frame.data)).toStrictEqual([["old", "row-1"]]);
    });
});

describe("re-subscribing an id the socket already holds", () => {
    it("answers with a full snapshot rather than `settled`", async () => {
        expect.assertions(2);

        const { frames, send, ws } = setup();

        await send(subscribe("s1"));
        ws.sent.length = 0;

        await send(subscribe("s1"));

        expect(frames("s1").map((frame) => frame.type)).toStrictEqual(["ack", "data"]);
        expect(frames("s1")[1]?.data).toStrictEqual(["old"]);
    });

    it("is not refused at the subscription cap, while a new id still is", async () => {
        expect.assertions(3);

        const { frames, send, ws } = setup();

        for (let index = 0; index < SUBSCRIPTION_CAP; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- one socket, subscribed in order
            await send(subscribe(`s${String(index)}`, { index }));
        }

        ws.sent.length = 0;

        await send(subscribe("s5", { index: 5 }));
        await send(subscribe("overflow", { index: -1 }));

        expect(frames("s5").map((frame) => frame.type)).toStrictEqual(["ack", "data"]);
        expect(frames("overflow").map((frame) => frame.type)).toStrictEqual(["error"]);
        expect(Object.keys((ws.attachment as SocketAttachment).subs)).toHaveLength(SUBSCRIPTION_CAP);
    });
});
