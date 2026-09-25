import type { SchemaLike as VectorSchemaLike, UpsertInput, VectorSearchLike } from "@lunora/bindings/vectors";
import { createVectorBackfillSync, vectorBackfillTargets } from "@lunora/bindings/vectors";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SchemaLike } from "../src/ctx-db";
import { createShardCtxDb, runShardMigrations } from "../src/ctx-db";
import { backfillVectorIndexes, VECTOR_BACKFILL_MAX_PAGES, VECTOR_BACKFILL_PAGE_ROWS } from "../src/vector-backfill";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The vector backfill: the rows that predate a vector index (or a change to one)
 * reach Vectorize, a bounded number of pages per call.
 *
 * The in-memory index below is a plain map: it is more permissive than Vectorize
 * (no request limits, no eventual consistency — a written vector is readable at
 * once). Nothing asserted here depends on Vectorize behaviour; the page bound is
 * asserted as counts of rows and of batch calls, and ordering against live
 * writes is the host's `ordered` primitive, covered against the real gate in
 * `@lunora/do`.
 */

const embed = async (value: string): Promise<ReadonlyArray<number>> => {
    if (value === "the model rejects this") {
        throw new Error("embedding refused");
    }

    return [value.length];
};

/** Rows written before the index existed: 2.5 pages' worth, so the walk crosses page boundaries. */
const PRE_EXISTING = Math.floor(VECTOR_BACKFILL_PAGE_ROWS * 2.5);

interface MemoryVectors extends VectorSearchLike {
    batchCalls: number;
    down: boolean;
    store: Map<string, string>;
    upsertMany: (index: string, inputs: ReadonlyArray<UpsertInput<string>>) => Promise<undefined>;
}

const memoryVectors = (): MemoryVectors => {
    const store = new Map<string, string>();
    const vectors: MemoryVectors = {
        batchCalls: 0,
        deleteByIds: async (_index, ids) => {
            for (const id of ids) {
                store.delete(id);
            }
        },
        down: false,
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
            throw new Error("the backfill writes through upsertMany / upsertNow");
        },
        upsertMany: async (_index, inputs) => {
            vectors.batchCalls += 1;

            if (vectors.down) {
                throw new Error("vectorize unreachable");
            }

            for (const input of inputs) {
                // eslint-disable-next-line no-await-in-loop -- the precomputed "embedder" is synchronous in effect
                await input.embed(input.input);
                store.set(input.id, input.input);
            }

            return undefined;
        },
        upsertNow: async (_index, input) => {
            if (vectors.down) {
                throw new Error("vectorize unreachable");
            }

            store.set(input.id, input.input);
        },
    };

    return vectors;
};

/** The naive ordering: read, then work. The real gate + chain is exercised in `@lunora/do`. */
const inline = async <T, U>(read: () => T, work: (value: T) => Promise<U>): Promise<U> => work(read());

