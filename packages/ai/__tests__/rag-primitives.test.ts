import { LunoraError } from "@lunora/errors";
import { describe, expect, it, vi } from "vitest";

import { defineRag, fixedWindowChunks, hybridRank } from "../src/rag";
import { concurrentMap } from "../src/rag/concurrent";
import type { RagContext, RagVectors, RagVectorUpsertInput, RetrievedChunk } from "../src/rag/types";

// The defineRag wiring test embeds through the AI SDK — stub `embed` with a
// constant unit vector so no model is needed; chunk CONTENT is what's asserted.
vi.mock(import("ai"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();

    return {
        ...actual,
        embed: vi.fn(async () => {
            return { embedding: [1, 0] };
        }) as unknown as typeof actual.embed,
    };
});

const chunk = (id: string, overrides: Partial<RetrievedChunk> = {}): RetrievedChunk => {
    return {
        chunkIndex: 0,
        id,
        importance: 1,
        metadata: undefined,
        score: 0,
        sourceId: id.split("#")[0] as string,
        text: `text of ${id}`,
        ...overrides,
    };
};

describe(fixedWindowChunks, () => {
    it("returns the whole trimmed text as one chunk when it fits the window", () => {
        expect(fixedWindowChunks("  hello world  ", 100, 10)).toStrictEqual(["hello world"]);
        // Exactly at the boundary still fits in one window.
        expect(fixedWindowChunks("abcde", 5, 2)).toStrictEqual(["abcde"]);
    });

    it("returns no chunks for empty or whitespace-only text", () => {
        expect(fixedWindowChunks("", 10, 2)).toStrictEqual([]);
        expect(fixedWindowChunks("   \n\t  ", 10, 2)).toStrictEqual([]);
    });

    it("splits into size-char windows stepping by size minus overlap", () => {
        // 10 chars, size 4, overlap 2 → step 2 → windows at 0,2,4,6 (6+4 ≥ 10 stops).
        const chunks = fixedWindowChunks("abcdefghij", 4, 2);

        expect(chunks).toStrictEqual(["abcd", "cdef", "efgh", "ghij"]);
    });

    it("overlaps consecutive windows by exactly `overlap` characters", () => {
        const overlap = 3;
        const chunks = fixedWindowChunks("the quick brown fox jumps over the lazy dog", 10, overlap);

        for (let index = 1; index < chunks.length; index += 1) {
            const previous = chunks[index - 1] as string;
            const current = chunks[index] as string;

            expect(current.startsWith(previous.slice(-overlap))).toBe(true);
        }
    });

    it("stops once a window reaches the end instead of emitting a redundant tail", () => {
        // 7 chars, size 5, overlap 3 → step 2 → windows at 0 ("abcde") and 2
        // ("cdefg", reaches the end) — no degenerate windows at 4/6.
        expect(fixedWindowChunks("abcdefg", 5, 3)).toStrictEqual(["abcde", "cdefg"]);
    });

    it("covers every character of the input across the windows", () => {
        const text = `${"x".repeat(23)}END`;
        const chunks = fixedWindowChunks(text, 7, 2);
        const lastChunk = chunks.at(-1) as string;

        expect(lastChunk.endsWith("END")).toBe(true);
        // Total forward progress: first window + (n-1) steps + final partial reach the end.
        expect(chunks.join("").length).toBeGreaterThanOrEqual(text.length);
    });

    it("rejects invalid size and overlap", () => {
        expect(() => fixedWindowChunks("abc", 0, 0)).toThrow(RangeError);
        expect(() => fixedWindowChunks("abc", 1.5, 0)).toThrow(RangeError);
        expect(() => fixedWindowChunks("abc", 10, -1)).toThrow(RangeError);
        expect(() => fixedWindowChunks("abc", 10, 10)).toThrow(/overlap/u);
        expect(() => fixedWindowChunks("abc", 10, 0.5)).toThrow(RangeError);
    });
});

describe(concurrentMap, () => {
    it("preserves input order even when later items resolve first", async () => {
        const delays = [30, 5, 20, 1];

        const results = await concurrentMap(delays, 4, async (delay, index) => {
            await new Promise((resolve) => {
                setTimeout(resolve, delay);
            });

            return `item-${String(index)}`;
        });

        expect(results).toStrictEqual(["item-0", "item-1", "item-2", "item-3"]);
    });

    it("never exceeds the concurrency limit", async () => {
        let inFlight = 0;
        let peak = 0;

        await concurrentMap(
            Array.from({ length: 12 }, (_, index) => index),
            3,
            async () => {
                inFlight += 1;
                peak = Math.max(peak, inFlight);

                await new Promise((resolve) => {
                    setTimeout(resolve, 5);
                });

                inFlight -= 1;
            },
        );

        expect(peak).toBe(3);
    });

    it("passes each item with its index and handles an empty input", async () => {
        const seen: [string, number][] = [];

        await concurrentMap(["a", "b"], 1, async (item, index) => {
            seen.push([item, index]);
        });

        expect(seen).toStrictEqual([
            ["a", 0],
            ["b", 1],
        ]);
        await expect(concurrentMap([], 4, async () => "unreachable")).resolves.toStrictEqual([]);
    });

    it("rejects on failure but does not cancel other in-flight work", async () => {
        const processed: number[] = [];

        const run = concurrentMap([0, 1, 2, 3], 2, async (item) => {
            if (item === 0) {
                throw new Error("boom");
            }

            await new Promise((resolve) => {
                setTimeout(resolve, 5);
            });

            processed.push(item);
        });

        await expect(run).rejects.toThrow("boom");

        // The surviving workers drain the remaining items — a failed index()
        // leaves a partial-but-convergent vector set, not a torn cancellation.
        await new Promise((resolve) => {
            setTimeout(resolve, 30);
        });

        expect(processed.toSorted((a, b) => a - b)).toStrictEqual([1, 2, 3]);
    });

    it("rejects an invalid limit", async () => {
        await expect(concurrentMap([1], 0, async () => 0)).rejects.toThrow(RangeError);
        await expect(concurrentMap([1], 1.5, async () => 0)).rejects.toThrow(RangeError);
    });
});

