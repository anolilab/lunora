import { describe, expect, it, vi } from "vitest";

import { createVectors } from "../src/create-vectors.js";
import type { SchemaLike, VectorSearchLike } from "../src/ctx.js";
import { createCtxVectors, createVectorSyncHook } from "../src/ctx.js";
import type { VectorizeDeleteMutation, VectorizeIndexLike, VectorizeMatches, VectorizeUpsertMutation, VectorizeVector } from "../src/types.js";

const fakeIndex = (overrides: Partial<VectorizeIndexLike> = {}): VectorizeIndexLike => ({
    upsert: vi.fn<VectorizeIndexLike["upsert"]>(async (vectors): Promise<VectorizeUpsertMutation> => ({ mutationId: `upsert-${vectors.length}` })),
    insert: vi.fn<VectorizeIndexLike["insert"]>(async (vectors): Promise<VectorizeUpsertMutation> => ({ mutationId: `insert-${vectors.length}` })),
    query: vi.fn<VectorizeIndexLike["query"]>(
        async (): Promise<VectorizeMatches> => ({
            matches: [{ id: "row-1", score: 0.9, values: [0.1], metadata: { title: "Hi" } }],
            count: 1,
        }),
    ),
    getByIds: vi.fn<VectorizeIndexLike["getByIds"]>(
        async (ids: ReadonlyArray<string>): Promise<ReadonlyArray<VectorizeVector>> => ids.map((id) => ({ id, values: [1, 2], metadata: { k: id } })),
    ),
    deleteByIds: vi.fn<VectorizeIndexLike["deleteByIds"]>(
        async (ids: ReadonlyArray<string>): Promise<VectorizeDeleteMutation> => ({ mutationId: `delete-${ids.length}`, count: ids.length }),
    ),
    ...overrides,
});

describe("createCtxVectors", () => {
    it("upsert + upsertNow both call cirrus.upsert inline and return void", async () => {
        expect.assertions(4);

        const index = fakeIndex();
        const cirrus = createVectors({ indexes: { docs: index } });
        const ctx = createCtxVectors(cirrus);
        const embed = async (value: string): Promise<ReadonlyArray<number>> => [value.length];

        await expect(ctx.upsert("docs", { id: "a", input: "hello", embed, metadata: { t: 1 } })).resolves.toBeUndefined();
        await expect(ctx.upsertNow("docs", { id: "b", input: "yo", embed })).resolves.toBeUndefined();

        expect(index.upsert).toHaveBeenCalledTimes(2);
        expect(index.upsert).toHaveBeenNthCalledWith(1, [{ id: "a", values: [5], metadata: { t: 1 }, namespace: undefined }]);
    });

    it("query maps Vectorize matches to the server match shape", async () => {
        expect.assertions(1);

        const cirrus = createVectors({ indexes: { docs: fakeIndex() } });
        const ctx = createCtxVectors(cirrus);

        const result = await ctx.query("docs", { vector: [0.1, 0.2] });

        expect(result).toEqual({ count: 1, matches: [{ id: "row-1", score: 0.9, metadata: { title: "Hi" } }] });
    });

    it("query requests metadata so it surfaces on matches", async () => {
        expect.assertions(1);

        const index = fakeIndex();
        const cirrus = createVectors({ indexes: { docs: index } });
        const ctx = createCtxVectors(cirrus);

        await ctx.query("docs", { vector: [0.1] });

        // Default is "indexed" (not "all"): indexed metadata still surfaces on
        // matches without leaking every stored field by default.
        expect(index.query).toHaveBeenCalledWith([0.1], expect.objectContaining({ returnMetadata: "indexed" }));
    });

    it("getByIds maps Vectorize vectors to the server record shape", async () => {
        expect.assertions(1);

        const cirrus = createVectors({ indexes: { docs: fakeIndex() } });
        const ctx = createCtxVectors(cirrus);

        const records = await ctx.getByIds("docs", ["a"]);

        expect(records).toEqual([{ id: "a", values: [1, 2], metadata: { k: "a" } }]);
    });

    it("deleteByIds forwards and returns void", async () => {
        expect.assertions(2);

        const index = fakeIndex();
        const cirrus = createVectors({ indexes: { docs: index } });
        const ctx = createCtxVectors(cirrus);

        await expect(ctx.deleteByIds("docs", ["a", "b"])).resolves.toBeUndefined();
        expect(index.deleteByIds).toHaveBeenCalledWith(["a", "b"]);
    });
});

