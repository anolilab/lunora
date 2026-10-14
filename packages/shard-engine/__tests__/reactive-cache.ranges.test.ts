/**
 * End-to-end proof of range-precise invalidation: a live query that reads one
 * index slice must survive writes landing in other slices, and must still be
 * invalidated by writes inside its own — including a patch that MOVES a row
 * across the boundary.
 *
 * Runs against node's experimental SQLite (like the other ctx-db tests) so the
 * reader's real staged plan, the real dep stamping, and the real write-path
 * invalidation all participate.
 */
import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike, SqlExec } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { createDependencyTracker } from "../src/dependency-tracker";
import { ReactiveCache } from "../src/reactive-cache";
import { createReadFootprint } from "../src/read-footprint";

interface NodeStatement {
    all: (...params: unknown[]) => Record<string, unknown>[];
}

const makeSql = (): SqlExec => {
    const database = new DatabaseSync(":memory:");

    return {
        exec: <Row = Record<string, unknown>>(sqlText: string, ...params: unknown[]) => {
            const stmt = database.prepare(sqlText) as unknown as NodeStatement;
            const rows = stmt.all(...params) as unknown as Row[];

            return {
                one: () => rows[0] as Row,
                [Symbol.iterator]: () => rows[Symbol.iterator](),
                toArray: () => rows,
            };
        },
    };
};

const schema: SchemaLike = {
    tables: {
        messages: {
            indexes: [{ fields: ["channelId", "seq"], name: "by_channel_seq" }],
            shape: {
                body: { kind: "string" },
                channelId: { kind: "string" },
                seq: { kind: "number" },
            },
        },
    },
};

/** The tracker the `onRead` hook below stamps into; set for the duration of a cached run. */
let tracker: ReturnType<typeof createDependencyTracker> | undefined;

/** Collects the ranges an indexed read reports, mirroring the generated subscription path. */
let footprint: ReturnType<typeof createReadFootprint> | undefined;

let sql: SqlExec;
let cache: ReactiveCache;
let writer: DatabaseWriterLike;

describe("range-precise reactive invalidation", () => {
    beforeEach(() => {
        sql = makeSql();
        runShardMigrations(sql, schema);
        cache = new ReactiveCache();
        writer = createShardContextDatabase({
            cache,
            clock: () => 1_700_000_000_000,
            onRead: (table, idOrScan) => {
                footprint?.onRead(table);
                tracker?.recordRead(table, idOrScan ?? "*scan");
            },
            onReadRange: (range) => footprint?.onReadRange(range),
            schema,
            sql,
        });
    });

    /**
     * Run `read` under a fresh dependency tracker and memoize it in the cache,
     * exactly as `ShardDO#runCachedQuery` does.
     */
    const cacheRead = async (key: string, read: () => Promise<unknown>): Promise<void> => {
        tracker = createDependencyTracker();
        footprint = createReadFootprint();

        try {
            // The ranges thunk is evaluated after `read` resolves, mirroring how
            // the generated subscription reports its own footprint.
            await cache.run(key, tracker.collect(), read, () => [...(footprint?.ranges()?.values() ?? [])].flat());
        } finally {
            tracker = undefined;
            footprint = undefined;
        }
    };

    /** Is `key` still memoized? `run` only re-invokes the callback on a miss. */
    const isCached = async (key: string): Promise<boolean> => {
        let ran = false;

        await cache.run(key, new Set<string>(), async () => {
            ran = true;

            return null;
        });

        return !ran;
    };

    const readChannel = async (channelId: string): Promise<void> => {
        await cacheRead(`q:${channelId}`, async () =>
            writer
                .query("messages")
                .withIndex("by_channel_seq", (q) => q.eq("channelId", channelId))
                .collect(),
        );
    };

    it("keeps a channel's cached query alive when another channel is written", async () => {
        expect.assertions(2);

        await writer.insert("messages", { body: "hi", channelId: "A", seq: 1 });
        await readChannel("A");

        await writer.insert("messages", { body: "elsewhere", channelId: "B", seq: 1 });

        // The whole point: B's write is outside A's slice, so A's subscribers
        // must not be woken.
        await expect(isCached("q:A")).resolves.toBe(true);

        await writer.insert("messages", { body: "here", channelId: "A", seq: 2 });

        await expect(isCached("q:A")).resolves.toBe(false);
    });

    it("invalidates both slices when a patch moves a row across the boundary", async () => {
        expect.assertions(2);

        const moved = await writer.insert("messages", { body: "m", channelId: "A", seq: 1 });

        await readChannel("A");
        await readChannel("B");

        await writer.patch(moved, { channelId: "B" });

        // The row left A and entered B; a subscriber on either side sees a
        // different result, so neither cached entry may survive. Only the
        // before-image proves the first half.
        await expect(isCached("q:A")).resolves.toBe(false);
        await expect(isCached("q:B")).resolves.toBe(false);
    });

    it("invalidates a bounded window only for writes inside it", async () => {
        expect.assertions(2);

        await writer.insert("messages", { body: "m", channelId: "A", seq: 10 });

        const readWindow = async (): Promise<void> => {
            await cacheRead("q:window", async () =>
                writer
                    .query("messages")
                    .withIndex("by_channel_seq", (q) => q.eq("channelId", "A").gte("seq", 10).lt("seq", 20))
                    .collect(),
            );
        };

        await readWindow();
        await writer.insert("messages", { body: "after", channelId: "A", seq: 25 });

        await expect(isCached("q:window")).resolves.toBe(true);

        await readWindow();
        await writer.insert("messages", { body: "inside", channelId: "A", seq: 15 });

        await expect(isCached("q:window")).resolves.toBe(false);
    });

    it("still invalidates on every write when the read could not be narrowed", async () => {
        expect.assertions(1);

        await writer.insert("messages", { body: "m", channelId: "A", seq: 1 });

        // No index — the dep degrades to the table's `*scan`, so any write
        // anywhere in the table must invalidate it.
        await cacheRead("q:scan", async () => writer.query("messages").collect());
        await writer.insert("messages", { body: "other", channelId: "B", seq: 1 });

        await expect(isCached("q:scan")).resolves.toBe(false);
    });
});
