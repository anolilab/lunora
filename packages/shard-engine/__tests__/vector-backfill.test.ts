import type { SchemaLike as VectorSchemaLike, VectorSearchLike } from "@lunora/bindings/vectors";
import { createVectorSyncHook, vectorBackfillTargets } from "@lunora/bindings/vectors";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SchemaLike, WriteHook } from "../src/ctx-db";
import { createShardCtxDb, runShardMigrations } from "../src/ctx-db";
import type { OrderedAfterWrites } from "../src/vector-backfill";
import { backfillVectorIndexes, VECTOR_BACKFILL_PAGE_ROWS } from "../src/vector-backfill";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The vector backfill: the rows that predate a vector index (or a change to
 * one) reach Vectorize, a bounded number of pages per call.
 *
 * The in-memory index below is a plain map: it is more permissive than Vectorize
 * (no request limits, no eventual consistency — a written vector is readable at
 * once). Nothing asserted here depends on Vectorize behaviour; the page bound is
 * asserted as a count of rows handed to the hook, and ordering against live writes
 * is the host's `ordered` primitive, covered against the real gate in `@lunora/do`.
 */

const embed = async (value: string): Promise<ReadonlyArray<number>> => [value.length];

/** Rows written before the index existed: 2.5 pages' worth, so the walk crosses page boundaries. */
const PRE_EXISTING = Math.floor(VECTOR_BACKFILL_PAGE_ROWS * 2.5);

const memoryVectors = (): VectorSearchLike & { failOn?: string; store: Map<string, string> } => {
    const store = new Map<string, string>();
    const vectors: VectorSearchLike & { failOn?: string; store: Map<string, string> } = {
        deleteByIds: async (_index, ids) => {
            for (const id of ids) {
                store.delete(id);
            }
        },
        getByIds: async () => [],
        query: async () => {
            return {
                count: store.size,
                matches: [...store.keys()].map((id) => {
                    return { id, score: 1 };
                }),
            };
        },
        store,
        upsert: async () => {
            throw new Error("the sync hook upserts through upsertNow");
        },
        upsertNow: async (_index, input) => {
            if (input.id === vectors.failOn) {
                throw new Error("vectorize unreachable");
            }

            store.set(input.id, input.input);
        },
    };

    return vectors;
};

/** The naive ordering: read, then work. The real gate + chain is exercised in `@lunora/do`. */
const inline: OrderedAfterWrites = async (read, work) => work(read());

const shape = { body: { kind: "string" }, deletedAt: { kind: "number", isOptional: true }, title: { kind: "string" } };

