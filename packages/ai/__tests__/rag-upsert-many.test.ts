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

    describe("shrinking re-index in a deferred context", () => {
        /** Mirrors the context facade: tokened writes queue, run in order, and a failure skips the rest of that token. */
        const deferredVectors = (failId: string | undefined) => {
            const stored = new Map<string, RagVectorUpsertInput>();
            const events: string[] = [];
            const texts = new Map<string, string>();
            const textRag = defineRag({
                allowSharedNamespace: true,
                chunk: pipeChunker,
                index: "docs",
                textStore: {
                    getMany: async (ids) => ids.map((id) => texts.get(id)),
                    put: async (chunks) => {
                        for (const chunk of chunks) {
                            texts.set(chunk.id, chunk.text);
                        }
                    },
                    remove: async (ids) => {
                        events.push("text-removed");

                        for (const id of ids) {
                            texts.delete(id);
                        }
                    },
                },
            });
            const queue: (() => Promise<void>)[] = [];
            const failed = new WeakSet<object>();
            let inline = true;
            const run = (operation: object | undefined, work: () => Promise<void>): Promise<void> => {
                const guarded = async (): Promise<void> => {
                    if (operation && failed.has(operation)) {
                        throw new Error("skipped");
                    }

                    try {
                        await work();
                    } catch (error) {
                        if (operation) {
                            failed.add(operation);
                        }

                        throw error;
                    }
                };

                if (inline) {
                    return guarded();
                }

                queue.push(guarded);

                return Promise.resolve();
            };
            const vectors: RagVectors = {
                deferredDelete: true,
                deleteByIds: async (_indexName, ids, _namespace, operation, afterDelete) =>
                    run(operation, async () => {
                        for (const id of ids) {
                            stored.delete(id);
                        }

                        events.push("vectors-deleted");
                        await afterDelete?.();
                    }),
                getByIds: async (_indexName, ids) => ids.flatMap((id) => (stored.has(id) ? [{ id, metadata: stored.get(id)?.metadata }] : [])),
                query: async () => {
                    return { count: 0, matches: [] };
                },
                upsert: async (_indexName, input, operation) =>
                    run(operation, async () => {
                        if (!inline && input.id === failId) {
                            throw new Error("write failed");
                        }

                        stored.set(input.id, input);
                    }),
            };
            const flush = async (): Promise<void> => {
                for (const work of queue) {
                    try {
                        // eslint-disable-next-line no-await-in-loop -- ordered replay, like the shard's queue
                        await work();
                    } catch {
                        // contained, as the shard's queue does
                    }
                }
            };

            return {
                defer: () => {
                    inline = false;
                },
                events,
                flush,
                stored,
                textRag,
                texts,
                vectors,
            };
        };

        it("keeps the old trailing chunks, their text and the head when a deferred write fails", async () => {
            expect.assertions(5);

            const { defer, flush, stored, textRag, texts, vectors } = deferredVectors("doc#1");

            await textRag(ctxFor(vectors)).index({ id: "doc", text: "a|b|c|d|e" });
            defer();
            await textRag(ctxFor(vectors)).index({ id: "doc", text: "x|y" });
            await flush();

            expect(["doc#2", "doc#3", "doc#4"].map((id) => texts.get(id))).toStrictEqual(["c", "d", "e"]);

            expect([...stored.keys()].toSorted((left, right) => left.localeCompare(right))).toStrictEqual(["doc#0", "doc#1", "doc#2", "doc#3", "doc#4"]);
            expect(stored.get("doc#0")?.metadata?.["__ragChunks"]).toBe(5);
            expect(stored.get("doc#1")?.input).toBe("b");
            expect(texts.size).toBeGreaterThan(0);
        });

        it("still trims the old trailing chunks and their text, text after vectors, when every deferred write succeeds", async () => {
            expect.assertions(4);

            const { defer, events, flush, stored, textRag, texts, vectors } = deferredVectors(undefined);

            await textRag(ctxFor(vectors)).index({ id: "doc", text: "a|b|c|d|e" });
            defer();
            await textRag(ctxFor(vectors)).index({ id: "doc", text: "x|y" });
            await flush();

            expect(events).toStrictEqual(["vectors-deleted", "text-removed"]);
            expect([...texts.keys()].toSorted((left, right) => left.localeCompare(right))).toStrictEqual(["doc#0", "doc#1"]);

            expect([...stored.keys()].toSorted((left, right) => left.localeCompare(right))).toStrictEqual(["doc#0", "doc#1"]);
            expect(stored.get("doc#0")?.metadata?.["__ragChunks"]).toBe(2);
        });

        it("keeps the inline order, delete then text removal, when no token is given", async () => {
            expect.assertions(2);

            const { events, stored, textRag, texts, vectors } = deferredVectors(undefined);

            await textRag(ctxFor(vectors)).index({ id: "doc", text: "a|b" });
            await textRag(ctxFor(vectors)).remove({ id: "doc" });

            expect(events).toStrictEqual(["vectors-deleted", "text-removed"]);
            expect(stored.size + texts.size).toBe(0);
        });
    });

    it("removes trailing text and lexical entries inline for a store that ignores afterDelete and declares no capability", async () => {
        expect.assertions(3);

        const stored = new Map<string, RagVectorUpsertInput>();
        const texts = new Set<string>();
        const lexical = new Set<string>();
        const legacy: RagVectors = {
            // Built against `deleteByIds(ids, namespace)`: ignores the operation and the hook.
            deleteByIds: async (_indexName, ids) => {
                for (const id of ids) {
                    stored.delete(id);
                }
            },
            getByIds: async (_indexName, ids) => ids.flatMap((id) => (stored.has(id) ? [{ id, metadata: stored.get(id)?.metadata }] : [])),
            query: async () => {
                return { count: 0, matches: [] };
            },
            upsert: async (_indexName, input) => {
                stored.set(input.id, input);
            },
        };
        const legacyRag = defineRag({
            allowSharedNamespace: true,
            chunk: pipeChunker,
            index: "docs",
            lexicalStore: {
                index: async (chunks) => {
                    for (const chunk of chunks) {
                        lexical.add(chunk.id);
                    }
                },
                remove: async (ids) => {
                    for (const id of ids) {
                        lexical.delete(id);
                    }
                },
                search: async () => [],
            },
            textStore: {
                getMany: async (ids) => ids.map(() => undefined),
                put: async (chunks) => {
                    for (const chunk of chunks) {
                        texts.add(chunk.id);
                    }
                },
                remove: async (ids) => {
                    for (const id of ids) {
                        texts.delete(id);
                    }
                },
            },
        });

        await legacyRag(ctxFor(legacy)).index({ id: "doc", text: "a|b|c|d|e" });
        await legacyRag(ctxFor(legacy)).index({ id: "doc", text: "x|y" });

        expect([...stored.keys()]).toHaveLength(2);
        expect([...texts].toSorted((left, right) => left.localeCompare(right))).toStrictEqual(["doc#0", "doc#1"]);
        expect([...lexical].toSorted((left, right) => left.localeCompare(right))).toStrictEqual(["doc#0", "doc#1"]);
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
