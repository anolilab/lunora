import { DatabaseSync } from "node:sqlite";

import type { EmbeddingModel } from "ai";
import { describe, expect, it, vi } from "vitest";

import { defineRag } from "../src/rag";
import { sqliteVectorStore } from "../src/rag/sqlite-vector-store";
import type { RagContext, RagVectors, RagVectorUpsertInput } from "../src/rag/types";

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

const rag = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs" });

describe("defineRag index batching", () => {
    it("writes 2,500 chunks in three upsertMany calls and no single upserts", async () => {
        expect.assertions(2);

        const { manyCalls, upsertCalls, vectors } = fakeVectors(true);

        await rag(ctxFor(vectors)).index({ id: "doc", text: makeText(CHUNKS) });

        expect(manyCalls).toStrictEqual([1000, 1000, 500]);
        expect(upsertCalls).toHaveLength(0);
    });

    it("falls back to one upsert per chunk when the store has no upsertMany", async () => {
        expect.assertions(1);

        const { upsertCalls, vectors } = fakeVectors(false);

        await rag(ctxFor(vectors)).index({ id: "doc", text: makeText(CHUNKS) });

        expect(upsertCalls).toHaveLength(CHUNKS);
    });

    it("fires onChunk once per chunk in index order", async () => {
        expect.assertions(1);

        const { vectors } = fakeVectors(true);
        const seen: number[] = [];

        await rag(ctxFor(vectors)).index({ id: "doc", onChunk: ({ chunkIndex }) => seen.push(chunkIndex), text: makeText(CHUNKS) });

        expect(seen).toStrictEqual(Array.from({ length: CHUNKS }, (_, index) => index));
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
        expect.assertions(2);

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

        expect(seen).toStrictEqual(expect.arrayContaining([0, 1]));

        database.close();
    });
});
