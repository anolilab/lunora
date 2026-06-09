import { describe, expect, it, vi } from "vitest";

import { createVectors } from "../src/create-vectors";
import type {
    EmbedFn as EmbedFunction,
    VectorizeDeleteMutation,
    VectorizeIndexLike,
    VectorizeMatches,
    VectorizeUpsertMutation,
    VectorizeVector,
} from "../src/types";

const fakeIndex = (overrides: Partial<VectorizeIndexLike> = {}): VectorizeIndexLike => {
    return {
        deleteByIds: vi.fn<VectorizeIndexLike["deleteByIds"]>(async (ids: ReadonlyArray<string>): Promise<VectorizeDeleteMutation> => {
            return { count: ids.length, mutationId: `delete-${ids.length}` };
        }),
        getByIds: vi.fn<VectorizeIndexLike["getByIds"]>(
            async (ids: ReadonlyArray<string>): Promise<ReadonlyArray<VectorizeVector>> =>
                ids.map((id) => {
                    return { id, values: [0, 0, 0] };
                }),
        ),
        insert: vi.fn<VectorizeIndexLike["insert"]>(async (vectors): Promise<VectorizeUpsertMutation> => {
            return { mutationId: `insert-${vectors.length}` };
        }),
        query: vi.fn<VectorizeIndexLike["query"]>(async (): Promise<VectorizeMatches> => {
            return {
                count: 1,
                matches: [{ id: "row-1", score: 0.9 }],
            };
        }),
        upsert: vi.fn<VectorizeIndexLike["upsert"]>(async (vectors): Promise<VectorizeUpsertMutation> => {
            return { mutationId: `upsert-${vectors.length}` };
        }),
        ...overrides,
    };
};

