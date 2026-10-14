import type { MutationDelta, SocketAttachment, SubscriptionQuery } from "@lunora/shard-engine";
import { bench, describe } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

/**
 * `broadcastDelta` runs O(sockets × subscriptions) for every mutation. That
 * loop is the bottleneck for fan-out workloads (think a busy channel with
 * hundreds of viewers). The bench captures both:
 *
 * - **Low fanout** — a handful of sockets, the realistic small-room case.
 * - **High fanout** — 500 sockets, 1 sub each, all on the matching table.
 * - **Selective fanout** — 500 sockets but most subscribe to a different
 * table, exercising the cheap-reject branch in `matchesSubscription`.
 * - **Filter by args** — 100 sockets where the args narrow to ~10% match.
 *
 * The DO state is a hand-rolled fake: no Workers runtime needed, the bench
 * stays a pure node process and isolates the hot loop.
 */

interface FakeWebSocket {
    attachment: SocketAttachment | undefined;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    serializeAttachment: (value: unknown) => void;
}

const createFakeWebSocket = (subs: Record<string, SubscriptionQuery>): FakeWebSocket => {
    const ws: FakeWebSocket = {
        attachment: { subs },
        deserializeAttachment() {
            return this.attachment;
        },
        send(_data: string) {
            /* discard — we measure the routing loop, not socket IO. */
        },
        serializeAttachment(value: unknown) {
            this.attachment = value as SocketAttachment | undefined;
        },
    };

    return ws;
};

const createFakeState = (sockets: FakeWebSocket[]): ShardDOState => {
    return {
        acceptWebSocket(ws) {
            sockets.push(ws as unknown as FakeWebSocket);
        },
        getWebSockets() {
            return sockets as unknown as WebSocket[];
        },
        id: { name: "bench-shard" },
        storage: { sql: { exec: () => undefined } },
    };
};

class BenchShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- bench stub; broadcastDelta never dispatches an RPC
    public override async handleRpc(): Promise<unknown> {
        return null;
    }

    public emit(delta: MutationDelta): void {
        this.broadcastDelta(delta);
    }
}

const buildShard = (sockets: FakeWebSocket[]): BenchShard => new BenchShard(createFakeState(sockets), {});

const deltaMatching: MutationDelta = {
    key: "m1",
    op: "insert",
    row: { channelId: "channels:c1", id: "m1" },
    table: "messages",
};
const deltaDelete: MutationDelta = {
    key: "m1",
    op: "delete",
    table: "messages",
};

describe("broadcastDelta — fan-out", () => {
    const lowSockets: FakeWebSocket[] = [];
    const lowShard = buildShard(lowSockets);

    for (let index = 0; index < 5; index += 1) {
        lowSockets.push(createFakeWebSocket({ [`sub-${String(index)}`]: { table: "messages" } }));
    }

    bench("low fanout — 5 sockets × 1 sub each, table match", () => {
        lowShard.emit(deltaMatching);
    });

    const highSockets: FakeWebSocket[] = [];
    const highShard = buildShard(highSockets);

    for (let index = 0; index < 500; index += 1) {
        highSockets.push(createFakeWebSocket({ [`sub-${String(index)}`]: { table: "messages" } }));
    }

    bench("high fanout — 500 sockets × 1 sub each, table match", () => {
        highShard.emit(deltaMatching);
    });

    const mixedSockets: FakeWebSocket[] = [];
    const mixedShard = buildShard(mixedSockets);

    for (let index = 0; index < 500; index += 1) {
        // 90% of sockets subscribe to a different table — exercises the
        // cheap-reject in `matchesSubscription`.
        const table = index % 10 === 0 ? "messages" : "documents";

        mixedSockets.push(createFakeWebSocket({ [`sub-${String(index)}`]: { table } }));
    }

    bench("selective fanout — 500 sockets, 10% match the delta's table", () => {
        mixedShard.emit(deltaMatching);
    });
});

describe("broadcastDelta — args filter", () => {
    const sockets: FakeWebSocket[] = [];
    const shard = buildShard(sockets);

    // 100 sockets, all subscribing to `messages`, but each pinned to a
    // different channelId. Only ~1 should match the delta's channelId.
    for (let index = 0; index < 100; index += 1) {
        sockets.push(
            createFakeWebSocket({
                [`sub-${String(index)}`]: { args: { channelId: `channels:c${String(index)}` }, table: "messages" },
            }),
        );
    }

    bench("100 sockets, args narrow to single match", () => {
        shard.emit(deltaMatching);
    });
});

describe("broadcastDelta — delete fallback", () => {
    const sockets: FakeWebSocket[] = [];
    const shard = buildShard(sockets);

    for (let index = 0; index < 100; index += 1) {
        sockets.push(
            createFakeWebSocket({
                [`sub-${String(index)}`]: { args: { channelId: "channels:c1" }, table: "messages" },
            }),
        );
    }

    bench("100 sockets, delete with no row → broadcast-all path", () => {
        shard.emit(deltaDelete);
    });
});
