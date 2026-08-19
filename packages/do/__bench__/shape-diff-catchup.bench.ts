import type { DatabaseWriterLike } from "@lunora/shard-engine";
import {
    createShapeDiffCache,
    createShardCtxDb as createShardContextDatabase,
    readCdcCursor,
    runShardMigrations,
    selectShapeMembers,
} from "@lunora/shard-engine";
import { bench, describe } from "vitest";

import createSqliteExec from "../__tests__/_helpers/node-sqlite";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

/**
 * The shape catch-up diff: given a client's checkpoint and the current head,
 * work out which rows of its shape moved and what to send it.
 *
 * The cost that matters is not the number of rows the client gets back — it is
 * how much the shard reads to decide that. A one-stage diff drained the whole
 * op range WITH post-images and filtered afterwards, so a client catching up
 * over a large range paid for every document written in it, including every
 * document belonging to a channel it cannot see. The two-stage pipeline reads
 * keys first and hydrates only what survives the predicate.
 *
 * Three axes are varied independently so the cost model is legible:
 *
 * - **range size, one op per row** — every extra op is also an extra key, so
 * this is the case where nothing can be collapsed and cost necessarily grows.
 * - **range size, constant key set** — 200 rows re-written until the range is
 * 20× longer. Cost grows sublinearly (a 20× range costs ~5×), because what is
 * left to pay is the index range scan; the post-images that used to dominate
 * it are never read.
 * - **selectivity** — 1% vs 100% of a fixed range inside the shape, isolating
 * the hydration half. This is the axis that SHOULD cost more, because it is
 * the one that decides how much is actually shipped.
 *
 * Read together they say: you pay for the range you scan and the rows you ship,
 * and no longer for the documents in between.
 */

const benchSchema = {
    tables: {
        messages: {
            indexes: [{ fields: ["channelId"], name: "by_channel" }],
            shape: { authorId: { kind: "string" }, channelId: { kind: "string" }, text: { kind: "string" } },
        },
    },
} as unknown as Parameters<typeof runShardMigrations>[1];

/** Exposes the private diff over a resolved shape, plus the raw member probe for the seed comparison. */
class DiffBenchShard extends ShardDO {
    public readonly exec: Parameters<typeof createShardContextDatabase>[0]["sql"];

    public constructor(state: ShardDOState, sql: Parameters<typeof createShardContextDatabase>[0]["sql"]) {
        super(state, {});
        this.exec = sql;
    }

    // eslint-disable-next-line class-methods-use-this -- bench stub; the diff never dispatches an RPC
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve(null);
    }

    /** One catch-up diff of `channelId`'s shape over the whole retained range. */
    public diff(channelId: string): number {
        const resolved = { effectiveWhere: { channelId }, table: "messages" };

        // `buildShapeDiff` is private; the bench drives it through the same
        // protected seam the poke path and its tests use, so what is measured is
        // the shipped code path rather than a re-implementation of it.
        return (
            this as unknown as {
                buildShapeDiff: (sql: unknown, resolved: unknown, sinceSeq: number, upTo: number, cache?: ReturnType<typeof createShapeDiffCache>) => unknown[];
            }
        ).buildShapeDiff(this.exec, resolved, 0, readCdcCursor(this.exec), createShapeDiffCache()).length;
    }
}

/**
 * A shard whose changelog holds `changes` ops spread over `distinctRows` rows —
 * so a large range can carry a small key set, which is the case the collapse
 * exists for. Documents are padded so hydrating one is measurably more expensive
 * than listing its key.
 */