describe(hybridRank, () => {
    it("scores each chunk by summed reciprocal ranks across both lists", () => {
        const shared = chunk("doc#0");
        const vectorOnly = chunk("doc#1");
        const textOnly = chunk("doc#2");

        // shared: 1/(60+1) + 1/(60+0) ≈ 0.033 — beats vectorOnly's 1/60 alone.
        const fused = hybridRank([vectorOnly, shared], [shared, textOnly]);

        expect(fused.map((entry) => entry.id)).toStrictEqual(["doc#0", "doc#1", "doc#2"]);
    });

    it("keeps the vector-leg chunk object for ids present in both lists", () => {
        const vectorChunk = chunk("doc#0", { metadata: { title: "rich" }, score: 0.9 });
        const lexicalChunk = chunk("doc#0", { metadata: undefined, score: 3.2 });

        const [winner] = hybridRank([vectorChunk], [lexicalChunk]);

        expect(winner).toBe(vectorChunk);
    });

    it("breaks exact ties in favour of the better vector rank", () => {
        // Both are rank 0 in exactly one list → identical fused scores; the
        // vector-ranked chunk must come first.
        const fromVector = chunk("vec#0");
        const fromText = chunk("lex#0");

        const fused = hybridRank([fromVector], [fromText]);

        expect(fused.map((entry) => entry.id)).toStrictEqual(["vec#0", "lex#0"]);
    });

    it("dampens rank influence via the k constant", () => {
        const first = chunk("a#0");
        const second = chunk("b#0");
        const third = chunk("c#0");

        // Default k=60 flattens ranks: two mid-rank appearances (c: 1/62 + 1/61)
        // beat one top rank (a: 1/60), so consensus wins.
        const flat = hybridRank([first, second, third], [second, third]);

        expect(flat.map((entry) => entry.id)).toStrictEqual(["b#0", "c#0", "a#0"]);

        // A tiny k sharpens ranks: a's vector rank 0 (1/1) now beats c's two
        // mid ranks (1/3 + 1/2) — same lists, different fusion.
        const sharp = hybridRank([first, second, third], [second, third], 1);

        expect(sharp.map((entry) => entry.id)).toStrictEqual(["b#0", "a#0", "c#0"]);
    });

    it("returns an empty list when both legs are empty", () => {
        expect(hybridRank([], [])).toStrictEqual([]);
    });
});

describe("defineRag default chunker wiring", () => {
    const recordingVectors = (): { upserts: RagVectorUpsertInput[]; vectors: RagVectors } => {
        const upserts: RagVectorUpsertInput[] = [];

        const vectors: RagVectors = {
            deleteByIds: async () => undefined,
            getByIds: async () => [],
            query: async () => {
                return { count: 0, matches: [] };
            },
            upsert: async (_indexName, input) => {
                upserts.push(input);
            },
        };

        return { upserts, vectors };
    };

    it("chunks through the configured chunkSize/chunkOverlap window", async () => {
        const { upserts, vectors } = recordingVectors();
        const context: RagContext = { vectors };
        const docs = defineRag({
            allowSharedNamespace: true,
            chunkOverlap: 2,
            chunkSize: 4,
            embeddingModel: { specificationVersion: "v2" } as never,
            index: "docs",
        });

        const result = await docs(context).index({ id: "doc-1", text: "abcdefghij" });

        expect(result.chunks).toBe(4);
        expect(upserts.map((upsert) => upsert.input)).toStrictEqual(["abcd", "cdef", "efgh", "ghij"]);
        expect(upserts.map((upsert) => upsert.metadata?.["__ragText"])).toStrictEqual(["abcd", "cdef", "efgh", "ghij"]);
        expect(upserts.map((upsert) => upsert.id)).toStrictEqual(["doc-1#0", "doc-1#1", "doc-1#2", "doc-1#3"]);
    });

    it("rejects a non-integer chunkSize at config time", () => {
        expect(() => defineRag({ chunkSize: 2.5, index: "docs" })).toThrow(LunoraError);
        expect(() => defineRag({ chunkSize: 0, index: "docs" })).toThrow(/chunkSize/u);
    });

    it("rejects an out-of-range importance at index time", async () => {
        const { vectors } = recordingVectors();
        const context: RagContext = { vectors };
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: { specificationVersion: "v2" } as never, index: "docs" });

        await expect(docs(context).index({ id: "doc-1", importance: 2, text: "hello" })).rejects.toThrow(/importance/u);
        await expect(docs(context).index({ id: "doc-1", importance: -0.1, text: "hello" })).rejects.toThrow(LunoraError);
    });

    it("rejects invalid chunkContext values at retrieve time", async () => {
        const { vectors } = recordingVectors();
        const patched: RagVectors = {
            ...vectors,
            query: async () => {
                return { count: 1, matches: [{ id: "doc-1#0", metadata: { __ragText: "hello" }, score: 0.9 }] };
            },
        };
        const context: RagContext = { vectors: patched };
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: { specificationVersion: "v2" } as never, index: "docs" });

        await expect(docs(context).retrieve("hello", { chunkContext: { after: 0, before: -1 } })).rejects.toThrow(/chunkContext/u);
        await expect(docs(context).retrieve("hello", { chunkContext: { after: 1.5, before: 0 } })).rejects.toThrow(LunoraError);
    });
});
