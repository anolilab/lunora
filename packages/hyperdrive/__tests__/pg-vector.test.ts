import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPgVectorIndex } from "../src/pg-vector";
import type { PgliteHarness } from "./_helpers/pglite-exec";
import createPgliteHarness from "./_helpers/pglite-exec";

/**
 * The pgvector index is proved against a REAL Postgres with the real extension
 * (PGlite + `pgvector`), not a statement-shape mock — the whole point of the
 * store is that `<=>`/`<->`/`<#>`, the `::vector` cast, HNSW operator classes,
 * and JSONB containment behave the way the code assumes. A mock would assert my
 * own SQL back to me.
 *
 * What matters here is the CONTRACT: this object has to be indistinguishable
 * from a Vectorize binding to the caller above it (`createVectors`, the write-
 * through sync hook, `ctx.vectors`), because that caller cannot tell them apart.
 */
const embedding = (values: number[]): number[] => values;

let harness: PgliteHarness;

describe("createPgVectorIndex", () => {
    beforeEach(async () => {
        harness = await createPgliteHarness({ vector: true });
    });

    afterEach(async () => {
        await harness.close();
    });

    const index = (options: Partial<Parameters<typeof createPgVectorIndex>[0]> = {}) =>
        createPgVectorIndex({ client: harness.client, dimensions: 3, name: "docs", ...options });

    it("provisions lazily and round-trips a vector", async () => {
        expect.assertions(2);

        const store = index();

        await store.upsert([{ id: "a", metadata: { lang: "en" }, values: embedding([1, 0, 0]) }]);

        const [row] = await store.getByIds(["a"]);

        expect(row).toMatchObject({ id: "a", metadata: { lang: "en" } });
        // Values survive the `vector` round trip as real numbers, not the text literal.
        expect(row?.values).toStrictEqual([1, 0, 0]);
    });

    it("orders by cosine similarity, nearest first, and scores 1 for an exact match", async () => {
        expect.assertions(3);

        const store = index();

        await store.upsert([
            { id: "same", values: embedding([1, 0, 0]) },
            { id: "orthogonal", values: embedding([0, 1, 0]) },
            { id: "opposite", values: embedding([-1, 0, 0]) },
        ]);

        const result = await store.query(embedding([1, 0, 0]), { topK: 3 });

        expect(result.matches.map((match) => match.id)).toStrictEqual(["same", "orthogonal", "opposite"]);
        // Cosine SIMILARITY, not distance — the number Vectorize reports.
        expect(result.matches[0]?.score).toBeCloseTo(1, 5);
        expect(result.matches[2]?.score).toBeCloseTo(-1, 5);
    });

    it("keeps 'smaller is better' ordering for euclidean and dot-product too", async () => {
        expect.assertions(4);

        const l2 = index({ metric: "euclidean", name: "l2", table: "__vec_l2" });

        await l2.upsert([
            { id: "near", values: embedding([1, 0, 0]) },
            { id: "far", values: embedding([9, 0, 0]) },
        ]);

        const byDistance = await l2.query(embedding([1, 0, 0]), { topK: 2 });

        expect(byDistance.matches.map((match) => match.id)).toStrictEqual(["near", "far"]);
        // Euclidean reports raw distance: 0 for the exact match.
        expect(byDistance.matches[0]?.score).toBeCloseTo(0, 5);

        const ip = index({ metric: "dot-product", name: "ip", table: "__vec_ip" });

        await ip.upsert([
            { id: "big", values: embedding([9, 0, 0]) },
            { id: "small", values: embedding([1, 0, 0]) },
        ]);

        const byProduct = await ip.query(embedding([1, 0, 0]), { topK: 2 });

        // `<#>` is the NEGATIVE inner product, so ascending order still puts the
        // largest product first — and the reported score is the plain product.
        expect(byProduct.matches.map((match) => match.id)).toStrictEqual(["big", "small"]);
        expect(byProduct.matches[0]?.score).toBeCloseTo(9, 5);
    });

    it("scopes a query to its namespace", async () => {
        expect.assertions(2);

        const store = index();

        await store.upsert([
            { id: "en", namespace: "en", values: embedding([1, 0, 0]) },
            { id: "de", namespace: "de", values: embedding([1, 0, 0]) },
        ]);

        const scoped = await store.query(embedding([1, 0, 0]), { namespace: "de", topK: 5 });

        expect(scoped.matches.map((match) => match.id)).toStrictEqual(["de"]);
        expect(scoped.matches[0]?.namespace).toBe("de");
    });

    it("filters on metadata equality", async () => {
        expect.assertions(1);

        const store = index();

        await store.upsert([
            { id: "draft", metadata: { status: "draft" }, values: embedding([1, 0, 0]) },
            { id: "live", metadata: { status: "published" }, values: embedding([1, 0, 0]) },
        ]);

        const filtered = await store.query(embedding([1, 0, 0]), { filter: { status: "published" }, topK: 5 });

        expect(filtered.matches.map((match) => match.id)).toStrictEqual(["live"]);
    });

    it("rejects a comparison filter instead of silently ignoring it", async () => {
        expect.assertions(1);

        const store = index();

        await store.upsert([{ id: "a", metadata: { views: 5 }, values: embedding([1, 0, 0]) }]);

        // Dropping the operator would return `a` and look like a working filter.
        await expect(store.query(embedding([1, 0, 0]), { filter: { views: { $gt: 10 } } })).rejects.toThrow(/equality metadata filters only/);
    });

    it("omits metadata and values unless the caller asks", async () => {
        expect.assertions(4);

        const store = index();

        await store.upsert([{ id: "a", metadata: { lang: "en" }, values: embedding([1, 0, 0]) }]);

        const lean = await store.query(embedding([1, 0, 0]), { topK: 1 });

        expect(lean.matches[0]?.metadata).toBeUndefined();
        expect(lean.matches[0]?.values).toBeUndefined();

        const full = await store.query(embedding([1, 0, 0]), { returnMetadata: "all", returnValues: true, topK: 1 });

        expect(full.matches[0]?.metadata).toStrictEqual({ lang: "en" });
        expect(full.matches[0]?.values).toStrictEqual([1, 0, 0]);
    });

    it("upsert overwrites while insert leaves an existing id alone", async () => {
        expect.assertions(2);

        const store = index();

        await store.upsert([{ id: "a", metadata: { v: 1 }, values: embedding([1, 0, 0]) }]);
        await store.insert([{ id: "a", metadata: { v: 2 }, values: embedding([0, 1, 0]) }]);

        const [afterInsert] = await store.getByIds(["a"]);

        expect(afterInsert?.metadata).toStrictEqual({ v: 1 });

        await store.upsert([{ id: "a", metadata: { v: 3 }, values: embedding([0, 1, 0]) }]);

        const [afterUpsert] = await store.getByIds(["a"]);

        expect(afterUpsert?.metadata).toStrictEqual({ v: 3 });
    });

    it("reports deleted count and describes the index", async () => {
        expect.assertions(3);

        const store = index();

        await store.upsert([
            { id: "a", values: embedding([1, 0, 0]) },
            { id: "b", values: embedding([0, 1, 0]) },
        ]);

        await expect(store.describe?.()).resolves.toStrictEqual({ dimensions: 3, vectorsCount: 2 });

        const deleted = await store.deleteByIds(["a", "missing"]);

        expect(deleted.count).toBe(1);
        await expect(store.getByIds(["a"])).resolves.toStrictEqual([]);
    });

    it("refuses a dimension mismatch at the engine rather than storing a bad row", async () => {
        expect.assertions(1);

        const store = index();

        await expect(store.upsert([{ id: "a", values: embedding([1, 0]) }])).rejects.toThrow(/expected 3 dimensions/);
    });

    it("rejects an unsafe table name and a non-positive dimension count", async () => {
        expect.assertions(2);

        expect(() => index({ table: "docs; DROP TABLE users" })).toThrow(/bare SQL identifier/);
        expect(() => index({ dimensions: 0 })).toThrow(/positive integer/);
    });

    it("no-ops on empty batches without touching the engine", async () => {
        expect.assertions(3);

        const store = index();

        const upserted = await store.upsert([]);
        const deleted = await store.deleteByIds([]);

        expect(upserted.mutationId).toBeTypeOf("string");
        expect(deleted.count).toBe(0);
        await expect(store.getByIds([])).resolves.toStrictEqual([]);
    });
});
