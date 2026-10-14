import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RowClient } from "../src/global-exec";
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
 * The score assertions are therefore written against Cloudflare's documented
 * numbers, not against whatever pgvector happens to return.
 */
let harness: PgliteHarness;

describe("createPgVectorIndex", () => {
    beforeEach(async () => {
        harness = await createPgliteHarness();
    });

    afterEach(async () => {
        await harness.close();
    });

    const index = (options: Partial<Parameters<typeof createPgVectorIndex>[0]> = {}) =>
        createPgVectorIndex({ client: harness.client, dimensions: 3, name: "docs", ...options });

    it("provisions lazily and round-trips a vector", async () => {
        expect.assertions(2);

        const store = index();

        await store.upsert([{ id: "a", metadata: { lang: "en" }, values: [1, 0, 0] }]);

        const [row] = await store.getByIds(["a"]);

        expect(row).toMatchObject({ id: "a", metadata: { lang: "en" } });
        // Values survive the `vector` round trip as real numbers, not the text literal.
        expect(row?.values).toStrictEqual([1, 0, 0]);
    });

    it("orders by cosine similarity, nearest first, and scores 1 for an exact match", async () => {
        expect.assertions(3);

        const store = index();

        await store.upsert([
            { id: "same", values: [1, 0, 0] },
            { id: "orthogonal", values: [0, 1, 0] },
            { id: "opposite", values: [-1, 0, 0] },
        ]);

        const result = await store.query([1, 0, 0], { topK: 3 });

        expect(result.matches.map((match) => match.id)).toStrictEqual(["same", "orthogonal", "opposite"]);
        // Cosine SIMILARITY, not distance — the number Vectorize reports.
        expect(result.matches[0]?.score).toBeCloseTo(1, 5);
        expect(result.matches[2]?.score).toBeCloseTo(-1, 5);
    });

    it("reports euclidean as a raw distance", async () => {
        expect.assertions(2);

        const l2 = index({ metric: "euclidean", name: "l2" });

        await l2.upsert([
            { id: "near", values: [1, 0, 0] },
            { id: "far", values: [9, 0, 0] },
        ]);

        const result = await l2.query([1, 0, 0], { topK: 2 });

        expect(result.matches.map((match) => match.id)).toStrictEqual(["near", "far"]);
        // 0 for the exact match, matching Vectorize's raw (not squared) L2.
        expect(result.matches[0]?.score).toBeCloseTo(0, 5);
    });

    it("reports dot-product as the NEGATIVE inner product, the way Vectorize does", async () => {
        expect.assertions(2);

        const ip = index({ metric: "dot-product", name: "ip" });

        await ip.upsert([
            { id: "big", values: [9, 0, 0] },
            { id: "small", values: [1, 0, 0] },
        ]);

        const result = await ip.query([1, 0, 0], { topK: 2 });

        // Cloudflare: "larger negative values … denote more similar vectors …
        // a score of -1000 is more similar than -500". `<#>` already returns
        // -(a·b), so it passes straight through. Negating it would leave this
        // ordering assertion passing while every score came back inverted —
        // which is exactly how the bug shipped the first time.
        expect(result.matches.map((match) => match.id)).toStrictEqual(["big", "small"]);
        expect(result.matches[0]?.score).toBeCloseTo(-9, 5);
    });

    it("scopes a query to its namespace", async () => {
        expect.assertions(2);

        const store = index();

        await store.upsert([
            { id: "en", namespace: "en", values: [1, 0, 0] },
            { id: "de", namespace: "de", values: [1, 0, 0] },
        ]);

        const scoped = await store.query([1, 0, 0], { namespace: "de", topK: 5 });

        expect(scoped.matches.map((match) => match.id)).toStrictEqual(["de"]);
        expect(scoped.matches[0]?.namespace).toBe("de");
    });

    /**
     * The regression that matters most and is the least visible.
     *
     * pgvector applies `WHERE` AFTER scanning the HNSW index, so when the planner
     * picks that index a selective filter starves the page — the caller gets fewer
     * than `topK` rows, with no error. `query` avoids it by resolving the filter in
     * a materialized CTE and ordering exactly over what survives.
     *
     * SCALE IS THE TEST. At a few hundred rows the planner prefers a bitmap scan
     * plus an exact sort, which is correct and hides the defect entirely — two
     * earlier versions of this test passed against the broken code for that reason.
     * 6 000 rows over 40 namespaces is where the cost model flips to the ANN scan.
     *
     * Verified against the pre-fix query shape at this size: `topK: 5` returned 1
     * row. Note the inversion — a SMALLER `topK` is more broken, so the default
     * shape (`DEFAULT_TOP_K`, a sharded table, no explicit topK) is the worst case.
     */
    it("returns a full page when a filter is selective and the table is big enough to prefer the ANN index", async () => {
        expect.assertions(4);

        const store = index({ name: "tenants" });
        const rows = Array.from({ length: 6000 }, (_, position) => {
            return {
                id: `doc-${String(position)}`,
                metadata: { tenant: `ten${String(position % 40)}` },
                namespace: `ten${String(position % 40)}`,
                values: [1, position / 6000, (position % 7) / 7],
            };
        });

        for (let cursor = 0; cursor < rows.length; cursor += 1000) {
            // eslint-disable-next-line no-await-in-loop -- sequential batches keep the statement under Postgres' bind-parameter cap
            await store.upsert(rows.slice(cursor, cursor + 1000));
        }

        await harness.query('ANALYZE "__vec_tenants"');

        // The default topK is the worst case, so pin it explicitly as well.
        const byNamespace = await store.query([1, 0, 0], { namespace: "ten7", topK: 5 });
        const byMetadata = await store.query([1, 0, 0], { filter: { tenant: "ten7" }, topK: 5 });
        const defaulted = await store.query([1, 0, 0], { namespace: "ten7" });

        expect(byNamespace.matches).toHaveLength(5);
        expect(byMetadata.matches).toHaveLength(5);
        expect(defaulted.matches).toHaveLength(5);
        // And the RIGHT rows, not merely five of them.
        expect(byNamespace.matches.every((match) => match.namespace === "ten7")).toBe(true);
    });

    it("filters on metadata equality", async () => {
        expect.assertions(1);

        const store = index();

        await store.upsert([
            { id: "draft", metadata: { status: "draft" }, values: [1, 0, 0] },
            { id: "live", metadata: { status: "published" }, values: [1, 0, 0] },
        ]);

        const filtered = await store.query([1, 0, 0], { filter: { status: "published" }, topK: 5 });

        expect(filtered.matches.map((match) => match.id)).toStrictEqual(["live"]);
    });

    /**
     * Every shape here would otherwise be accepted by JSONB containment, match
     * nothing, and return an empty page that reads exactly like "no similar
     * vectors" — the silent wrong answer this guard exists to prevent.
     */
    it("rejects filters it cannot honour instead of silently returning nothing", async () => {
        expect.assertions(11);

        const store = index();

        await store.upsert([{ id: "a", metadata: { author: { role: "admin" } }, values: [1, 0, 0] }]);

        await expect(store.query([1, 0, 0], { filter: { views: { $gt: 10 } } })).rejects.toThrow(/comparison operator/);
        // Nested one level down — a top-level-only check lets this through.
        await expect(store.query([1, 0, 0], { filter: { author: { profile: { $gt: 3 } } } })).rejects.toThrow(/comparison operator/);
        // Hidden inside an array.
        await expect(store.query([1, 0, 0], { filter: { tags: [{ $in: ["a"] }] } })).rejects.toThrow(/comparison operator/);
        // Vectorize's dot-addressed nested key; `@>` would look for a literal "author.role".
        await expect(store.query([1, 0, 0], { filter: { "author.role": "admin" } })).rejects.toThrow(/dot-addressed/);
        // Every one of these is dropped by `JSON.stringify`, narrowing the filter
        // toward `{}` — which matches every row that has metadata at all. They fail
        // OPEN, across tenants, which is why they are rejected rather than trusted
        // to be unreachable: `filter` is `Record<string, unknown>`.
        await expect(store.query([1, 0, 0], { filter: { author: { role: undefined } } })).rejects.toThrow(/JSON cannot represent/);
        await expect(store.query([1, 0, 0], { filter: { tenant: () => "x" } })).rejects.toThrow(/JSON cannot represent/);
        await expect(store.query([1, 0, 0], { filter: { tenant: Symbol("x") } })).rejects.toThrow(/JSON cannot represent/);
        await expect(store.query([1, 0, 0], { filter: { tags: [undefined, "z"] } })).rejects.toThrow(/JSON cannot represent/);
        // A `$` operator at the TOP level is Vectorize-legal shape too.
        await expect(store.query([1, 0, 0], { filter: { $gt: 5 } })).rejects.toThrow(/comparison operator/);
        // JSON turns these into `null`, which filters for null-valued rows instead.
        await expect(store.query([1, 0, 0], { filter: { score: Number.NaN } })).rejects.toThrow(/non-finite/);
        // And throws outright on a bigint — caught here, before anything provisions.
        await expect(store.query([1, 0, 0], { filter: { size: 1n } })).rejects.toThrow(/bigint/);
    });

    /**
     * The fail-open shape the guard above could not see: `Object.entries` is
     * `[]` for a `Map`, a `Set`, a `Date` or a class instance, so walking one
     * inspects nothing and rejects nothing, and `JSON.stringify` turns it into
     * `{}` — a containment document EVERY row with metadata matches. At the top
     * level it is worse still: `Object.keys(new Map())` is empty, so the
     * length-keyed gate skipped both the guard and the containment clause and
     * issued an unfiltered query across every tenant.
     */
    it("rejects a non-plain object anywhere in the filter rather than matching every tenant", async () => {
        expect.assertions(6);

        const store = index();

        await store.upsert([
            { id: "mine", metadata: { tenant: "t1" }, values: [1, 0, 0] },
            { id: "theirs", metadata: { tenant: "t2" }, values: [1, 0, 0] },
        ]);

        await expect(store.query([1, 0, 0], { filter: { tenant: new Map([["id", "t1"]]) } })).rejects.toThrow(/Map/);
        await expect(store.query([1, 0, 0], { filter: { tenant: new Set(["t1"]) } })).rejects.toThrow(/Set/);
        await expect(store.query([1, 0, 0], { filter: { since: new Date(0) } })).rejects.toThrow(/Date/);
        await expect(store.query([1, 0, 0], { filter: { tags: [new Map()] } })).rejects.toThrow(/Map/);
        // The filter ITSELF, where no own enumerable key exists to count.
        await expect(store.query([1, 0, 0], { filter: new Map([["tenant", "t1"]]) as unknown as Record<string, unknown> })).rejects.toThrow(/Map/);

        // A plain nested object is still fine.
        const ok = await store.query([1, 0, 0], { filter: { tenant: "t1" }, topK: 5 });

        expect(ok.matches.map((match) => match.id)).toStrictEqual(["mine"]);
    });

    it("omits metadata and values unless the caller asks", async () => {
        expect.assertions(4);

        const store = index();

        await store.upsert([{ id: "a", metadata: { lang: "en" }, values: [1, 0, 0] }]);

        const lean = await store.query([1, 0, 0], { topK: 1 });

        expect(lean.matches[0]?.metadata).toBeUndefined();
        expect(lean.matches[0]?.values).toBeUndefined();

        const full = await store.query([1, 0, 0], { returnMetadata: "all", returnValues: true, topK: 1 });

        expect(full.matches[0]?.metadata).toStrictEqual({ lang: "en" });
        expect(full.matches[0]?.values).toStrictEqual([1, 0, 0]);
    });

    it("treats returnMetadata 'indexed' as 'all', as documented", async () => {
        expect.assertions(1);

        const store = index();

        await store.upsert([{ id: "a", metadata: { lang: "en" }, values: [1, 0, 0] }]);

        const result = await store.query([1, 0, 0], { returnMetadata: "indexed", topK: 1 });

        expect(result.matches[0]?.metadata).toStrictEqual({ lang: "en" });
    });

    it("takes the last write when one batch repeats an id, as Vectorize does", async () => {
        expect.assertions(1);

        const store = index();

        // `ON CONFLICT ... DO UPDATE` errors (SQLSTATE 21000) if one statement
        // touches the same id twice; a real binding just keeps the last value.
        await store.upsert([
            { id: "dup", metadata: { v: 1 }, values: [1, 0, 0] },
            { id: "dup", metadata: { v: 2 }, values: [0, 1, 0] },
        ]);

        const [row] = await store.getByIds(["dup"]);

        expect(row?.metadata).toStrictEqual({ v: 2 });
    });

    it("upsert overwrites while insert leaves an existing id alone", async () => {
        expect.assertions(2);

        const store = index();

        await store.upsert([{ id: "a", metadata: { v: 1 }, values: [1, 0, 0] }]);
        await store.insert([{ id: "a", metadata: { v: 2 }, values: [0, 1, 0] }]);

        const [afterInsert] = await store.getByIds(["a"]);

        expect(afterInsert?.metadata).toStrictEqual({ v: 1 });

        await store.upsert([{ id: "a", metadata: { v: 3 }, values: [0, 1, 0] }]);

        const [afterUpsert] = await store.getByIds(["a"]);

        expect(afterUpsert?.metadata).toStrictEqual({ v: 3 });
    });

    it("reports deleted count and describes the index", async () => {
        expect.assertions(3);

        const store = index();

        await store.upsert([
            { id: "a", values: [1, 0, 0] },
            { id: "b", values: [0, 1, 0] },
        ]);

        await expect(store.describe?.()).resolves.toStrictEqual({ dimensions: 3, vectorsCount: 2 });

        const deleted = await store.deleteByIds(["a", "missing"]);

        expect(deleted.count).toBe(1);
        await expect(store.getByIds(["a"])).resolves.toStrictEqual([]);
    });

    it("refuses a dimension mismatch at the engine rather than storing a bad row", async () => {
        expect.assertions(1);

        const store = index();

        await expect(store.upsert([{ id: "a", values: [1, 0] }])).rejects.toThrow(/expected 3 dimensions/);
    });

    it("rejects unsafe or unusable construction arguments", async () => {
        expect.assertions(6);

        expect(() => index({ name: "docs; DROP TABLE users" })).toThrow(/bare SQL identifier/);
        expect(() => index({ dimensions: 0 })).toThrow(/positive integer/);
        // Past the HNSW ceiling the CREATE INDEX fails opaquely, after the table exists.
        expect(() => index({ dimensions: 3072 })).toThrow(/HNSW limit/);
        // Postgres truncates at 63 bytes and the longest derived name is
        // `__vec_` + name + `__ann_` + `vector_cosine_ops` (29 fixed chars), so 35
        // is one over and two names sharing a prefix would collide after truncation.
        expect(() => index({ name: "a".repeat(35) })).toThrow(/at most/);
        expect(() => index({ metric: "manhattan" as never })).toThrow(/unknown metric/);
        // `in` would walk the prototype chain and let this through to a broken lookup.
        expect(() => index({ metric: "toString" as never })).toThrow(/unknown metric/);
    });

    it("provisions once for concurrent callers, and retries after a transient failure", async () => {
        expect.assertions(3);

        let ddl = 0;
        let failNext = true;
        const counting: RowClient = {
            query: async <Row = Record<string, unknown>>(text: string, parameters?: ReadonlyArray<unknown>): Promise<Row[]> => {
                if (text.startsWith("CREATE")) {
                    ddl += 1;

                    if (failNext) {
                        failNext = false;

                        throw new Error("connection reset");
                    }
                }

                return harness.client.query<Row>(text, parameters);
            },
        };

        const store = createPgVectorIndex({ client: counting, dimensions: 3, name: "retry" });

        // A transient DDL failure must NOT be cached: the write-through vector
        // sync runs inline in the mutation, so a stuck rejection would fail every
        // mutation on the table until the isolate is evicted.
        await expect(store.upsert([{ id: "a", values: [1, 0, 0] }])).rejects.toThrow(/connection reset/);

        await store.upsert([{ id: "a", values: [1, 0, 0] }]);

        const ddlAfterSuccess = ddl;

        // Concurrent callers past the first success share the memo — no more DDL.
        await Promise.all([store.upsert([{ id: "b", values: [0, 1, 0] }]), store.upsert([{ id: "c", values: [0, 0, 1] }])]);

        expect(ddl).toBe(ddlAfterSuccess);
        await expect(store.getByIds(["a", "b", "c"])).resolves.toHaveLength(3);
    });

    it("no-ops on empty batches without reaching the engine", async () => {
        expect.assertions(3);

        const spy = vi.fn<(text: string, parameters?: ReadonlyArray<unknown>) => Promise<Record<string, unknown>[]>>((text, parameters) =>
            harness.client.query(text, parameters),
        );
        const store = createPgVectorIndex({ client: { query: spy } as unknown as RowClient, dimensions: 3, name: "empty" });

        const upserted = await store.upsert([]);
        const deleted = await store.deleteByIds([]);

        expect(upserted.mutationId).toBeTypeOf("string");
        expect(deleted.count).toBe(0);
        // The name is the assertion: an empty batch must not provision either.
        expect(spy).not.toHaveBeenCalled();
    });
});
