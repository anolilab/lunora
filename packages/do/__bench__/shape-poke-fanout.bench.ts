import type { DatabaseWriterLike, SchemaLike, SocketAttachment } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase } from "@lunora/shard-engine";
import { bench, describe } from "vitest";

import { ShardDO } from "../src/shard-do";
import { makeCdcShardFixture } from "./shared";

/**
 * One write's shape-poke fan-out across N subscribed sockets.
 *
 * The membership probe behind each poke is keyed by `(table, predicate, ids)`
 * and names no socket, so subscribers of the same shape were issuing byte-
 * identical queries within one flush — a hundred sockets, a hundred copies of
 * one answer. The per-flush cache collapses them.
 *
 * The two suites below measure DIFFERENT things and their totals are not
 * comparable, which is the whole reason they are labelled the way they are:
 *
 * - **shared predicate, every socket delivered** — one probe plus N sends. This
 * is the end-to-end cost of the case the cache exists for, and its curve
 * against socket count is what shows the probe dropping out of it.
 * - **distinct predicates, nothing delivered** — the write lands in a channel no
 * socket subscribes to, so every socket runs its own probe and none receives a
 * poke. That isolates the per-socket probe: the cache's miss path with the
 * send cost removed.
 *
 * An earlier revision presented the second as "the floor to compare the shared
 * case against", which it is not: subtracting a delivery-free number from a
 * delivery-inclusive one attributes the sends to the probe. If you want the
 * marginal cost of sharing, read the shared suite's own slope across 10 → 500
 * sockets; if you want the probe, read the second suite directly.
 */

interface FakeWebSocket {
    attachment: SocketAttachment | undefined;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    serializeAttachment: (value: unknown) => void;
}

const createFakeWebSocket = (connectionId: string, channelId: string): FakeWebSocket => {
    return {
        attachment: { connectionId, shapes: { s1: { args: { channelId }, name: "messagesByChannel" } }, subs: {} },
        deserializeAttachment() {
            return this.attachment;
        },
        send(_data: string) {
            /* discard — the fan-out loop and its reads are what is measured, not socket IO */
        },
        serializeAttachment(value: unknown) {
            this.attachment = value as SocketAttachment | undefined;
        },
    };
};

const benchSchema = {
    tables: {
        messages: {
            indexes: [{ fields: ["channelId"], name: "by_channel" }],
            shape: { authorId: { kind: "string" }, channelId: { kind: "string" }, text: { kind: "string" } },
        },
    },
} as unknown as SchemaLike;

/** A shard whose only shape is `messagesByChannel(channelId)`, driven one write at a time. */
class FanoutBenchShard extends ShardDO {
    private writer: DatabaseWriterLike | undefined;

    public override async handleRpc(_functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        await this.getWriter().insert(
            "messages",
            { _id: args["_id"], authorId: "u1", channelId: args["channelId"], text: String(args["_id"]).padEnd(512, "x") },
            { allowExplicitId: true },
        );

        this.recordChangedTable("messages");

        return { ok: true };
    }

    // eslint-disable-next-line class-methods-use-this -- bench stub override: resolves by `name`/`args` alone, no instance state
    protected override resolveShape(name: string, args: Record<string, unknown>): { effectiveWhere?: Record<string, unknown>; table: string } | undefined {
        if (name !== "messagesByChannel") {
            return undefined;
        }

        return { effectiveWhere: { channelId: args["channelId"] }, table: "messages" };
    }

    private getWriter(): DatabaseWriterLike {
        this.writer ??= createShardContextDatabase({
            broadcast: () => undefined,
            cdc: true,
            clock: () => 1_700_000_000_000,
            schema: benchSchema,
            sql: this.sql as Parameters<typeof createShardContextDatabase>[0]["sql"],
        });

        return this.writer;
    }
}

/**
 * A shard with `sockets` subscribers, all written to through `next()`.
 *
 * With `sharedChannel`, every socket resolves to the same predicate AND the write
 * lands inside it, so all of them are poked. Without it, each socket watches its
 * own channel while the write still lands in `watched` — so every socket runs a
 * probe and none of them matches, which is deliberately a probe-only measurement
 * rather than a like-for-like fan-out.
 */
const buildShard = (sockets: number, sharedChannel: boolean): { next: () => Request; shard: FanoutBenchShard } => {
    const list: FakeWebSocket[] = [];
    const { state } = makeCdcShardFixture(benchSchema, list);

    for (let index = 0; index < sockets; index += 1) {
        list.push(createFakeWebSocket(`conn-${String(index)}`, sharedChannel ? "watched" : `channel-${String(index)}`));
    }

    let sequence = 0;

    return {
        next: () => {
            sequence += 1;

            return new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: { _id: `m${String(sequence)}`, channelId: "watched" }, functionPath: "messages:send" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            });
        },
        shard: new FanoutBenchShard(state, {}),
    };
};

describe("shape poke fan-out — one write, N subscribers on the SAME predicate (one probe, N deliveries)", () => {
    const few = buildShard(10, true);
    const many = buildShard(100, true);
    const crowd = buildShard(500, true);

    bench("10 sockets", async () => {
        await few.shard.fetch(few.next());
    });

    bench("100 sockets", async () => {
        await many.shard.fetch(many.next());
    });

    bench("500 sockets", async () => {
        await crowd.shard.fetch(crowd.next());
    });
});

describe("membership probe alone — one write, N subscribers on DISTINCT predicates none of which match it (N probes, no delivery)", () => {
    const few = buildShard(10, false);
    const many = buildShard(100, false);

    bench("10 sockets", async () => {
        await few.shard.fetch(few.next());
    });

    bench("100 sockets", async () => {
        await many.shard.fetch(many.next());
    });
});
