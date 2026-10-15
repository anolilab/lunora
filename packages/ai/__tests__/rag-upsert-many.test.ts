import { DatabaseSync } from "node:sqlite";

import type { EmbeddingModel } from "ai";
import { describe, expect, it, vi } from "vitest";

import { defineRag } from "../src/rag";
import { sqliteVectorStore } from "../src/rag/sqlite-vector-store";
import type { RagContext, RagVectors, RagVectorUpsertInput } from "../src/rag/types";
import type { RagVectorStore } from "../src/rag/vector-store";

vi.mock(import("ai"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();

    return {
        ...actual,
        embed: vi.fn<() => Promise<{ embedding: number[]; usage: { tokens: number } }>>(async () => {
            return { embedding: [1, 0], usage: { tokens: 1 } };
        }) as unknown as typeof actual.embed,
    };
});

const CHUNKS = 2500;

const pipeChunker = (text: string): ReadonlyArray<string> => text.split("|");

const makeText = (count: number): string => Array.from({ length: count }, (_, index) => `chunk ${String(index)}`).join("|");

const fakeVectors = (withMany: boolean): { manyCalls: number[]; upsertCalls: RagVectorUpsertInput[]; vectors: RagVectors } => {
    const manyCalls: number[] = [];
    const upsertCalls: RagVectorUpsertInput[] = [];

    const vectors: RagVectors = {
        deleteByIds: async () => undefined,
        getByIds: async () => [],
        query: async () => {
            return { count: 0, matches: [] };
        },
        upsert: async (_indexName, input) => {
            upsertCalls.push(input);
        },
        ...(withMany
            ? {
                  upsertMany: async (_indexName: string, inputs: ReadonlyArray<RagVectorUpsertInput>) => {
                      manyCalls.push(inputs.length);
                  },
              }
            : {}),
    };

    return { manyCalls, upsertCalls, vectors };
};

const ctxFor = (vectors: RagVectors): RagContext => {
    return {
        ai: { embeddingModel: () => ({ __embeddingModel: "x" }) as unknown as EmbeddingModel },
        vectors,
    };
};

const fakeVectorStore = (stored: Map<string, RagVectorUpsertInput>): RagVectorStore => {
    return {
        capabilities: { maxDimensions: false, maxIdBytes: false, maxMetadataBytes: false, maxTopK: 100, maxTopKWithMetadata: 100 },
        deleteByIds: async () => undefined,
        getByIds: async (ids) => ids.flatMap((id) => (stored.has(id) ? [{ id, metadata: stored.get(id)?.metadata }] : [])),
        query: async () => {
            return { count: 0, matches: [] };
        },
        upsert: async (record) => {
            stored.set(record.id, record);
        },
    };
};

const rag = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs" });

