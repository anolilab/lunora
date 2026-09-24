import { DatabaseSync } from "node:sqlite";

import type { EmbeddingModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import defineRag from "../../src/rag/define-rag";
import type { RagSqlExec } from "../../src/rag/sql";
import { sqliteVectorStore } from "../../src/rag/sqlite-vector-store";

/**
 * A token-bag embedder: text sharing words embeds to a nearby vector, so
 * ranking is assertable without a model. Mirrors the approach in `rag.test.ts`.
 */
vi.mock(import("ai"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();

    const bagVector = (text: string): number[] => {
        const vector = Array.from<number>({ length: 64 }).fill(0);

        for (const word of text.toLowerCase().split(/[^a-z0-9]+/u)) {
            if (word.length > 0) {
                let hash = 0;

                for (const character of word) {
                    hash = (hash * 31 + character.codePointAt(0)!) % 64;
                }

                vector[hash] = (vector[hash] as number) + 1;
            }
        }

        return vector;
    };

    return {
        ...actual,
        embed: (async ({ value }: { value: string }) => {
            return { embedding: bagVector(value), usage: { tokens: 1 } };
        }) as unknown as typeof actual.embed,
        embedMany: (async ({ values }: { values: ReadonlyArray<string> }) => {
            return { embeddings: values.map((value) => bagVector(value)), usage: { tokens: values.length } };
        }) as unknown as typeof actual.embedMany,
    };
});

const model = { modelId: "bag-embed" } as unknown as EmbeddingModel;

const open = (): { close: () => void; exec: RagSqlExec } => {
    const database = new DatabaseSync(":memory:");

    return {
        close: () => {
            database.close();
        },
        exec: (sql, parameters) => database.prepare(sql).all(...(parameters as never[])),
    };
};

const databases: (() => void)[] = [];

const store = (options: { maxScan?: number } = {}) => {
    const { close, exec } = open();

    databases.push(close);

    return sqliteVectorStore({ exec, ...options });
};

describe("sqliteVectorStore", () => {
    afterEach(() => {
        while (databases.length > 0) {
            databases.pop()?.();
        }
    });

    it("refuses a query whose embedding is a different width than the stored vectors", async () => {
        expect.assertions(2);

        const vectorStore = store();

        // Stored under a 3-dimension model.
        await vectorStore.upsert({ embed: async () => [1, 0, 0], id: "doc#0", input: "A", metadata: { __ragText: "unrelated A" } });
        await vectorStore.upsert({ embed: async () => [0, 1, 0], id: "doc#1", input: "B", metadata: { __ragText: "unrelated B" } });

        // Scoring every mismatched row 0 made the ranking degenerate to table
        // order, so this returned the first `topK` rows — unrelated passages, no
        // error — which is exactly what changing `embeddingModel` without a
        // reindex looked like.
        await expect(vectorStore.query({ embed: async () => [0.5, 0.5, 0.5, 0.5], input: "q", topK: 5 })).rejects.toThrow(
            /the stored vectors are 3-dimension but the query embedding is 4-dimension/u,
        );
        await expect(vectorStore.query({ embed: async () => [0.5, 0.5, 0.5, 0.5], input: "q", topK: 5 })).rejects.toMatchObject({
            code: "RAG_DIMENSION_MISMATCH",
        });
    });

    it("declares no dimension or metadata ceiling", () => {
        expect.assertions(2);

        const vectorStore = store();

        // The whole point: it does not inherit Vectorize's limits.
        expect(vectorStore.capabilities.maxDimensions).toBe(false);
        expect(vectorStore.capabilities.maxMetadataBytes).toBe(false);
    });

    it("publishes a result-count ceiling, not its corpus-scan bound", () => {
        expect.assertions(3);

        // `maxScan` (default 50 000) bounds how much of a namespace may be READ.
        // Publishing it as `maxTopK` let `retrieve(q, { topK: 50000 })` through,
        // and `assembleContext` concatenates every one of those into one prompt.
        const vectorStore = store({ maxScan: 50_000 });

        expect(vectorStore.capabilities.maxTopK).toBe(100);
        expect(vectorStore.capabilities.maxTopKWithMetadata).toBe(100);
        expect(vectorStore.capabilities.maxIdBytes).toBe(false);
    });

    it("bounds the namespace scan in SQL rather than after materialising it", async () => {
        expect.assertions(2);

        const statements: string[] = [];
        const { close, exec } = open();

        databases.push(close);

        const vectorStore = sqliteVectorStore({
            exec: (sql, parameters) => {
                statements.push(sql);

                return exec(sql, parameters);
            },
            maxScan: 3,
        });

        await vectorStore.upsert({ embed: () => [1, 0, 0], id: "doc#0", input: "alpha" });
        await vectorStore.query({ embed: () => [1, 0, 0], input: "alpha", topK: 1 });

        const scan = statements.find((sql) => sql.startsWith("SELECT id, vector"));

        // Without the LIMIT the guard runs AFTER reading every row — at 50 000
        // × ~8 KB of JSON vector that is ~400 MB into a 128 MB isolate, so the
        // explanatory RangeError never gets to throw.
        expect(scan).toContain("LIMIT ?");
        expect(scan).not.toMatch(/LIMIT \d/u);
    });

    it("refuses a chunk id over the store's own id ceiling", async () => {
        expect.assertions(1);

        const shared = store();
        const capped = { ...shared, capabilities: { ...shared.capabilities, maxIdBytes: 64 } };
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: model, index: "docs", store: () => capped });

        // A bucket key under a uuid namespace: the caller never chose this
        // length, and Vectorize rejects it remotely with nothing naming why.
        await expect(
            docs({}).index({
                id: "handbook/engineering/onboarding/day-one-and-the-week-after.md",
                namespace: "6f1c9c9e-6f2f-4a3a-9a5e-2b7c8d9e0f11",
                text: "hello world",
            }),
        ).rejects.toThrow(/over the store's 64-byte per-vector id ceiling/u);
    });

    it("round-trips an index and retrieve against a real SQLite engine", async () => {
        expect.assertions(2);

        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: model, index: "docs", store: () => store() });
        const rag = docs({});

        await rag.index({ id: "weather", metadata: { title: "Weather" }, text: "rain storm cloud thunder" });
        await rag.index({ id: "cooking", metadata: { title: "Cooking" }, text: "pasta tomato basil dinner" });

        const result = await rag.retrieve("storm cloud", { topK: 1 });

        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0]?.sourceId).toBe("weather");
    });

    it("isolates namespaces", async () => {
        expect.assertions(2);

        const shared = store();
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: model, index: "docs", store: () => shared });
        const rag = docs({});

        await rag.index({ id: "doc", namespace: "org-a", text: "alpha secret document" });
        await rag.index({ id: "doc", namespace: "org-b", text: "beta secret document" });

        const inA = await rag.retrieve("secret", { namespace: "org-a", topK: 5 });
        const inB = await rag.retrieve("secret", { namespace: "org-b", topK: 5 });

        expect(inA.chunks[0]?.text).toContain("alpha");
        expect(inB.chunks[0]?.text).toContain("beta");
    });

    it("applies a metadata filter before ranking, not after", async () => {
        expect.assertions(2);

        const shared = store();
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: model, index: "docs", store: () => shared });
        const rag = docs({});

        // The excluded doc is the better semantic match, so a post-ranking
        // filter would return nothing at topK 1 instead of the permitted doc.
        await rag.index({ id: "private", metadata: { visibility: "private" }, text: "storm cloud thunder rain" });
        await rag.index({ id: "public", metadata: { visibility: "public" }, text: "storm cloud" });

        const result = await rag.retrieve("storm cloud thunder rain", { filter: { visibility: "public" }, topK: 1 });

        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0]?.sourceId).toBe("public");
    });

    it("removes a source's chunks", async () => {
        expect.assertions(2);

        const shared = store();
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: model, index: "docs", store: () => shared });
        const rag = docs({});

        await rag.index({ id: "doc", text: "storm cloud thunder" });

        const before = await rag.retrieve("storm", { topK: 5 });

        expect(before.chunks.length).toBeGreaterThan(0);

        await rag.remove({ id: "doc" });

        const after = await rag.retrieve("storm", { topK: 5 });

        expect(after.chunks).toStrictEqual([]);
    });

    it("re-indexing the same source replaces rather than duplicates", async () => {
        expect.assertions(1);

        const shared = store();
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: model, index: "docs", store: () => shared });
        const rag = docs({});

        await rag.index({ id: "doc", text: "storm cloud" });
        await rag.index({ id: "doc", text: "storm cloud" });

        const result = await rag.retrieve("storm cloud", { topK: 10 });

        expect(result.chunks).toHaveLength(1);
    });

    it("refuses to scan a namespace that has outgrown brute force", async () => {
        expect.assertions(1);

        const shared = store({ maxScan: 2 });
        const docs = defineRag({ allowSharedNamespace: true, chunkOverlap: 0, chunkSize: 6, embeddingModel: model, index: "docs", store: () => shared });
        const rag = docs({});

        await rag.index({ id: "doc", text: "alphaa bravoo charli deltaa" });

        // Linear search: better a named error than a Worker killed on CPU.
        await expect(rag.retrieve("alphaa", { topK: 1 })).rejects.toThrow(/over the 2 limit[\s\S]*brute force and linear/u);
    });

    it("rejects a table name that is not a bare identifier", () => {
        expect.assertions(1);

        const { close, exec } = open();

        databases.push(close);

        // Table names cannot be bound, so this is the one injection surface.
        expect(() => sqliteVectorStore({ exec, table: "vectors; DROP TABLE users--" })).toThrow(/must be a bare SQL identifier/u);
    });

    it("requires an exec function", () => {
        expect.assertions(1);

        // @ts-expect-error -- exercising the runtime guard for JS callers
        expect(() => sqliteVectorStore({})).toThrow(/requires an `exec` function/u);
    });

    it("scopes deletes by namespace so one tenant cannot remove another's chunk", async () => {
        expect.assertions(2);

        const shared = store();
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: model, index: "docs", store: () => shared });
        const rag = docs({});

        await rag.index({ id: "doc", namespace: "org-a", text: "alpha secret" });
        await rag.index({ id: "doc", namespace: "org-b", text: "beta secret" });

        await rag.remove({ id: "doc", namespace: "org-a" });

        const inA = await rag.retrieve("secret", { namespace: "org-a", topK: 5 });
        const inB = await rag.retrieve("secret", { namespace: "org-b", topK: 5 });

        expect(inA.chunks).toStrictEqual([]);
        expect(inB.chunks.length).toBeGreaterThan(0);
    });

    it("keeps two namespaces holding the same chunk id apart", async () => {
        expect.assertions(3);

        const shared = store();

        // Driven directly, not through defineRag (which prefixes ids with the
        // namespace). A bare `id` primary key made the second upsert rewrite
        // the FIRST tenant's row into the second's namespace, losing it.
        await shared.upsert({ embed: () => [1, 0, 0], id: "doc#0", metadata: { orgId: "a" }, input: "alpha", namespace: "org-a" });
        await shared.upsert({ embed: () => [0, 1, 0], id: "doc#0", metadata: { orgId: "b" }, input: "beta", namespace: "org-b" });

        const inA = await shared.getByIds(["doc#0"], "org-a");
        const inB = await shared.getByIds(["doc#0"], "org-b");

        expect(inA).toHaveLength(1);
        expect(inB).toHaveLength(1);
        expect(inA[0]?.metadata).toStrictEqual({ orgId: "a" });
    });

    it("accepts a wide embedding model Vectorize could not hold", async () => {
        expect.assertions(1);

        const shared = store();
        const wide = { modelId: "bag-embed" } as unknown as EmbeddingModel;
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: wide, index: "docs", store: () => shared });

        // maxDimensions is false, so no ceiling check runs at all.
        await expect(docs({}).index({ id: "a", text: "hello world" })).resolves.toMatchObject({ chunks: 1 });
    });
});
