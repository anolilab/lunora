import { describe, expect, it, vi } from "vitest";

import { createVectors } from "../src/create-vectors.js";
import type { VectorizeDeleteMutation, VectorizeIndexLike, VectorizeMatches, VectorizeUpsertMutation, VectorizeVector } from "../src/types.js";

const fakeIndex = (overrides: Partial<VectorizeIndexLike> = {}): VectorizeIndexLike => ({
    upsert: vi.fn(async (vectors): Promise<VectorizeUpsertMutation> => ({ mutationId: `upsert-${vectors.length}` })),
    insert: vi.fn(async (vectors): Promise<VectorizeUpsertMutation> => ({ mutationId: `insert-${vectors.length}` })),
    query: vi.fn(
        async (): Promise<VectorizeMatches> => ({
            matches: [{ id: "row-1", score: 0.9 }],
            count: 1,
        }),
    ),
    getByIds: vi.fn(async (ids: ReadonlyArray<string>): Promise<ReadonlyArray<VectorizeVector>> => ids.map((id) => ({ id, values: [0, 0, 0] }))),
    deleteByIds: vi.fn(async (ids: ReadonlyArray<string>): Promise<VectorizeDeleteMutation> => ({ mutationId: `delete-${ids.length}`, count: ids.length })),
    ...overrides,
});

describe("createVectors", () => {
    it("rejects construction without any index bindings", () => {
        expect(() => createVectors({ indexes: {} })).toThrow(/at least one index/i);
    });

    it("throws a descriptive error when an unknown index is referenced", async () => {
        const vectors = createVectors({ indexes: { "docs-body": fakeIndex() } });

        await expect(vectors.deleteByIds("unknown", ["a"])).rejects.toThrow(/no index registered for "unknown"/);
        await expect(vectors.deleteByIds("unknown", ["a"])).rejects.toThrow(/docs-body/);
    });

    it("calls the user embedFn at upsert time and forwards id + metadata", async () => {
        const index = fakeIndex();
        const vectors = createVectors({ indexes: { docs: index } });
        const embed = vi.fn(async (value: string) => [value.length, value.length + 1, value.length + 2]);

        await vectors.upsert("docs", {
            id: "doc-42",
            input: "hello",
            embed,
            metadata: { title: "Hello" },
            namespace: "tenant-1",
        });

        expect(embed).toHaveBeenCalledWith("hello");
        expect(index.upsert).toHaveBeenCalledWith([
            {
                id: "doc-42",
                values: [5, 6, 7],
                metadata: { title: "Hello" },
                namespace: "tenant-1",
            },
        ]);
    });

    it("batches upsertMany into a single binding call", async () => {
        const index = fakeIndex();
        const vectors = createVectors({ indexes: { docs: index } });
        const embed = async (text: string): Promise<ReadonlyArray<number>> => [text.length];

        const result = await vectors.upsertMany("docs", [
            { id: "a", input: "x", embed },
            { id: "b", input: "yy", embed },
            { id: "c", input: "zzz", embed },
        ]);

        expect(index.upsert).toHaveBeenCalledTimes(1);
        expect(index.upsert).toHaveBeenCalledWith([
            { id: "a", values: [1], metadata: undefined, namespace: undefined },
            { id: "b", values: [2], metadata: undefined, namespace: undefined },
            { id: "c", values: [3], metadata: undefined, namespace: undefined },
        ]);
        expect(result.mutationId).toBe("upsert-3");
    });

    it("queries by precomputed vector without invoking embed", async () => {
        const index = fakeIndex();
        const vectors = createVectors({ indexes: { docs: index } });
        const embed = vi.fn();

        const result = await vectors.query("docs", { vector: [0.1, 0.2, 0.3], topK: 5, embed });

        expect(embed).not.toHaveBeenCalled();
        expect(index.query).toHaveBeenCalledWith([0.1, 0.2, 0.3], expect.objectContaining({ topK: 5 }));
        expect(result.matches).toHaveLength(1);
    });

    it("queries by input + embedFn when no vector is provided", async () => {
        const index = fakeIndex();
        const vectors = createVectors({ indexes: { docs: index } });
        const embed = vi.fn(async (text: string) => [text.length, text.length]);

        await vectors.query("docs", { input: "wide", embed, topK: 3, filter: { tenant: "t-1" } });

        expect(embed).toHaveBeenCalledWith("wide");
        expect(index.query).toHaveBeenCalledWith([4, 4], expect.objectContaining({ topK: 3, filter: { tenant: "t-1" } }));
    });

    it("errors when query has neither vector nor input+embed", async () => {
        const vectors = createVectors({ indexes: { docs: fakeIndex() } });

        await expect(vectors.query("docs", {})).rejects.toThrow(/requires either/i);
    });

    it("passes through getByIds and deleteByIds unchanged", async () => {
        const index = fakeIndex();
        const vectors = createVectors({ indexes: { docs: index } });

        const got = await vectors.getByIds("docs", ["a", "b"]);
        const deleted = await vectors.deleteByIds("docs", ["a", "b"]);

        expect(index.getByIds).toHaveBeenCalledWith(["a", "b"]);
        expect(got).toEqual([
            { id: "a", values: [0, 0, 0] },
            { id: "b", values: [0, 0, 0] },
        ]);
        expect(index.deleteByIds).toHaveBeenCalledWith(["a", "b"]);
        expect(deleted.count).toBe(2);
    });

    it("rejects describe when the binding does not implement it", async () => {
        const index = fakeIndex({ describe: undefined });
        const vectors = createVectors({ indexes: { docs: index } });

        await expect(vectors.describe("docs")).rejects.toThrow(/does not implement describe/);
    });

    it("forwards describe when the binding implements it", async () => {
        const index = fakeIndex({
            describe: vi.fn(async () => ({ dimensions: 1024, vectorsCount: 99 })),
        });
        const vectors = createVectors({ indexes: { docs: index } });

        const result = await vectors.describe("docs");

        expect(result).toEqual({ dimensions: 1024, vectorsCount: 99 });
    });

    it("supports sync embedFn return values", async () => {
        const index = fakeIndex();
        const vectors = createVectors({ indexes: { docs: index } });
        const embed = (text: string): ReadonlyArray<number> => [text.length];

        await vectors.upsert("docs", { id: "row", input: "abc", embed });

        expect(index.upsert).toHaveBeenCalledWith([{ id: "row", values: [3], metadata: undefined, namespace: undefined }]);
    });
});