const buildRepeatedWriteShard = async (changes: number, distinctRows: number): Promise<DiffBenchShard> => {
    const harness = createSqliteExec();

    runShardMigrations(harness.sql, benchSchema, { cdc: true });

    const writer: DatabaseWriterLike = createShardContextDatabase({
        broadcast: () => undefined,
        cdc: true,
        clock: () => 1_700_000_000_000,
        schema: benchSchema,
        sql: harness.sql,
    });

    for (let index = 0; index < distinctRows; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- the row set has to exist before it can be re-written
        await writer.insert(
            "messages",
            { _id: `m${String(index)}`, authorId: "u1", channelId: "watched", text: `t${String(index)}`.padEnd(512, "x") },
            { allowExplicitId: true },
        );
    }

    for (let index = distinctRows; index < changes; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential re-writes lengthen the RANGE without widening the key set
        await writer.patch(`m${String(index % distinctRows)}`, { text: `t${String(index)}`.padEnd(512, "x") });
    }

    const state: ShardDOState = {
        acceptWebSocket() {
            /* no sockets: the diff is measured directly */
        },
        getWebSockets() {
            return [];
        },
        id: { name: "bench-shard" },
        storage: { sql: harness.sql },
    } as unknown as ShardDOState;

    return new DiffBenchShard(state, harness.sql);
};

/**
 * A shard whose `messages` table holds `changes` rows, `inShapePercent` of them
 * in the watched channel. Documents are padded so hydrating one is measurably
 * more expensive than listing its key — which is the whole premise of hydrating
 * late.
 */
const buildShard = async (changes: number, inShapePercent: number): Promise<DiffBenchShard> => {
    const harness = createSqliteExec();

    runShardMigrations(harness.sql, benchSchema, { cdc: true });

    const writer: DatabaseWriterLike = createShardContextDatabase({
        broadcast: () => undefined,
        cdc: true,
        clock: () => 1_700_000_000_000,
        schema: benchSchema,
        sql: harness.sql,
    });

    for (let index = 0; index < changes; index += 1) {
        const inShape = index % 100 < inShapePercent;

        // eslint-disable-next-line no-await-in-loop -- sequential writes build one contiguous changelog range
        await writer.insert(
            "messages",
            {
                _id: `m${String(index)}`,
                authorId: "u1",
                channelId: inShape ? "watched" : `other-${String(index % 7)}`,
                text: `t${String(index)}`.padEnd(512, "x"),
            },
            { allowExplicitId: true },
        );
    }

    const state: ShardDOState = {
        acceptWebSocket() {
            /* no sockets: the diff is measured directly */
        },
        getWebSockets() {
            return [];
        },
        id: { name: "bench-shard" },
        storage: { sql: harness.sql },
    } as unknown as ShardDOState;

    return new DiffBenchShard(state, harness.sql);
};

describe("shape catch-up diff — cost vs range size (1% of the range is in the shape)", async () => {
    const small = await buildShard(1000, 1);
    const medium = await buildShard(5000, 1);
    const large = await buildShard(20_000, 1);

    bench("1 000 changes behind", () => {
        small.diff("watched");
    });

    bench("5 000 changes behind", () => {
        medium.diff("watched");
    });

    bench("20 000 changes behind", () => {
        large.diff("watched");
    });
});

describe("shape catch-up diff — cost vs selectivity (5 000 changes behind)", async () => {
    const selective = await buildShard(5000, 1);
    const half = await buildShard(5000, 50);
    const everything = await buildShard(5000, 100);

    bench("1% of the range is in the shape", () => {
        selective.diff("watched");
    });

    bench("50% of the range is in the shape", () => {
        half.diff("watched");
    });

    bench("100% of the range is in the shape", () => {
        everything.diff("watched");
    });
});

describe("shape catch-up diff — cost vs range size with a CONSTANT key set (200 rows, re-written)", async () => {
    const shortRange = await buildRepeatedWriteShard(1000, 200);
    const longRange = await buildRepeatedWriteShard(20_000, 200);

    // Both diffs ship the same 200 rows. The only difference is how many ops the
    // range holds — which is what the collapse is for, and what the drain this
    // replaced paid for in full (every op, every post-image).
    bench("1 000 ops over 200 rows", () => {
        shortRange.diff("watched");
    });

    bench("20 000 ops over 200 rows", () => {
        longRange.diff("watched");
    });
});

describe("membership probe — the fused filter+hydrate read", async () => {
    const shard = await buildShard(5000, 1);
    const ids = Array.from({ length: 500 }, (_, index) => `m${String(index)}`);

    bench("probe 500 ids against a channel predicate", () => {
        selectShapeMembers(shard.exec, "messages", { channelId: "watched" }, ids);
    });
});
