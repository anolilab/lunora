import type { SchemaLike as VectorSchemaLike, VectorSearchLike } from "@lunora/bindings/vectors";
import { createVectorSyncHook, vectorBackfillTargets } from "@lunora/bindings/vectors";
import type { OrderedAfterWrites, SchemaLike, SqlExec, VectorBackfillProgress, WriteHook } from "@lunora/shard-engine";
import { ADMIN_FUNCTIONS, backfillVectorIndexes, createShardCtxDb, runShardMigrations, VECTOR_BACKFILL_PAGE_ROWS } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * `__lunora_admin__:backfillVectors` against the real single-writer gate and
 * after-commit chain.
 *
 * The property that matters is the race: a backfill page reads a row, then spends
 * a remote embed on it. A write committed in that window must win — its vector (or
 * its delete) has to be what the index ends up holding, not the page's stale
 * snapshot. The in-memory index is more permissive than Vectorize (no request
 * limits, writes visible at once); the ordering guarantee is the shard's own and
 * does not lean on either.
 */

const ADMIN_TOKEN = "s3cret-admin";

/** Swapped per test: lets a test hold a page's embeds open while writes commit. */
let embedder: (text: string) => Promise<ReadonlyArray<number>>;

const schema = {
    tables: {
        posts: {
            indexes: [],
            shape: { body: { kind: "string" } },
            vectorIndexes: [{ embed: async (text: string) => embedder(text), field: "body", name: "posts_body" }],
        },
    },
    vectorIndexes: {},
} as never as SchemaLike & VectorSchemaLike;

let database: ReturnType<typeof createSqliteExec>;

const makeState = (): ShardDOState => {
    // The single-writer gate, for real (see `shard-do.write-hook-after-commit.test.ts`).
    let gate: Promise<void> = Promise.resolve();

    return {
        acceptWebSocket: () => undefined,
        blockConcurrencyWhile: async <R>(callback: () => Promise<R>): Promise<R> => {
            const previous = gate;
            let release = (): void => undefined;

            gate = new Promise<void>((resolve) => {
                release = resolve;
            });

            await previous;

            try {
                return await callback();
            } finally {
                release();
            }
        },
        getWebSockets: () => [],
        id: { name: "shard-a" },
        storage: {
            sql: database.sql as unknown as ShardDOState["storage"]["sql"],
            transaction: async <R>(closure: () => Promise<R>): Promise<R> => {
                database.raw("BEGIN");

                try {
                    const value = await closure();

                    database.raw("COMMIT");

                    return value;
                } catch (error) {
                    database.raw("ROLLBACK");

                    throw error;
                }
            },
        },
    } as unknown as ShardDOState;
};

const memoryVectors = (): VectorSearchLike & { store: Map<string, string> } => {
    const store = new Map<string, string>();
    const put = async (_index: string, input: { embed: (text: string) => unknown; id: string; input: string }): Promise<void> => {
        await input.embed(input.input);
        store.set(input.id, input.input);
    };

    return {
        deleteByIds: async (_index, ids) => {
            for (const id of ids) {
                store.delete(id);
            }
        },
        getByIds: async () => [],
        query: async () => {
            return { count: store.size, matches: [] };
        },
        store,
        upsert: put,
        upsertNow: put,
    };
};

class VectorShard extends ShardDO {
    public readonly vectors = memoryVectors();

    public readonly hook: WriteHook = createVectorSyncHook({ allowSharedNamespace: true, schema, vectors: this.vectors });

    /** Swap in the unordered read-then-work to prove the race is real. */
    public ordered?: OrderedAfterWrites;

    public constructor(state: ShardDOState) {
        super(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
    }

    // eslint-disable-next-line class-methods-use-this -- override stub; admin RPCs never dispatch through it
    public override handleRpc(): Promise<unknown> {
        return Promise.reject(new Error("handleRpc must not run for admin RPCs"));
    }

    /** A mutation exactly as the emitter wires it: hook held until the commit. */
    public async mutate(write: (db: ReturnType<typeof createShardCtxDb>) => Promise<unknown>): Promise<void> {
        const db = createShardCtxDb({
            inTransaction: () => this.isInTransaction(),
            onWrite: (event) => this.deferAfterCommit(() => this.hook(event)),
            schema,
            sql: this.sql as SqlExec,
        });

        await this.runInTransaction(() => write(db));
    }

    protected override runShardVectorBackfill(options: { maxPages?: number; restart?: boolean }): Promise<VectorBackfillProgress> {
        return backfillVectorIndexes(this.sql as SqlExec, vectorBackfillTargets(schema), this.hook, {
            ...options,
            ordered: this.ordered ?? (async (read, work) => this.runOrderedAfterWrites(read, work)),
        });
    }
}

const adminRequest = (args: Record<string, unknown>, token: string | null = ADMIN_TOKEN): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args, functionPath: ADMIN_FUNCTIONS.backfillVectors }),
        headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
        method: "POST",
    });