describe("defineRag index batching", () => {
    it("writes 2,500 chunks in three upsertMany calls and no single upserts", async () => {
        expect.assertions(2);

        const { manyCalls, upsertCalls, vectors } = fakeVectors(true);

        await rag(ctxFor(vectors)).index({ id: "doc", text: makeText(CHUNKS) });

        expect(manyCalls).toStrictEqual([1000, 1000, 499, 1]);
        expect(upsertCalls).toHaveLength(0);
    });

    it("falls back to one upsert per chunk when the store has no upsertMany", async () => {
        expect.assertions(1);

        const { upsertCalls, vectors } = fakeVectors(false);

        await rag(ctxFor(vectors)).index({ id: "doc", text: makeText(CHUNKS) });

        expect(upsertCalls).toHaveLength(CHUNKS);
    });

    it("fires onChunk once per chunk, chunk 0 last", async () => {
        expect.assertions(1);

        const { vectors } = fakeVectors(true);
        const seen: number[] = [];

        await rag(ctxFor(vectors)).index({ id: "doc", onChunk: ({ chunkIndex }) => seen.push(chunkIndex), text: makeText(CHUNKS) });

        expect(seen).toStrictEqual([...Array.from({ length: CHUNKS - 1 }, (_, index) => index + 1), 0]);
    });

    it("rejects an oversized chunk before any write", async () => {
        expect.assertions(2);

        const { manyCalls, vectors } = fakeVectors(true);
        const pieces = Array.from({ length: 10 }, (_, index) => (index === 7 ? "字".repeat(5000) : `chunk ${String(index)}`));
        const big = defineRag({ allowSharedNamespace: true, chunk: () => pieces, index: "docs" });

        await expect(big(ctxFor(vectors)).index({ id: "doc", text: "ignored" })).rejects.toThrow(/per-vector ceiling/u);
        expect(manyCalls).toHaveLength(0);
    });

    it("keeps per-chunk progress on a sqlite store when a later write fails", async () => {
        expect.assertions(3);

        const database = new DatabaseSync(":memory:");
        let inserts = 0;
        const store = sqliteVectorStore({
            exec: (sql, parameters) => {
                if (/^\s*INSERT/iu.test(sql)) {
                    inserts += 1;

                    if (inserts === 3) {
                        throw new Error("disk full");
                    }
                }

                return database.prepare(sql).all(...(parameters as never[]));
            },
        });
        const sqliteRag = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs", store: () => store });
        const seen: number[] = [];

        await expect(
            sqliteRag({ ai: ctxFor(fakeVectors(false).vectors).ai }).index({
                id: "doc",
                onChunk: ({ chunkIndex }) => seen.push(chunkIndex),
                text: makeText(4),
            }),
        ).rejects.toThrow(/disk full/u);

        expect(seen).toHaveLength(2);
        expect(seen).not.toContain(0);

        database.close();
    });

    it("does not report unchanged after a partial index, because chunk 0 is written last", async () => {
        expect.assertions(4);

        const stored = new Map<string, RagVectorUpsertInput>();
        let failing = true;
        const flaky = defineRag({
            allowSharedNamespace: true,
            chunk: pipeChunker,
            index: "docs",
            store: () => {
                return {
                    ...fakeVectorStore(stored),
                    upsert: async (record: RagVectorUpsertInput) => {
                        if (failing && record.id.endsWith("#2")) {
                            throw new Error("write failed");
                        }

                        stored.set(record.id, record);
                    },
                };
            },
        });

        await expect(flaky(ctxFor(fakeVectors(false).vectors)).index({ id: "doc", text: "a|b|c" })).rejects.toThrow(/write failed/u);
        expect(stored.has("doc#0")).toBe(false);

        failing = false;

        const retry = await flaky(ctxFor(fakeVectors(false).vectors)).index({ id: "doc", text: "a|b|c" });

        expect(retry.unchanged).toBe(false);
        expect(stored.has("doc#2")).toBe(true);
    });

    it("leaves chunk 0 unwritten when onChunk throws on chunk 1", async () => {
        expect.assertions(2);

        const stored = new Map<string, RagVectorUpsertInput>();
        const callbackRag = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs", store: () => fakeVectorStore(stored) });

        await expect(
            callbackRag(ctxFor(fakeVectors(false).vectors)).index({
                id: "doc",
                onChunk: ({ chunkIndex }) => {
                    if (chunkIndex === 1) {
                        throw new Error("callback failed");
                    }
                },
                text: "a|b|c",
            }),
        ).rejects.toThrow(/callback failed/u);
        expect(stored.has("doc#0")).toBe(false);
    });

    it("passes one operation token per index() call to every batch and the chunk 0 write", async () => {
        expect.assertions(3);

        const tokens: (object | undefined)[] = [];
        const { vectors } = fakeVectors(true);
        const tracking: RagVectors = {
            ...vectors,
            upsertMany: async (_indexName, _inputs, operation) => {
                tokens.push(operation);
            },
        };

        await rag(ctxFor(tracking)).index({ id: "first", text: makeText(CHUNKS) });

        const first = [...tokens];

        await rag(ctxFor(tracking)).index({ id: "second", text: makeText(3) });

        expect(new Set(first).size).toBe(1);
        expect(first[0]).toBeDefined();
        expect(tokens.at(-1)).not.toBe(first[0]);
    });
});
