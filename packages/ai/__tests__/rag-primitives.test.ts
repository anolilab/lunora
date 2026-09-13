import { LunoraError } from "@lunora/errors";
import { describe, expect, it, vi } from "vitest";

import { defineRag, fixedWindowChunks, hybridRank } from "../src/rag";
import { concurrentForEach, concurrentMap } from "../src/rag/concurrent";
import type { RagContext, RagVectors, RagVectorUpsertInput, RetrievedChunk } from "../src/rag/types";

// The defineRag wiring test embeds through the AI SDK — stub `embed` with a
// constant unit vector so no model is needed; chunk CONTENT is what's asserted.
vi.mock(import("ai"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();

    return {
        ...actual,
        embed: vi.fn<() => Promise<{ embedding: number[] }>>(async () => {
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
        expect.assertions(2);
        expect(fixedWindowChunks("  hello world  ", 100, 10)).toStrictEqual(["hello world"]);
        // Exactly at the boundary still fits in one window.
        expect(fixedWindowChunks("abcde", 5, 2)).toStrictEqual(["abcde"]);
    });

    it("returns no chunks for empty or whitespace-only text", () => {
        expect.assertions(2);
        expect(fixedWindowChunks("", 10, 2)).toStrictEqual([]);
        expect(fixedWindowChunks("   \n\t  ", 10, 2)).toStrictEqual([]);
    });

    it("splits into size-char windows stepping by size minus overlap", () => {
        expect.assertions(1);

        // 10 chars, size 4, overlap 2 → step 2 → windows at 0,2,4,6 (6+4 ≥ 10 stops).
        const chunks = fixedWindowChunks("abcdefghij", 4, 2);

        expect(chunks).toStrictEqual(["abcd", "cdef", "efgh", "ghij"]);
    });

    it("overlaps consecutive windows by exactly `overlap` characters", () => {
        expect.hasAssertions();

        const overlap = 3;
        const chunks = fixedWindowChunks("the quick brown fox jumps over the lazy dog", 10, overlap);

        for (let index = 1; index < chunks.length; index += 1) {
            const previous = chunks[index - 1] as string;
            const current = chunks[index] as string;

            expect(current.startsWith(previous.slice(-overlap))).toBe(true);
        }
    });

    it("stops once a window reaches the end instead of emitting a redundant tail", () => {
        expect.assertions(1);
        // 7 chars, size 5, overlap 3 → step 2 → windows at 0 ("abcde") and 2
        // ("cdefg", reaches the end) — no degenerate windows at 4/6.
        expect(fixedWindowChunks("abcdefg", 5, 3)).toStrictEqual(["abcde", "cdefg"]);
    });

    it("covers every character of the input across the windows", () => {
        expect.assertions(2);

        const text = `${"x".repeat(23)}END`;
        const chunks = fixedWindowChunks(text, 7, 2);
        const lastChunk = chunks.at(-1) as string;

        expect(lastChunk.endsWith("END")).toBe(true);
        // Total forward progress: first window + (n-1) steps + final partial reach the end.
        expect(chunks.join("").length).toBeGreaterThanOrEqual(text.length);
    });

    it("rejects invalid size and overlap", () => {
        expect.assertions(5);
        expect(() => fixedWindowChunks("abc", 0, 0)).toThrow(RangeError);
        expect(() => fixedWindowChunks("abc", 1.5, 0)).toThrow(RangeError);
        expect(() => fixedWindowChunks("abc", 10, -1)).toThrow(RangeError);
        expect(() => fixedWindowChunks("abc", 10, 10)).toThrow(/overlap/u);
        expect(() => fixedWindowChunks("abc", 10, 0.5)).toThrow(RangeError);
    });
});

describe(concurrentMap, () => {
    it("preserves input order even when later items resolve first", async () => {
        expect.assertions(1);

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
        expect.assertions(1);

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
        expect.assertions(2);

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

    it("stops pulling new items after the first rejection, but lets in-flight calls settle", async () => {
        expect.assertions(3);

        const started: number[] = [];
        const processed: number[] = [];

        const run = concurrentMap([0, 1, 2, 3, 4, 5], 2, async (item) => {
            started.push(item);

            if (item === 0) {
                throw new Error("boom");
            }

            await new Promise((resolve) => {
                setTimeout(resolve, 5);
            });

            processed.push(item);
        });

        await expect(run).rejects.toThrow("boom");

        // Item 1 was already in flight (claimed alongside item 0, the two
        // workers' first pulls) when item 0 rejected, so it's allowed to
        // settle — quiescing in-flight work, not cancelling it. Items 2-5 must
        // never start: unlike `@lunora/bindings/vectors`' reference this used
        // to keep pulling and burning embedder + Vectorize calls for every
        // remaining chunk after the caller's `catch` ran.
        expect(started.toSorted((a, b) => a - b)).toStrictEqual([0, 1]);
        expect(processed).toStrictEqual([1]);
    });

    it("rejects an invalid limit", async () => {
        expect.assertions(2);
        await expect(concurrentMap([1], 0, async () => 0)).rejects.toThrow(RangeError);
        await expect(concurrentMap([1], 1.5, async () => 0)).rejects.toThrow(RangeError);
    });
});

describe(concurrentForEach, () => {
    it("never exceeds the concurrency limit", async () => {
        expect.assertions(1);

        let inFlight = 0;
        let peak = 0;

        await concurrentForEach(
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

    it("pulls from a generator only as capacity frees", async () => {
        expect.assertions(2);

        const seen: number[] = [];
        let pulled = 0;
        let widestGap = 0;

        const listing = function* (): Generator<number> {
            for (let index = 0; index < 10; index += 1) {
                pulled += 1;
                widestGap = Math.max(widestGap, pulled - seen.length);

                yield index;
            }
        };

        await concurrentForEach(listing(), 2, async (item) => {
            await Promise.resolve();

            seen.push(item);
        });

        // Draining the iterable up front would open the gap to all 10 — the
        // whole point is that a large source is never materialised.
        expect(widestGap).toBeLessThanOrEqual(2);
        expect(seen).toHaveLength(10);
    });

    it("serializes next() so overlapping pulls never reach the iterator", async () => {
        expect.assertions(1);

        let inNext = 0;
        let overlapped = false;

        // A generator throws "already running" on a re-entrant `next()`, but
        // only for a SYNCHRONOUS overlap. This records any overlap at all,
        // which is what 8 workers pulling as they free up would produce.
        const listing = {
            [Symbol.asyncIterator]: (): AsyncIterator<number> => {
                let index = 0;

                return {
                    next: async (): Promise<IteratorResult<number>> => {
                        inNext += 1;
                        overlapped ||= inNext > 1;

                        await new Promise((resolve) => {
                            setTimeout(resolve, 1);
                        });

                        inNext -= 1;
                        index += 1;

                        return index > 12 ? { done: true, value: undefined } : { done: false, value: index };
                    },
                };
            },
        };

        await concurrentForEach(listing, 8, async () => {
            await Promise.resolve();
        });

        expect(overlapped).toBe(false);
    });

    it("stops pulling new items after the first rejection, but lets in-flight calls settle", async () => {
        expect.assertions(4);

        const started: number[] = [];
        const processed: number[] = [];
        let closed = false;

        const listing = async function* (): AsyncGenerator<number> {
            try {
                for (let index = 0; index < 6; index += 1) {
                    yield index;
                }
            } finally {
                closed = true;
            }
        };

        const run = concurrentForEach(listing(), 2, async (item) => {
            started.push(item);

            if (item === 0) {
                // Fail only once the sibling worker has pulled and started item
                // 1, so this asserts that in-flight work is quiesced rather
                // than which pull happened to win the race.
                await new Promise((resolve) => {
                    setTimeout(resolve, 1);
                });

                throw new Error("boom");
            }

            await new Promise((resolve) => {
                setTimeout(resolve, 10);
            });

            processed.push(item);
        });

        await expect(run).rejects.toThrow("boom");

        // Same contract as `concurrentMap`: item 1 was already in flight when
        // item 0 rejected, so it settles rather than being cancelled, and
        // nothing after them starts. `return()` on the way out is what lets a
        // generator source run its `finally` and release what it holds.
        expect(started.toSorted((a, b) => a - b)).toStrictEqual([0, 1]);
        expect(processed).toStrictEqual([1]);
        expect(closed).toBe(true);
    });

    it("rejects an invalid limit", async () => {
        expect.assertions(2);
        await expect(concurrentForEach([1], 0, async () => {})).rejects.toThrow(RangeError);
        await expect(concurrentForEach([1], 1.5, async () => {})).rejects.toThrow(RangeError);
    });
});

describe(hybridRank, () => {
    it("scores each chunk by summed reciprocal ranks across both lists", () => {
        expect.assertions(1);

        const shared = chunk("doc#0");
        const vectorOnly = chunk("doc#1");
        const textOnly = chunk("doc#2");

        // shared: 1/(60+1) + 1/(60+0) ≈ 0.033 — beats vectorOnly's 1/60 alone.
        const fused = hybridRank([{ chunks: [vectorOnly, shared] }, { chunks: [shared, textOnly] }]);

        expect(fused.map((entry) => entry.id)).toStrictEqual(["doc#0", "doc#1", "doc#2"]);
    });

    it("keeps the vector-leg chunk's payload for ids present in both lists", () => {
        expect.assertions(2);

        const vectorChunk = chunk("doc#0", { metadata: { title: "rich" }, score: 0.9 });
        const lexicalChunk = chunk("doc#0", { metadata: undefined, score: 3.2 });

        const [winner] = hybridRank([{ chunks: [vectorChunk] }, { chunks: [lexicalChunk] }]);

        // The richer vector-leg chunk survives — the lexical leg carries no
        // stored metadata. Asserted on the payload, not by reference: the
        // returned chunk is a copy carrying the fused score (see below).
        expect(winner?.metadata).toStrictEqual({ title: "rich" });
        expect(winner?.text).toBe(vectorChunk.text);
    });

    it("writes the fused score back so a caller re-sorting by score keeps the fusion", () => {
        expect.assertions(3);

        // The regression this guards: hybridRank used to return chunks still
        // carrying their raw cosine / BM25 scores. `retrieve()` re-sorts by
        // `score` to apply importance weighting, so the fusion was computed and
        // then immediately discarded — and since BM25 is unbounded while cosine
        // is [0, 1], every lexical-only hit was promoted above every vector hit.
        const vectorChunk = chunk("doc#0", { score: 0.9 });
        const lexicalOnly = chunk("doc#1", { score: 3.2 });

        const fused = hybridRank([{ chunks: [vectorChunk] }, { chunks: [lexicalOnly] }]);

        // Both appear once in each leg at rank 0, so both fuse to 1/60.
        for (const entry of fused) {
            expect(entry.score).toBeCloseTo(1 / 60, 10);
        }

        // Re-sorting by score, as retrieve() does, preserves the fused order.
        expect(fused.toSorted((a, b) => b.score - a.score).map((entry) => entry.id)).toStrictEqual(fused.map((entry) => entry.id));
    });

    it("multiplies importance into the fused score", () => {
        expect.assertions(1);

        const heavy = chunk("doc#0", { importance: 1, score: 0.5 });
        const light = chunk("doc#1", { importance: 0.1, score: 0.9 });

        // `light` ranks first in the vector leg, so on rank alone it would win.
        // Its 0.1 importance has to pull it under `heavy`.
        const fused = hybridRank([{ chunks: [light, heavy] }]);

        expect(fused.map((entry) => entry.id)).toStrictEqual(["doc#0", "doc#1"]);
    });

    /**
     * The reason `retrieve()` collects its legs and calls this once.
     *
     * Each call multiplies `importance` into the score it returns AND sorts by
     * that score, so a fused list handed back in as a leg carries an ordering
     * importance already weighted — and the next pass derives its ranks from it
     * and multiplies by importance a second time.
     */
    it("applies importance once per call, so re-fusing a fused list weights it twice", () => {
        expect.assertions(3);

        const light = chunk("light#0", { importance: 0.1 });
        const heavy1 = chunk("h1#0");
        const heavy2 = chunk("h2#0");

        const once = hybridRank([{ chunks: [light, heavy1, heavy2] }]);

        // Rank 0 in the only leg, weighted once: (1/60) * 0.1.
        expect(once.find((entry) => entry.id === "light#0")?.score).toBeCloseTo(0.1 / 60, 10);
        // …and that weighting pushed it to LAST place.
        expect(once.map((entry) => entry.id)).toStrictEqual(["h1#0", "h2#0", "light#0"]);

        // Feed the fused list back in, as a fold-one-leg-at-a-time caller does:
        // rank 2 now, and importance multiplies in again — (1/62) * 0.1.
        const twice = hybridRank([{ chunks: once }]);

        expect(twice.find((entry) => entry.id === "light#0")?.score).toBeCloseTo(0.1 / 62, 10);
    });

    it("breaks exact ties in favour of the better vector rank", () => {
        expect.assertions(1);

        // Both are rank 0 in exactly one list → identical fused scores; the
        // vector-ranked chunk must come first.
        const fromVector = chunk("vec#0");
        const fromText = chunk("lex#0");

        const fused = hybridRank([{ chunks: [fromVector] }, { chunks: [fromText] }]);

        expect(fused.map((entry) => entry.id)).toStrictEqual(["vec#0", "lex#0"]);
    });

    it("dampens rank influence via the k constant", () => {
        expect.assertions(2);

        const first = chunk("a#0");
        const second = chunk("b#0");
        const third = chunk("c#0");

        // Default k=60 flattens ranks: two mid-rank appearances (c: 1/62 + 1/61)
        // beat one top rank (a: 1/60), so consensus wins.
        const flat = hybridRank([{ chunks: [first, second, third] }, { chunks: [second, third] }]);

        expect(flat.map((entry) => entry.id)).toStrictEqual(["b#0", "c#0", "a#0"]);

        // A tiny k sharpens ranks: a's vector rank 0 (1/1) now beats c's two
        // mid ranks (1/3 + 1/2) — same lists, different fusion.
        const sharp = hybridRank([{ chunks: [first, second, third] }, { chunks: [second, third] }], { k: 1 });

        expect(sharp.map((entry) => entry.id)).toStrictEqual(["b#0", "a#0", "c#0"]);
    });

    it("returns an empty list when there are no legs, or every leg is empty", () => {
        expect.assertions(2);
        expect(hybridRank([])).toStrictEqual([]);
        expect(hybridRank([{ chunks: [] }, { chunks: [] }])).toStrictEqual([]);
    });

    it("fuses a proximity-weighted leg as a third signal", () => {
        expect.assertions(1);

        const vectorOnly = chunk("a#0");
        const shared = chunk("b#0");

        // `shared` is rank 1 in the vector leg (1/61) and rank 0 in the graph
        // leg at full proximity (1/60), so the graph connection lifts it over a
        // chunk the vector leg ranked first.
        const fused = hybridRank([{ chunks: [vectorOnly, shared] }, { chunks: [chunk("b#0", { score: 1 })], weight: "proximity" }]);

        expect(fused.map((entry) => entry.id)).toStrictEqual(["b#0", "a#0"]);
    });

    it("scales the graph leg's contribution by each hit's depth decay", () => {
        expect.assertions(2);

        const near = hybridRank([{ chunks: [chunk("a#0", { score: 1 })], weight: "proximity" }]);
        const far = hybridRank([{ chunks: [chunk("a#0", { score: 0.25 })], weight: "proximity" }]);

        // Same rank in the same leg — only the depth decay differs, and a
        // rank-only fusion would score the two identically.
        expect(near[0]?.score).toBeCloseTo(1 / 60, 10);
        expect(far[0]?.score).toBeCloseTo(0.25 / 60, 10);
    });

    it("orders a graph-only ranking by depth, nearest first", () => {
        expect.assertions(1);

        const fused = hybridRank([{ chunks: [chunk("a#0", { score: 1 }), chunk("b#0", { score: 0.5 }), chunk("c#0", { score: 0.25 })], weight: "proximity" }]);

        expect(fused.map((entry) => entry.id)).toStrictEqual(["a#0", "b#0", "c#0"]);
    });

    it("clamps a graph score outside [0, 1] so a leg cannot out-weigh the search legs", () => {
        expect.assertions(2);

        const huge = hybridRank([{ chunks: [chunk("a#0", { score: 1000 })], weight: "proximity" }]);
        const negative = hybridRank([{ chunks: [chunk("a#0", { score: -5 })], weight: "proximity" }]);

        expect(huge[0]?.score).toBeCloseTo(1 / 60, 10);
        expect(negative[0]?.score).toBe(0);
    });

    it("adds the graph contribution to a chunk the search legs already found", () => {
        expect.assertions(1);

        const [entry] = hybridRank([{ chunks: [chunk("a#0")] }, { chunks: [chunk("a#0")] }, { chunks: [chunk("a#0", { score: 1 })], weight: "proximity" }]);

        // Rank 0 in all three legs: 1/60 + 1/60 + 1/60.
        expect(entry?.score).toBeCloseTo(3 / 60, 10);
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
        expect.assertions(4);

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
        expect.assertions(2);
        expect(() => defineRag({ chunkSize: 2.5, index: "docs" })).toThrow(LunoraError);
        expect(() => defineRag({ chunkSize: 0, index: "docs" })).toThrow(/chunkSize/u);
    });

    it("rejects an out-of-range importance at index time", async () => {
        expect.assertions(2);

        const { vectors } = recordingVectors();
        const context: RagContext = { vectors };
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: { specificationVersion: "v2" } as never, index: "docs" });

        await expect(docs(context).index({ id: "doc-1", importance: 2, text: "hello" })).rejects.toThrow(/importance/u);
        await expect(docs(context).index({ id: "doc-1", importance: -0.1, text: "hello" })).rejects.toThrow(LunoraError);
    });

    it("rejects invalid chunkContext values at retrieve time", async () => {
        expect.assertions(2);

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