describe("backfillVectorIndexes", () => {
    let harness: ReturnType<typeof createSqliteExec>;
    let n: number;

    beforeEach(() => {
        harness = createSqliteExec();
        n = 0;
    });

    afterEach(() => {
        harness.close();
    });

    /** Deploy 1 writes rows with no vector index; deploy 2 declares `.vectorize("body")`. */
    const nextId = (): string => {
        n += 1;

        return `p_${String(n).padStart(4, "0")}`;
    };

    const deploy = async (): Promise<{ onWrite: WriteHook; schema: SchemaLike & VectorSchemaLike; vectors: ReturnType<typeof memoryVectors> }> => {
        const before: SchemaLike = { tables: { posts: { indexes: [], shape, softDeleteMode: { field: "deletedAt" } } } };

        runShardMigrations(harness.sql, before);

        const v1 = createShardCtxDb({ clock: () => 1, idGenerator: () => nextId(), schema: before, sql: harness.sql });

        for (let index = 0; index < PRE_EXISTING; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential ids
            await v1.insert("posts", { body: `body ${String(index)}`, title: `t${String(index)}` });
        }

        const schema = {
            tables: { posts: { indexes: [], shape, softDeleteMode: { field: "deletedAt" }, vectorIndexes: [{ embed, field: "body", name: "posts_body" }] } },
            vectorIndexes: {},
        } as never as SchemaLike & VectorSchemaLike;
        const vectors = memoryVectors();

        runShardMigrations(harness.sql, schema);

        return { onWrite: createVectorSyncHook({ allowSharedNamespace: true, schema, vectors }), schema, vectors };
    };

    it("indexes every pre-existing row, one page per call by default, and resumes where it stopped", async () => {
        expect.assertions(5);

        const { onWrite, schema, vectors } = await deploy();
        const writer = createShardCtxDb({ clock: () => 2, idGenerator: () => nextId(), onWrite, schema, sql: harness.sql });

        await writer.insert("posts", { body: "new post", title: "new" });

        // Before: only the post-deploy write reached the index.
        expect(vectors.store.size).toBe(1);

        const run = async (): ReturnType<typeof backfillVectorIndexes> =>
            backfillVectorIndexes(harness.sql, vectorBackfillTargets(schema), onWrite, { ordered: inline });

        await expect(run()).resolves.toStrictEqual({ done: false, pages: 1, rows: VECTOR_BACKFILL_PAGE_ROWS });
        await expect(run()).resolves.toStrictEqual({ done: false, pages: 1, rows: VECTOR_BACKFILL_PAGE_ROWS });
        // 251 rows: the third page holds the last 50 pre-existing rows plus the new one.
        await expect(run()).resolves.toStrictEqual({ done: true, pages: 1, rows: PRE_EXISTING + 1 - 2 * VECTOR_BACKFILL_PAGE_ROWS });

        expect(vectors.store.size).toBe(PRE_EXISTING + 1);
    });

    it("costs nothing once done, and re-walks when the index config changes", async () => {
        expect.assertions(4);

        const { onWrite, schema } = await deploy();

        await expect(backfillVectorIndexes(harness.sql, vectorBackfillTargets(schema), onWrite, { maxPages: 10, ordered: inline })).resolves.toStrictEqual({
            done: true,
            pages: 3,
            rows: PRE_EXISTING,
        });
        await expect(backfillVectorIndexes(harness.sql, vectorBackfillTargets(schema), onWrite, { maxPages: 10, ordered: inline })).resolves.toStrictEqual({
            done: true,
            pages: 0,
            rows: 0,
        });

        // Re-pointed at another column: every stored vector embeds the wrong text now.
        const repointed = {
            ...schema,
            tables: { posts: { ...schema.tables["posts"]!, vectorIndexes: [{ embed, field: "title", name: "posts_body" }] } },
        } as typeof schema;
        const vectors = memoryVectors();
        const hook = createVectorSyncHook({ allowSharedNamespace: true, schema: repointed, vectors });

        await expect(backfillVectorIndexes(harness.sql, vectorBackfillTargets(repointed), hook, { maxPages: 10, ordered: inline })).resolves.toStrictEqual({
            done: true,
            pages: 3,
            rows: PRE_EXISTING,
        });

        expect(vectors.store.get("p_0001")).toBe("t0");
    });

    it("restart re-embeds a finished table, even across calls that run out of budget", async () => {
        expect.assertions(3);

        const { onWrite, schema } = await deploy();
        const targets = vectorBackfillTargets(schema);

        await backfillVectorIndexes(harness.sql, targets, onWrite, { maxPages: 10, ordered: inline });

        await expect(backfillVectorIndexes(harness.sql, targets, onWrite, { ordered: inline, restart: true })).resolves.toStrictEqual({
            done: false,
            pages: 1,
            rows: VECTOR_BACKFILL_PAGE_ROWS,
        });
        // The follow-up carries no `restart`, and still finishes the re-walk.
        await expect(backfillVectorIndexes(harness.sql, targets, onWrite, { maxPages: 10, ordered: inline })).resolves.toStrictEqual({
            done: true,
            pages: 2,
            rows: PRE_EXISTING - VECTOR_BACKFILL_PAGE_ROWS,
        });
        await expect(backfillVectorIndexes(harness.sql, targets, onWrite, { maxPages: 10, ordered: inline })).resolves.toStrictEqual({
            done: true,
            pages: 0,
            rows: 0,
        });
    });

    it("does not advance past a page whose sync failed, and retries it next call", async () => {
        expect.assertions(3);

        const { onWrite, schema, vectors } = await deploy();
        const targets = vectorBackfillTargets(schema);

        // A row on the SECOND page.
        vectors.failOn = `p_${String(VECTOR_BACKFILL_PAGE_ROWS + 7).padStart(4, "0")}`;

        await expect(backfillVectorIndexes(harness.sql, targets, onWrite, { maxPages: 10, ordered: inline })).rejects.toThrow(/vectorize unreachable/u);

        vectors.failOn = undefined;

        await expect(backfillVectorIndexes(harness.sql, targets, onWrite, { maxPages: 10, ordered: inline })).resolves.toStrictEqual({
            done: true,
            pages: 2,
            rows: PRE_EXISTING - VECTOR_BACKFILL_PAGE_ROWS,
        });

        expect(vectors.store.size).toBe(PRE_EXISTING);
    });

    it("purges a soft-deleted row's vector instead of indexing it", async () => {
        expect.assertions(2);

        const { onWrite, schema, vectors } = await deploy();
        const writer = createShardCtxDb({ clock: () => 2, schema, sql: harness.sql });

        // Hidden before the backfill; and a stale vector for it already in the index.
        await writer.delete("p_0003", "posts");
        vectors.store.set("p_0003", "stale");

        await backfillVectorIndexes(harness.sql, vectorBackfillTargets(schema), onWrite, { maxPages: 10, ordered: inline });

        expect(vectors.store.has("p_0003")).toBe(false);
        expect(vectors.store.size).toBe(PRE_EXISTING - 1);
    });
});