const shape = { body: { kind: "any" }, deletedAt: { kind: "number", isOptional: true }, title: { kind: "string" } };

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

    const nextId = (): string => {
        n += 1;

        return `p_${String(n).padStart(4, "0")}`;
    };

    /** Deploy 1 writes `count` rows with no vector index; deploy 2 declares `.vectorize(field)`. */
    const deploy = async (
        count: number,
        { bodyOf = (index) => `body ${String(index)}`, field = "body", model }: { bodyOf?: (index: number) => unknown; field?: string; model?: string } = {},
    ) => {
        const before: SchemaLike = { tables: { posts: { indexes: [], shape, softDeleteMode: { field: "deletedAt" } } } };

        runShardMigrations(harness.sql, before);

        const v1 = createShardCtxDb({ clock: () => 1, idGenerator: nextId, schema: before, sql: harness.sql });

        for (let index = 0; index < count; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential ids
            await v1.insert("posts", { body: bodyOf(index), title: `t${String(index)}` });
        }

        const schema = {
            tables: { posts: { indexes: [], shape, softDeleteMode: { field: "deletedAt" }, vectorIndexes: [{ embed, field, model, name: "posts_body" }] } },
            vectorIndexes: {},
        } as never as SchemaLike & VectorSchemaLike;
        const vectors = memoryVectors();

        runShardMigrations(harness.sql, schema);

        const sync = createVectorBackfillSync({ allowSharedNamespace: true, schema, upsertMany: vectors.upsertMany as never, vectors });
        const run = async (options: { maxPages?: number; restart?: boolean } = {}): ReturnType<typeof backfillVectorIndexes> =>
            backfillVectorIndexes(harness.sql, vectorBackfillTargets(schema), sync, { ...options, ordered: inline });

        return { run, schema, vectors };
    };

    const progress = (fields: Partial<Awaited<ReturnType<typeof backfillVectorIndexes>>>) => {
        return { done: false, failed: 0, failedIds: [], pages: 0, rows: 0, ...fields };
    };

    it("indexes every pre-existing row, one page per call by default, and resumes where it stopped", async () => {
        expect.assertions(4);

        const { run, vectors } = await deploy(PRE_EXISTING);

        await expect(run()).resolves.toStrictEqual(progress({ pages: 1, rows: VECTOR_BACKFILL_PAGE_ROWS }));
        await expect(run()).resolves.toStrictEqual(progress({ pages: 1, rows: VECTOR_BACKFILL_PAGE_ROWS }));
        await expect(run()).resolves.toStrictEqual(progress({ done: true, pages: 1, rows: PRE_EXISTING - 2 * VECTOR_BACKFILL_PAGE_ROWS }));

        expect(vectors.store.size).toBe(PRE_EXISTING);
    });

    it("writes each page to an index with ONE batch call, not one call per row", async () => {
        expect.assertions(2);

        const { run, vectors } = await deploy(PRE_EXISTING);

        await run({ maxPages: 10 });

        expect(vectors.batchCalls).toBe(3);
        expect(vectors.store.size).toBe(PRE_EXISTING);
    });

    it("finishes a table that ends on a page boundary without spending a page on nothing", async () => {
        expect.assertions(2);

        const { run } = await deploy(2 * VECTOR_BACKFILL_PAGE_ROWS);

        await expect(run({ maxPages: 2 })).resolves.toStrictEqual(progress({ done: true, pages: 2, rows: 2 * VECTOR_BACKFILL_PAGE_ROWS }));
        await expect(run({ maxPages: 2 })).resolves.toStrictEqual(progress({ done: true }));
    });

    it("moves past rows that can never be indexed, and reports them", async () => {
        expect.assertions(3);

        // Row 3 holds a non-string source; row 60 (second page) is text the model refuses.
        const bad: Record<number, unknown> = { 2: { not: "text" }, 59: "the model rejects this" };
        const { run, vectors } = await deploy(PRE_EXISTING, { bodyOf: (index) => bad[index] ?? `body ${String(index)}` });

        await expect(run({ maxPages: 10 })).resolves.toStrictEqual(
            progress({ done: true, failed: 2, failedIds: ["p_0003", "p_0060"], pages: 3, rows: PRE_EXISTING }),
        );

        expect(vectors.store.size).toBe(PRE_EXISTING - 2);
        expect(vectors.store.has("p_0003")).toBe(false);
    });

    it("holds the cursor when a whole page fails, and returns the progress made before it", async () => {
        expect.assertions(3);

        const { run, vectors } = await deploy(PRE_EXISTING);

        await run();
        vectors.down = true;

        await expect(run({ maxPages: 10 })).resolves.toStrictEqual(progress({ error: "vectorize unreachable" }));

        vectors.down = false;

        await expect(run({ maxPages: 10 })).resolves.toStrictEqual(progress({ done: true, pages: 2, rows: PRE_EXISTING - VECTOR_BACKFILL_PAGE_ROWS }));

        expect(vectors.store.size).toBe(PRE_EXISTING);
    });

    it("re-walks the table when the index config changes", async () => {
        expect.assertions(2);

        const { run } = await deploy(PRE_EXISTING);

        await run({ maxPages: 10 });

        // Re-pointed at another column: every stored vector embeds the wrong text now.
        const repointed = await deploy(0, { field: "title" });

        await expect(repointed.run({ maxPages: 10 })).resolves.toStrictEqual(progress({ done: true, pages: 3, rows: PRE_EXISTING }));

        expect(repointed.vectors.store.get("p_0001")).toBe("t0");
    });

    it("re-embeds the whole table when only the declared model changes", async () => {
        expect.assertions(2);

        const { run } = await deploy(PRE_EXISTING, { model: "@cf/baai/bge-base-en-v1.5" });

        await run({ maxPages: 10 });

        // Same field, dimensions and metric: only the model differs, so every stored vector is from the old one.
        const swapped = await deploy(0, { model: "@cf/baai/bge-m3" });

        await expect(swapped.run({ maxPages: 10 })).resolves.toStrictEqual(progress({ done: true, pages: 3, rows: PRE_EXISTING }));

        expect(swapped.vectors.store.size).toBe(PRE_EXISTING);
    });

    it("re-embeds nothing when the config, model included, is unchanged", async () => {
        expect.assertions(2);

        const { run } = await deploy(PRE_EXISTING, { model: "@cf/baai/bge-base-en-v1.5" });

        await run({ maxPages: 10 });

        const redeployed = await deploy(0, { model: "@cf/baai/bge-base-en-v1.5" });

        await expect(redeployed.run({ maxPages: 10 })).resolves.toStrictEqual(progress({ done: true }));

        expect(redeployed.vectors.store.size).toBe(0);
    });

    it("restart re-embeds a finished table, even across calls that run out of budget", async () => {
        expect.assertions(3);

        const { run } = await deploy(PRE_EXISTING);

        await run({ maxPages: 10 });

        await expect(run({ restart: true })).resolves.toStrictEqual(progress({ pages: 1, rows: VECTOR_BACKFILL_PAGE_ROWS }));
        // The follow-up carries no `restart`, and still finishes the re-walk.
        await expect(run({ maxPages: 10 })).resolves.toStrictEqual(progress({ done: true, pages: 2, rows: PRE_EXISTING - VECTOR_BACKFILL_PAGE_ROWS }));
        await expect(run({ maxPages: 10 })).resolves.toStrictEqual(progress({ done: true }));
    });

    it("never runs more than the page ceiling in one call", async () => {
        expect.assertions(1);

        const { run } = await deploy((VECTOR_BACKFILL_MAX_PAGES + 1) * VECTOR_BACKFILL_PAGE_ROWS);

        await expect(run({ maxPages: VECTOR_BACKFILL_MAX_PAGES + 5 })).resolves.toMatchObject({ done: false, pages: VECTOR_BACKFILL_MAX_PAGES });
    });

    it("purges a soft-deleted row's vector instead of indexing it", async () => {
        expect.assertions(2);

        const { run, schema, vectors } = await deploy(PRE_EXISTING);
        const writer = createShardCtxDb({ clock: () => 2, schema, sql: harness.sql });

        // Hidden before the backfill, and a stale vector for it already in the index.
        await writer.delete("p_0003", "posts");
        vectors.store.set("p_0003", "stale");

        await run({ maxPages: 10 });

        expect(vectors.store.has("p_0003")).toBe(false);
        expect(vectors.store.size).toBe(PRE_EXISTING - 1);
    });
});
