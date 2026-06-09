import { describe, expect, it, vi } from "vitest";

import { createVectors } from "../src/create-vectors";
import type { SchemaLike, VectorSearchLike } from "../src/ctx";
import { createCtxVectors as createContextVectors, createVectorSyncHook } from "../src/ctx";
import type { VectorizeDeleteMutation, VectorizeIndexLike, VectorizeMatches, VectorizeUpsertMutation, VectorizeVector } from "../src/types";

const fakeIndex = (overrides: Partial<VectorizeIndexLike> = {}): VectorizeIndexLike => {
    return {
        deleteByIds: vi.fn<VectorizeIndexLike["deleteByIds"]>(async (ids: ReadonlyArray<string>): Promise<VectorizeDeleteMutation> => {
            return { count: ids.length, mutationId: `delete-${ids.length}` };
        }),
        getByIds: vi.fn<VectorizeIndexLike["getByIds"]>(
            async (ids: ReadonlyArray<string>): Promise<ReadonlyArray<VectorizeVector>> =>
                ids.map((id) => {
                    return { id, metadata: { k: id }, values: [1, 2] };
                }),
        ),
        insert: vi.fn<VectorizeIndexLike["insert"]>(async (vectors): Promise<VectorizeUpsertMutation> => {
            return { mutationId: `insert-${vectors.length}` };
        }),
        query: vi.fn<VectorizeIndexLike["query"]>(async (): Promise<VectorizeMatches> => {
            return {
                count: 1,
                matches: [{ id: "row-1", metadata: { title: "Hi" }, score: 0.9, values: [0.1] }],
            };
        }),
        upsert: vi.fn<VectorizeIndexLike["upsert"]>(async (vectors): Promise<VectorizeUpsertMutation> => {
            return { mutationId: `upsert-${vectors.length}` };
        }),
        ...overrides,
    };
};

describe("createCtxVectors", () => {
    it("upsert + upsertNow both call cirrus.upsert inline and return void", async () => {
        expect.assertions(4);

        const index = fakeIndex();
        const cirrus = createVectors({ indexes: { docs: index } });
        const context = createContextVectors(cirrus);
        const embed = async (value: string): Promise<ReadonlyArray<number>> => [value.length];

        await expect(context.upsert("docs", { embed, id: "a", input: "hello", metadata: { t: 1 } })).resolves.toBeUndefined();
        await expect(context.upsertNow("docs", { embed, id: "b", input: "yo" })).resolves.toBeUndefined();

        expect(index.upsert).toHaveBeenCalledTimes(2);
        expect(index.upsert).toHaveBeenNthCalledWith(1, [{ id: "a", metadata: { t: 1 }, namespace: undefined, values: [5] }]);
    });

    it("query maps Vectorize matches to the server match shape", async () => {
        expect.assertions(1);

        const cirrus = createVectors({ indexes: { docs: fakeIndex() } });
        const context = createContextVectors(cirrus);

        const result = await context.query("docs", { vector: [0.1, 0.2] });

        expect(result).toEqual({ count: 1, matches: [{ id: "row-1", metadata: { title: "Hi" }, score: 0.9 }] });
    });

    it("query requests metadata so it surfaces on matches", async () => {
        expect.assertions(1);

        const index = fakeIndex();
        const cirrus = createVectors({ indexes: { docs: index } });
        const context = createContextVectors(cirrus);

        await context.query("docs", { vector: [0.1] });

        // Default is "indexed" (not "all"): indexed metadata still surfaces on
        // matches without leaking every stored field by default.
        expect(index.query).toHaveBeenCalledWith([0.1], expect.objectContaining({ returnMetadata: "indexed" }));
    });

    it("getByIds maps Vectorize vectors to the server record shape", async () => {
        expect.assertions(1);

        const cirrus = createVectors({ indexes: { docs: fakeIndex() } });
        const context = createContextVectors(cirrus);

        const records = await context.getByIds("docs", ["a"]);

        expect(records).toEqual([{ id: "a", metadata: { k: "a" }, values: [1, 2] }]);
    });

    it("deleteByIds forwards and returns void", async () => {
        expect.assertions(2);

        const index = fakeIndex();
        const cirrus = createVectors({ indexes: { docs: index } });
        const context = createContextVectors(cirrus);

        await expect(context.deleteByIds("docs", ["a", "b"])).resolves.toBeUndefined();
        expect(index.deleteByIds).toHaveBeenCalledWith(["a", "b"]);
    });
});

const fakeVectorSearch = (): VectorSearchLike & { deletes: [string, ReadonlyArray<string>][]; upserts: [string, unknown][] } => {
    const upserts: [string, unknown][] = [];
    const deletes: [string, ReadonlyArray<string>][] = [];

    return {
        deleteByIds: vi.fn<VectorSearchLike["deleteByIds"]>(async (indexName, ids) => {
            deletes.push([indexName, ids]);
        }),
        deletes,
        getByIds: vi.fn<VectorSearchLike["getByIds"]>(async () => []),
        query: vi.fn<VectorSearchLike["query"]>(async () => {
            return { count: 0, matches: [] };
        }),
        upsert: vi.fn<VectorSearchLike["upsert"]>(async (indexName, input) => {
            upserts.push([indexName, input]);
        }),
        upsertNow: vi.fn<VectorSearchLike["upsertNow"]>(async (indexName, input) => {
            upserts.push([indexName, input]);
        }),
        upserts,
    };
};

const embed = async (value: string): Promise<ReadonlyArray<number>> => [value.length];