describe("createVectors", () => {
    it("rejects construction without any index bindings", () => {
        expect.assertions(1);

        expect(() => createVectors({ indexes: {} })).toThrow(/at least one index/i);
    });

    it("throws a descriptive error when an unknown index is referenced", async () => {
        expect.assertions(2);

        const vectors = createVectors({ indexes: { "docs-body": fakeIndex() } });

        await expect(vectors.deleteByIds("unknown", ["a"])).rejects.toThrow(/no index registered for "unknown"/);
        await expect(vectors.deleteByIds("unknown", ["a"])).rejects.toThrow(/docs-body/);
    });

    it("calls the user embedFn at upsert time and forwards id + metadata", async () => {
        expect.assertions(2);

        const index = fakeIndex();
        const vectors = createVectors({ indexes: { docs: index } });
        const embed = vi.fn<EmbedFunction<string>>(async (value: string) => [value.length, value.length + 1, value.length + 2]);

        await vectors.upsert("docs", {
            embed,
            id: "doc-42",
            input: "hello",
            metadata: { title: "Hello" },
            namespace: "tenant-1",
        });

        expect(embed).toHaveBeenCalledWith("hello");
        expect(index.upsert).toHaveBeenCalledWith([
            {
                id: "doc-42",
                metadata: { title: "Hello" },
                namespace: "tenant-1",
                values: [5, 6, 7],
            },
        ]);
    });

    it("batches upsertMany into a single binding call", async () => {
        expect.assertions(3);

        const index = fakeIndex();
        const vectors = createVectors({ indexes: { docs: index } });
        const embed = async (text: string): Promise<ReadonlyArray<number>> => [text.length];

        const result = await vectors.upsertMany("docs", [
            { embed, id: "a", input: "x" },
            { embed, id: "b", input: "yy" },
            { embed, id: "c", input: "zzz" },
        ]);

        expect(index.upsert).toHaveBeenCalledTimes(1);
        expect(index.upsert).toHaveBeenCalledWith([
            { id: "a", metadata: undefined, namespace: undefined, values: [1] },
            { id: "b", metadata: undefined, namespace: undefined, values: [2] },
            { id: "c", metadata: undefined, namespace: undefined, values: [3] },
        ]);
        expect(result.mutationId).toBe("upsert-3");
    });

    it("queries by precomputed vector without invoking embed", async () => {
        expect.assertions(3);

        const index = fakeIndex();
        const vectors = createVectors({ indexes: { docs: index } });
        const embed = vi.fn<EmbedFunction<string>>();

        const result = await vectors.query("docs", { embed, topK: 5, vector: [0.1, 0.2, 0.3] });

        expect(embed).not.toHaveBeenCalled();
        expect(index.query).toHaveBeenCalledWith([0.1, 0.2, 0.3], expect.objectContaining({ topK: 5 }));
        expect(result.matches).toHaveLength(1);
    });

    it("queries by input + embedFn when no vector is provided", async () => {
        expect.assertions(2);

        const index = fakeIndex();
        const vectors = createVectors({ indexes: { docs: index } });
        const embed = vi.fn<EmbedFunction<string>>(async (text: string) => [text.length, text.length]);

        await vectors.query("docs", { embed, filter: { tenant: "t-1" }, input: "wide", topK: 3 });

        expect(embed).toHaveBeenCalledWith("wide");
        expect(index.query).toHaveBeenCalledWith([4, 4], expect.objectContaining({ filter: { tenant: "t-1" }, topK: 3 }));
    });

    it("errors when query has neither vector nor input+embed", async () => {
        expect.assertions(1);

        const vectors = createVectors({ indexes: { docs: fakeIndex() } });

        await expect(vectors.query("docs", {})).rejects.toThrow(/requires either/i);
    });

    it("treats an empty precomputed vector as absent and falls through to embed", async () => {
        expect.assertions(3);

        const index = fakeIndex();
        const vectors = createVectors({ indexes: { docs: index } });
        const embed = vi.fn<EmbedFunction<string>>(async (text: string) => [text.length]);

        // `[]` is truthy but unusable: it must not be forwarded to index.query.
        await vectors.query("docs", { embed, input: "hi", vector: [] });

        expect(embed).toHaveBeenCalledWith("hi");
        expect(index.query).toHaveBeenCalledWith([2], expect.anything());
        await expect(vectors.query("docs", { vector: [] })).rejects.toThrow(/requires either/i);
    });

    it("rejects upsertMany batches over the 1000 limit", async () => {
        expect.assertions(2);

        const vectors = createVectors({ indexes: { docs: fakeIndex() } });
        const embed = (text: string): ReadonlyArray<number> => [text.length];
        const inputs = Array.from({ length: 1001 }, (_, index) => {
            return { embed, id: `id-${String(index)}`, input: "x" };
        });

        await expect(vectors.upsertMany("docs", inputs)).rejects.toThrow(RangeError);
        await expect(vectors.upsertMany("docs", inputs)).rejects.toThrow(/exceeds 1000/);
    });

    it("rejects getByIds / deleteByIds id batches over the 1000 limit", async () => {
        expect.assertions(2);

        const vectors = createVectors({ indexes: { docs: fakeIndex() } });
        const ids = Array.from({ length: 1001 }, (_, index) => `id-${String(index)}`);

        await expect(vectors.getByIds("docs", ids)).rejects.toThrow(/at most 1000 ids/);
        await expect(vectors.deleteByIds("docs", ids)).rejects.toThrow(/at most 1000 ids/);
    });

    it.each([0, 101, 1.5, -1])("rejects an out-of-range or non-integer topK (%s)", async (topK) => {
        expect.assertions(1);

        const vectors = createVectors({ indexes: { docs: fakeIndex() } });

        await expect(vectors.query("docs", { topK, vector: [0.1] })).rejects.toThrow(/topK must be an integer in \[1, 100\]/);
    });

    it("passes through getByIds and deleteByIds unchanged", async () => {
        expect.assertions(4);

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
        expect.assertions(1);

        const index = fakeIndex({ describe: undefined });
        const vectors = createVectors({ indexes: { docs: index } });

        await expect(vectors.describe("docs")).rejects.toThrow(/does not implement describe/);
    });

    it("forwards describe when the binding implements it", async () => {
        expect.assertions(1);

        const index = fakeIndex({
            describe: vi.fn<NonNullable<VectorizeIndexLike["describe"]>>(async () => {
                return { dimensions: 1024, vectorsCount: 99 };
            }),
        });
        const vectors = createVectors({ indexes: { docs: index } });

        const result = await vectors.describe("docs");

        expect(result).toEqual({ dimensions: 1024, vectorsCount: 99 });
    });

    it("supports sync embedFn return values", async () => {
        expect.assertions(1);

        const index = fakeIndex();
        const vectors = createVectors({ indexes: { docs: index } });
        const embed = (text: string): ReadonlyArray<number> => [text.length];

        await vectors.upsert("docs", { embed, id: "row", input: "abc" });

        expect(index.upsert).toHaveBeenCalledWith([{ id: "row", metadata: undefined, namespace: undefined, values: [3] }]);
    });
});