describe("backfillVectors admin RPC", () => {
    beforeEach(() => {
        database = createSqliteExec();
        embedder = async (text) => [text.length];
        runShardMigrations(database.sql, schema);
    });

    afterEach(() => {
        database.close();
    });

    const seed = async (count: number): Promise<void> => {
        let n = 0;
        const writer = createShardCtxDb({
            idGenerator: () => {
                n += 1;

                return `p_${String(n).padStart(4, "0")}`;
            },
            schema,
            sql: database.sql,
        });

        for (let index = 0; index < count; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential ids
            await writer.insert("posts", { body: `old ${String(index)}` });
        }
    };

    const status = async (shard: VectorShard, args: Record<string, unknown>, token?: string | null): Promise<number> => {
        const response = await shard.fetch(adminRequest(args, token));

        return response.status;
    };

    /**
     * Seed three rows, hold a backfill page open on its embeds (after it read its
     * snapshot), commit a patch of p_0001 and a delete of p_0002, then let the page
     * finish. Reports what the index ends up holding for those two rows.
     */
    const raceWritesAgainstPage = async (unordered: boolean): Promise<{ deletedRowHasVector: boolean; patched: string | undefined }> => {
        await seed(3);

        const shard = new VectorShard(makeState());

        if (unordered) {
            shard.ordered = async (read, work) => work(read());
        }

        let release = (): void => undefined;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let reached = (): void => undefined;
        const embedding = new Promise<void>((resolve) => {
            reached = resolve;
        });

        embedder = async (text) => {
            if (text.startsWith("old ")) {
                reached();
                await held;
            }

            return [text.length];
        };

        const backfill = shard.fetch(adminRequest({}));

        await embedding;

        const patch = shard.mutate(async (db) => db.patch("p_0001", { body: "new body" }));
        const remove = shard.mutate(async (db) => db.delete("p_0002", "posts"));

        // Unordered, the writes' hooks do not wait for the page, so they land
        // first. (Ordered, awaiting them here would wait on the held page.)
        if (unordered) {
            await Promise.all([patch, remove]);
        }

        release();
        await Promise.all([backfill, patch, remove]);

        return { deletedRowHasVector: shard.vectors.store.has("p_0002"), patched: shard.vectors.store.get("p_0001") };
    };

    it("is gated by the admin bearer and rejects a malformed budget", async () => {
        expect.assertions(4);

        const shard = new VectorShard(makeState());

        await expect(status(shard, {}, null)).resolves.toBe(403);
        await expect(status(shard, {}, "nope")).resolves.toBe(403);
        await expect(status(shard, { maxPages: 0 })).resolves.toBe(400);
        await expect(status(shard, { restart: "false" })).resolves.toBe(400);
    });

    it("indexes pre-existing rows a page per call until done", async () => {
        expect.assertions(4);

        const rows = Math.floor(VECTOR_BACKFILL_PAGE_ROWS * 2.5);

        await seed(rows);

        const shard = new VectorShard(makeState());
        const call = async (args: Record<string, unknown>): Promise<VectorBackfillProgress> => {
            const response = await shard.fetch(adminRequest(args));
            const body = await response.json<{ result: VectorBackfillProgress }>();

            return body.result;
        };

        await expect(call({})).resolves.toStrictEqual({ done: false, pages: 1, rows: VECTOR_BACKFILL_PAGE_ROWS });
        await expect(call({ maxPages: 5 })).resolves.toStrictEqual({ done: true, pages: 2, rows: rows - VECTOR_BACKFILL_PAGE_ROWS });
        await expect(call({ maxPages: 5 })).resolves.toStrictEqual({ done: true, pages: 0, rows: 0 });

        expect(shard.vectors.store.size).toBe(rows);
    });

    it("lets a write that commits while a page is embedding win", async () => {
        expect.assertions(1);

        // The patch re-embeds after the page, and the delete stays deleted.
        await expect(raceWritesAgainstPage(false)).resolves.toStrictEqual({ deletedRowHasVector: false, patched: "new body" });
    });

    it("loses those writes without the ordering — the race is real", async () => {
        expect.assertions(1);

        // The stale page lands last: the patched row keeps its old vector and the
        // deleted row gets one back.
        await expect(raceWritesAgainstPage(true)).resolves.toStrictEqual({ deletedRowHasVector: true, patched: "old 0" });
    });
});