const fakeVectorSearch = (): VectorSearchLike & { deletes: Array<[string, ReadonlyArray<string>]>; upserts: Array<[string, unknown]> } => {
    const upserts: Array<[string, unknown]> = [];
    const deletes: Array<[string, ReadonlyArray<string>]> = [];

    return {
        upserts,
        deletes,
        upsert: vi.fn<VectorSearchLike["upsert"]>(async (indexName, input) => {
            upserts.push([indexName, input]);
        }),
        upsertNow: vi.fn<VectorSearchLike["upsertNow"]>(async (indexName, input) => {
            upserts.push([indexName, input]);
        }),
        deleteByIds: vi.fn<VectorSearchLike["deleteByIds"]>(async (indexName, ids) => {
            deletes.push([indexName, ids]);
        }),
        query: vi.fn<VectorSearchLike["query"]>(async () => ({ count: 0, matches: [] })),
        getByIds: vi.fn<VectorSearchLike["getByIds"]>(async () => []),
    };
};

const embed = async (value: string): Promise<ReadonlyArray<number>> => [value.length];

describe("createVectorSyncHook", () => {
    it("embeds Shape A source field and upserts on insert", async () => {
        expect.assertions(1);

        const vectors = fakeVectorSearch();
        const schema: SchemaLike = {
            tables: {
                messages: { vectorIndexes: [{ name: "messages-body", field: "body", embed, metadata: ["author"] }] },
            },
            vectorIndexes: {},
        };
        const hook = createVectorSyncHook({ schema, vectors });

        await hook({ op: "insert", table: "messages", id: "m1", doc: { body: "hi there", author: "ann", ignored: 1 } });

        expect(vectors.upserts).toEqual([["messages-body", { id: "m1", input: "hi there", embed, metadata: { author: "ann" } }]]);
    });

    it("uses Shape B select(row) and metadata(row) on update", async () => {
        expect.assertions(1);

        const vectors = fakeVectorSearch();
        const schema: SchemaLike = {
            tables: { docs: {} },
            vectorIndexes: {
                "docs-fulltext": {
                    table: "docs",
                    embed,
                    select: (row) => `${row.title as string} ${row.body as string}`,
                    metadata: (row) => ({ title: row.title }),
                },
            },
        };
        const hook = createVectorSyncHook({ schema, vectors });

        await hook({ op: "update", table: "docs", id: "d1", doc: { title: "T", body: "B" } });

        expect(vectors.upserts).toEqual([["docs-fulltext", { id: "d1", input: "T B", embed, metadata: { title: "T" } }]]);
    });

    it("deletes the row id from every index sourced from the table", async () => {
        expect.assertions(1);

        const vectors = fakeVectorSearch();
        const schema: SchemaLike = {
            tables: { docs: { vectorIndexes: [{ name: "docs-body", field: "body", embed }] } },
            vectorIndexes: { "docs-fulltext": { table: "docs", embed, select: (row) => String(row.body) } },
        };
        const hook = createVectorSyncHook({ schema, vectors });

        await hook({ op: "delete", table: "docs", id: "d1" });

        expect(vectors.deletes).toEqual([
            ["docs-body", ["d1"]],
            ["docs-fulltext", ["d1"]],
        ]);
    });

    it("purges Shape A indexes when the source field is nullish (clear-field)", async () => {
        expect.assertions(2);

        const vectors = fakeVectorSearch();
        const schema: SchemaLike = {
            tables: { messages: { vectorIndexes: [{ name: "messages-body", field: "body", embed }] } },
            vectorIndexes: {},
        };
        const hook = createVectorSyncHook({ schema, vectors });

        await hook({ op: "update", table: "messages", id: "m1", doc: { body: null } });

        // No upsert, and the stale vector is deleted rather than silently left
        // searchable (Finding 50).
        expect(vectors.upserts).toEqual([]);
        expect(vectors.deletes).toEqual([["messages-body", ["m1"]]]);
    });

    it("threads the namespace onto upserts for tenant isolation", async () => {
        expect.assertions(1);

        const vectors = fakeVectorSearch();
        const schema: SchemaLike = {
            tables: { messages: { vectorIndexes: [{ name: "messages-body", field: "body", embed }] } },
            vectorIndexes: {},
        };
        const hook = createVectorSyncHook({ namespace: "tenant-acme", schema, vectors });

        await hook({ op: "insert", table: "messages", id: "m1", doc: { body: "hi" } });

        expect(vectors.upserts).toEqual([["messages-body", { id: "m1", input: "hi", embed, metadata: undefined, namespace: "tenant-acme" }]]);
    });

    it("no-ops for tables without any vector index", async () => {
        expect.assertions(2);

        const vectors = fakeVectorSearch();
        const schema: SchemaLike = { tables: { plain: {} }, vectorIndexes: {} };
        const hook = createVectorSyncHook({ schema, vectors });

        await hook({ op: "insert", table: "plain", id: "x", doc: { a: 1 } });

        expect(vectors.upserts).toEqual([]);
        expect(vectors.deletes).toEqual([]);
    });
});
