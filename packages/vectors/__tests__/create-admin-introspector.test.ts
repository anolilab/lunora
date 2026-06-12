import { describe, expect, it, vi } from "vitest";

import createVectorAdminIntrospector from "../src/create-admin-introspector";
import type { VectorizeIndexDetails, VectorizeIndexLike, VectorizeMatches, VectorizeUpsertMutation, VectorizeVector } from "../src/types";

const fakeIndex = (overrides: Partial<VectorizeIndexLike> = {}): VectorizeIndexLike => {
    return {
        deleteByIds: vi.fn<VectorizeIndexLike["deleteByIds"]>(async () => {
            return { mutationId: "del" };
        }),
        describe: vi.fn<NonNullable<VectorizeIndexLike["describe"]>>(async (): Promise<VectorizeIndexDetails> => {
            return { dimensions: 1024, processedUpToMutation: "m-7", vectorsCount: 42 };
        }),
        getByIds: vi.fn<VectorizeIndexLike["getByIds"]>(async (): Promise<ReadonlyArray<VectorizeVector>> => []),
        insert: vi.fn<VectorizeIndexLike["insert"]>(async (): Promise<VectorizeUpsertMutation> => {
            return { mutationId: "ins" };
        }),
        query: vi.fn<VectorizeIndexLike["query"]>(async (): Promise<VectorizeMatches> => {
            return { count: 1, matches: [{ id: "row-1", metadata: { title: "hi" }, score: 0.91 }] };
        }),
        upsert: vi.fn<VectorizeIndexLike["upsert"]>(async (): Promise<VectorizeUpsertMutation> => {
            return { mutationId: "ups" };
        }),
        ...overrides,
    };
};

const REGISTRY = [
    { dimensions: 1024, field: "body", metric: "cosine" as const, name: "by_body", table: "docs" },
    { name: "orphan", table: "papers" },
];

describe("createVectorAdminIntrospector", () => {
    it("merges live describe() stats into the static registry", async () => {
        expect.assertions(2);

        const index = fakeIndex();
        const introspector = createVectorAdminIntrospector({ indexes: { by_body: index }, registry: REGISTRY });

        const list = await introspector.listIndexes();

        expect(list[0]).toEqual({
            dimensions: 1024,
            field: "body",
            metric: "cosine",
            name: "by_body",
            processedUpToMutation: "m-7",
            table: "docs",
            vectorsCount: 42,
        });
        // The registry entry with no matching binding lists with only its static shape.
        expect(list[1]).toEqual({ name: "orphan", table: "papers" });
    });

    it("degrades to the static shape when describe() throws", async () => {
        expect.assertions(1);

        const index = fakeIndex({
            describe: vi.fn<NonNullable<VectorizeIndexLike["describe"]>>(async () => {
                throw new Error("vectorize unreachable");
            }),
        });
        const introspector = createVectorAdminIntrospector({ indexes: { by_body: index }, registry: REGISTRY });

        const list = await introspector.listIndexes();

        expect(list[0]).toEqual({ dimensions: 1024, field: "body", metric: "cosine", name: "by_body", table: "docs" });
    });

    it("withholds queryIndex entirely when no embedders are configured", async () => {
        expect.assertions(1);

        const introspector = createVectorAdminIntrospector({ indexes: { by_body: fakeIndex() }, registry: REGISTRY });

        expect(introspector.queryIndex).toBeUndefined();
    });

    it("embeds the query text and runs an ANN search when an embedder is wired", async () => {
        expect.assertions(3);

        const embed = vi.fn<(text: string) => Promise<number[]>>(async (text: string) => [text.length, 0, 0]);
        const index = fakeIndex();
        const introspector = createVectorAdminIntrospector({
            embedders: { by_body: embed },
            indexes: { by_body: index },
            registry: REGISTRY,
        });

        const result = await introspector.queryIndex?.({ name: "by_body", text: "hello", topK: 3 });

        expect(embed).toHaveBeenCalledWith("hello");
        expect(index.query).toHaveBeenCalledWith([5, 0, 0], { returnMetadata: "all", topK: 3 });
        expect(result?.matches).toEqual([{ id: "row-1", metadata: { title: "hi" }, score: 0.91 }]);
    });

    it("throws on a query for an index with no embedder", async () => {
        expect.assertions(1);

        const introspector = createVectorAdminIntrospector({
            embedders: { by_body: async () => [1] },
            indexes: { by_body: fakeIndex(), orphan: fakeIndex() },
            registry: REGISTRY,
        });

        await expect(introspector.queryIndex?.({ name: "orphan", text: "x" })).rejects.toThrow(/no embedder/);
    });
});
