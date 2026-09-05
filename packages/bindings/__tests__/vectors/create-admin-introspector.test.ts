import { LunoraError } from "@lunora/errors";
import { describe, expect, it, vi } from "vitest";

import { createVectorAdminIntrospector } from "../../src/vectors/create-admin-introspector";
import type { VectorizeIndexDetails, VectorizeIndexLike, VectorizeMatches, VectorizeUpsertMutation, VectorizeVector } from "../../src/vectors/types";

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

    it("serves the same 50-neighbour ceiling the user query path enforces", async () => {
        expect.assertions(1);

        const index = fakeIndex();
        const introspector = createVectorAdminIntrospector({
            embedders: { by_body: async () => [1, 0, 0] },
            indexes: { by_body: index },
            registry: REGISTRY,
        });

        // Admin queries always request full metadata, which lowers Vectorize
        // V2's topK ceiling from 100 to 50 — the same bound `createVectors`
        // enforces and the docs publish. A silent `Math.min` at 20 truncated
        // every studio query the user path would have served in full.
        await introspector.queryIndex?.({ name: "by_body", text: "hello", topK: 50 });

        expect(index.query).toHaveBeenCalledWith([1, 0, 0], { returnMetadata: "all", topK: 50 });
    });

    it("rejects an over-ceiling topK instead of silently truncating the result", async () => {
        expect.assertions(1);

        const introspector = createVectorAdminIntrospector({
            embedders: { by_body: async () => [1, 0, 0] },
            indexes: { by_body: fakeIndex() },
            registry: REGISTRY,
        });

        // Clamping made the studio show 20 rows for a 100-row request and say
        // nothing, so the caller could not tell a truncated page from an
        // exhausted index. The user path throws; so does this one.
        await expect(introspector.queryIndex?.({ name: "by_body", text: "hello", topK: 100 })).rejects.toThrow(/topK must be an integer in \[1, 50\]/);
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

    it("rejects a prototype-key index name with a controlled LunoraError, never calling the embedder", async () => {
        expect.assertions(7);

        const embed = vi.fn<(text: string) => Promise<number[]>>(async () => [1, 0, 0]);
        const introspector = createVectorAdminIntrospector({
            embedders: { by_body: embed },
            indexes: { by_body: fakeIndex() },
            registry: REGISTRY,
        });

        // "__proto__"/"constructor" are inherited on the plain `indexes` object,
        // so a truthiness/undefined guard would let them slip through and then
        // call a non-function → raw TypeError (500 + unvetted wire shape). The
        // own-property check must route them into the controlled LunoraError.
        for (const name of ["__proto__", "constructor"]) {
            // eslint-disable-next-line no-await-in-loop -- sequential assertions keep the mock-call check unambiguous
            const error = await introspector.queryIndex?.({ name, text: "x" }).catch((error_: unknown) => error_);

            expect(error).toBeInstanceOf(LunoraError);
            expect((error as LunoraError).code).toBe("INTERNAL");
            expect((error as LunoraError).message).toMatch(/no Vectorize binding registered/);
        }

        expect(embed).not.toHaveBeenCalled();
    });
});