describe("createVectorSyncHook", () => {
    it("embeds Shape A source field and upserts on insert", async () => {
        expect.assertions(1);

        const vectors = fakeVectorSearch();
        const schema: SchemaLike = {
            tables: {
                messages: { vectorIndexes: [{ embed, field: "body", metadata: ["author"], name: "messages-body" }] },
            },
            vectorIndexes: {},
        };
        const hook = createVectorSyncHook({ schema, vectors });

        await hook({ doc: { author: "ann", body: "hi there", ignored: 1 }, id: "m1", op: "insert", table: "messages" });

        expect(vectors.upserts).toEqual([["messages-body", { embed, id: "m1", input: "hi there", metadata: { author: "ann" } }]]);
    });

    it("uses Shape B select(row) and metadata(row) on update", async () => {
        expect.assertions(1);

        const vectors = fakeVectorSearch();
        const schema: SchemaLike = {
            tables: { docs: {} },
            vectorIndexes: {
                "docs-fulltext": {
                    embed,
                    metadata: (row) => {
                        return { title: row.title };
                    },
                    select: (row) => `${row.title as string} ${row.body as string}`,
                    table: "docs",
                },
            },
        };
        const hook = createVectorSyncHook({ schema, vectors });

        await hook({ doc: { body: "B", title: "T" }, id: "d1", op: "update", table: "docs" });

        expect(vectors.upserts).toEqual([["docs-fulltext", { embed, id: "d1", input: "T B", metadata: { title: "T" } }]]);
    });

    it("deletes the row id from every index sourced from the table", async () => {
        expect.assertions(1);

        const vectors = fakeVectorSearch();
        const schema: SchemaLike = {
            tables: { docs: { vectorIndexes: [{ embed, field: "body", name: "docs-body" }] } },
            vectorIndexes: { "docs-fulltext": { embed, select: (row) => String(row.body), table: "docs" } },
        };
        const hook = createVectorSyncHook({ schema, vectors });

        await hook({ id: "d1", op: "delete", table: "docs" });

        expect(vectors.deletes).toEqual([
            ["docs-body", ["d1"]],
            ["docs-fulltext", ["d1"]],
        ]);
    });

    it("purges Shape A indexes when the source field is nullish (clear-field)", async () => {
        expect.assertions(2);

        const vectors = fakeVectorSearch();
        const schema: SchemaLike = {
            tables: { messages: { vectorIndexes: [{ embed, field: "body", name: "messages-body" }] } },
            vectorIndexes: {},
        };
        const hook = createVectorSyncHook({ schema, vectors });

        await hook({ doc: { body: null }, id: "m1", op: "update", table: "messages" });

        // No upsert, and the stale vector is deleted rather than silently left
        // searchable (Finding 50).
        expect(vectors.upserts).toEqual([]);
        expect(vectors.deletes).toEqual([["messages-body", ["m1"]]]);
    });

    it("threads the namespace onto upserts for tenant isolation", async () => {
        expect.assertions(1);

        const vectors = fakeVectorSearch();
        const schema: SchemaLike = {
            tables: { messages: { vectorIndexes: [{ embed, field: "body", name: "messages-body" }] } },
            vectorIndexes: {},
        };
        const hook = createVectorSyncHook({ namespace: "tenant-acme", schema, vectors });

        await hook({ doc: { body: "hi" }, id: "m1", op: "insert", table: "messages" });

        expect(vectors.upserts).toEqual([["messages-body", { embed, id: "m1", input: "hi", metadata: undefined, namespace: "tenant-acme" }]]);
    });

    it("no-ops for tables without any vector index", async () => {
        expect.assertions(2);

        const vectors = fakeVectorSearch();
        const schema: SchemaLike = { tables: { plain: {} }, vectorIndexes: {} };
        const hook = createVectorSyncHook({ schema, vectors });

        await hook({ doc: { a: 1 }, id: "x", op: "insert", table: "plain" });

        expect(vectors.upserts).toEqual([]);
        expect(vectors.deletes).toEqual([]);
    });

    it("throws a descriptive error when an inline source field is non-string", async () => {
        expect.assertions(2);

        const vectors = fakeVectorSearch();
        const schema: SchemaLike = {
            tables: { messages: { vectorIndexes: [{ embed, field: "body", name: "messages-body" }] } },
            vectorIndexes: {},
        };
        const hook = createVectorSyncHook({ schema, vectors });

        // A JSON column holding an object would otherwise embed "[object Object]"
        // and silently produce an unsearchable vector.
        await expect(hook({ doc: { body: { nested: true } }, id: "m1", op: "insert", table: "messages" })).rejects.toThrow(/expects a string source/);
        // The bad write must not partially fan out.
        expect(vectors.upserts).toEqual([]);
    });

    it("compensates with deletes across every affected index then re-throws the original error", async () => {
        expect.assertions(3);

        const original = new Error("embedder boom");
        const vectors = fakeVectorSearch();

        // Second upsert (standalone) rejects after the first inline upsert.
        (vectors.upsert as ReturnType<typeof vi.fn>).mockImplementation(async (indexName: string, input: unknown) => {
            vectors.upserts.push([indexName, input]);

            if (indexName === "docs-fulltext") {
                throw original;
            }
        });

        const schema: SchemaLike = {
            tables: { docs: { vectorIndexes: [{ embed, field: "body", name: "docs-body" }] } },
            vectorIndexes: { "docs-fulltext": { embed, select: (row) => String(row.body), table: "docs" } },
        };
        const hook = createVectorSyncHook({ schema, vectors });

        await expect(hook({ doc: { body: "hi" }, id: "d1", op: "insert", table: "docs" })).rejects.toBe(original);

        // Compensation purges this row's id from every index sourced from the table.
        expect(vectors.deletes).toContainEqual(["docs-body", ["d1"]]);
        expect(vectors.deletes).toContainEqual(["docs-fulltext", ["d1"]]);
    });
});
