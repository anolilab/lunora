import type { EmbeddingModel } from "ai";
import { describe, expect, it, vi } from "vitest";

import defineRag from "../../src/rag/define-rag";
import type { GraphMatch, LexicalMatch, RagGraphStore, RagLexicalStore, RagVectorMatch, RagVectors } from "../../src/rag/types";

/**
 * The graph leg of hybrid retrieval: `RagConfig.graphStore` seeds a relation
 * traversal from the source documents the search legs found and fuses the
 * connected documents' chunks into the same RRF ranking, weighted by depth.
 */

vi.mock(import("ai"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();

    return {
        ...actual,
        embed: (async () => {
            return { embedding: [0.1, 0.2, 0.3], usage: { tokens: 1 } };
        }) as unknown as typeof actual.embed,
    };
});

const model = { modelId: "stub-embed" } as unknown as EmbeddingModel;

/** A vector facade whose `query` answers with fixed matches and whose `getByIds` echoes stored metadata. */
const stubVectors = (matches: ReadonlyArray<RagVectorMatch>, records: Record<string, Record<string, unknown>> = {}): RagVectors => {
    return {
        deleteByIds: () => Promise.resolve(undefined),
        getByIds: (_index, ids) =>
            Promise.resolve(
                ids.map((id) => {
                    return { id, metadata: records[id] };
                }),
            ),
        query: () => Promise.resolve({ count: matches.length, matches }),
        upsert: () => Promise.resolve(undefined),
    };
};

/**
 * A graph store that records its seeds and the filter it was handed, and answers
 * with fixed matches.
 *
 * `enforcesFilter` defaults to `true` so the existing fusion cases still exercise
 * the leg; the isolation cases below pass `false` on purpose.
 */
const stubGraphStore = (
    matches: ReadonlyArray<GraphMatch>,
    enforcesFilter = true,
): { filters: (Record<string, unknown> | undefined)[]; seeds: string[][]; store: RagGraphStore } => {
    const filters: (Record<string, unknown> | undefined)[] = [];
    const seeds: string[][] = [];

    return {
        filters,
        seeds,
        store: {
            enforcesFilter,
            related: (sourceIds, options) => {
                filters.push(options.filter);
                seeds.push([...sourceIds]);

                return Promise.resolve(matches);
            },
        },
    };
};

/** A vector match carrying the chunk text in metadata (the default, no-text-store mode). */
const vectorMatch = (id: string, score: number, text: string): RagVectorMatch => {
    return {
        id,
        metadata: { __ragChunkIndex: 0, __ragSource: id.split("#")[0], __ragText: text },
        score,
    };
};

/** A lexical store that ignores the query and answers with fixed matches. */
const stubLexicalStore = (matches: ReadonlyArray<LexicalMatch>): RagLexicalStore => {
    return {
        index: () => Promise.resolve(undefined),
        search: () => Promise.resolve(matches),
    };
};

/** A vector match whose source carries an `importance` weight below 1. */
const weightedMatch = (id: string, score: number, text: string, importance: number): RagVectorMatch => {
    const match = vectorMatch(id, score, text);

    return { ...match, metadata: { ...match.metadata, __ragImportance: importance } };
};

describe("rag graph leg", () => {
    it("surfaces a connected document the search leg never scored", async () => {
        expect.assertions(2);

        const graph = stubGraphStore([{ id: "ticket-9#0", score: 1, text: "the connected ticket" }]);
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: model, graphStore: graph.store, index: "docs" });
        const rag = docs({ vectors: stubVectors([vectorMatch("customer-1#0", 0.9, "the customer record")]) });

        const result = await rag.retrieve("who is this", { topK: 5 });

        expect(result.chunks.map((entry) => entry.sourceId)).toContain("ticket-9");
        // Seeded from the source documents the vector leg found — the graph has
        // no query of its own.
        expect(graph.seeds).toStrictEqual([["customer-1"]]);
    });

    it("lifts a weakly-ranked search hit that the graph also connects", async () => {
        expect.assertions(1);

        const graph = stubGraphStore([{ id: "b#0", score: 1, text: "b" }]);
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: model, graphStore: graph.store, index: "docs" });
        const rag = docs({
            vectors: stubVectors([vectorMatch("a#0", 0.9, "a"), vectorMatch("b#0", 0.8, "b")]),
        });

        const result = await rag.retrieve("anything", { topK: 5 });

        // `a` outranks `b` on the vector leg alone; `b`'s graph connection is
        // what reverses them.
        expect(result.chunks.map((entry) => entry.id)).toStrictEqual(["b#0", "a#0"]);
    });

    it("recovers importance and caller metadata for a graph-only hit", async () => {
        expect.assertions(2);

        const graph = stubGraphStore([{ id: "ticket-9#0", score: 0.5, text: "the connected ticket" }]);
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: model, graphStore: graph.store, index: "docs" });
        const rag = docs({
            vectors: stubVectors([vectorMatch("customer-1#0", 0.9, "the customer record")], {
                "ticket-9#0": { __ragImportance: 0.25, title: "Invoice" },
            }),
        });

        const result = await rag.retrieve("who is this", { topK: 5 });
        const connected = result.chunks.find((entry) => entry.sourceId === "ticket-9");

        expect(connected?.importance).toBe(0.25);
        expect(connected?.metadata).toStrictEqual({ title: "Invoice" });
    });

    it("does not call the graph store when the search legs found nothing to seed from", async () => {
        expect.assertions(2);

        const graph = stubGraphStore([{ id: "ticket-9#0", score: 1, text: "unreachable" }]);
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: model, graphStore: graph.store, index: "docs" });
        const rag = docs({ vectors: stubVectors([]) });

        const result = await rag.retrieve("nothing matches", { topK: 5 });

        expect(result.chunks).toStrictEqual([]);
        expect(graph.seeds).toStrictEqual([]);
    });

    it("keeps a chunk the vector leg rejected for minScore rejected", async () => {
        expect.assertions(1);

        const graph = stubGraphStore([{ id: "weak#0", score: 1, text: "weak" }]);
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: model, graphStore: graph.store, index: "docs" });
        const rag = docs({
            vectors: stubVectors([vectorMatch("strong#0", 0.9, "strong"), vectorMatch("weak#0", 0.1, "weak")]),
        });

        const result = await rag.retrieve("anything", { minScore: 0.5, topK: 5 });

        // `weak` failed the caller's explicit threshold on the leg that scored
        // it; being graph-adjacent must not re-admit it.
        expect(result.chunks.map((entry) => entry.id)).toStrictEqual(["strong#0"]);
    });
});

/**
 * Filter isolation across the third leg.
 *
 * `retrieve()` narrows the vector and lexical legs to the caller's filter with
 * `rlsFilter` merged over it. The graph leg used to be handed nothing, so a
 * traversal seeded from a document the caller may see could return that
 * document's neighbours from any other tenant — a filter two legs honour and the
 * third ignores is not a filter.
 */
describe("rag graph leg filter isolation", () => {
    it("passes the effective filter (caller filter + rlsFilter) to the graph store", async () => {
        expect.assertions(2);

        const graph = stubGraphStore([{ id: "ticket-9#0", score: 1, text: "the connected ticket" }]);
        const docs = defineRag({
            allowSharedNamespace: true,
            embeddingModel: model,
            graphStore: graph.store,
            index: "docs",
            // RLS keys win over the caller's, exactly as on the other two legs.
            rlsFilter: () => {
                return { orgId: "org-a" };
            },
        });
        const rag = docs({ vectors: stubVectors([vectorMatch("customer-1#0", 0.9, "the customer record")]) });

        const result = await rag.retrieve("who is this", { filter: { status: "open" }, topK: 5 });

        expect(graph.filters).toStrictEqual([{ orgId: "org-a", status: "open" }]);
        expect(result.chunks.map((entry) => entry.sourceId)).toContain("ticket-9");
    });

    it("skips a graph store that does not enforce the filter, rather than trusting it", async () => {
        expect.assertions(2);

        const graph = stubGraphStore([{ id: "other-tenant-doc#0", score: 1, text: "another tenant's row" }], false);
        const docs = defineRag({
            allowSharedNamespace: true,
            embeddingModel: model,
            graphStore: graph.store,
            index: "docs",
            rlsFilter: () => {
                return { orgId: "org-a" };
            },
        });
        const rag = docs({ vectors: stubVectors([vectorMatch("customer-1#0", 0.9, "the customer record")]) });

        const result = await rag.retrieve("who is this", { topK: 5 });

        // Not called at all — the leg is dropped, not called and post-filtered,
        // because this package cannot tell which of its hits were in scope.
        expect(graph.seeds).toStrictEqual([]);
        expect(result.chunks.map((entry) => entry.sourceId)).toStrictEqual(["customer-1"]);
    });

    it("still runs a non-enforcing graph store when nothing is filtered", async () => {
        expect.assertions(2);

        const graph = stubGraphStore([{ id: "ticket-9#0", score: 1, text: "the connected ticket" }], false);
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: model, graphStore: graph.store, index: "docs" });
        const rag = docs({ vectors: stubVectors([vectorMatch("customer-1#0", 0.9, "the customer record")]) });

        const result = await rag.retrieve("who is this", { topK: 5 });

        // No `rlsFilter`, no caller filter: there is nothing to enforce, so the
        // declaration costs the retrieval nothing.
        expect(graph.filters).toStrictEqual([undefined]);
        expect(result.chunks.map((entry) => entry.sourceId)).toContain("ticket-9");
    });

    it("treats an empty rlsFilter as no filter, so the leg is not lost to a no-op", async () => {
        expect.assertions(1);

        const graph = stubGraphStore([{ id: "ticket-9#0", score: 1, text: "the connected ticket" }], false);
        const docs = defineRag({
            allowSharedNamespace: true,
            embeddingModel: model,
            graphStore: graph.store,
            index: "docs",
            // What an admin identity resolves to: scoped by nothing.
            rlsFilter: () => {
                return {};
            },
        });
        const rag = docs({ vectors: stubVectors([vectorMatch("customer-1#0", 0.9, "the customer record")]) });

        await rag.retrieve("who is this", { topK: 5 });

        expect(graph.seeds).toStrictEqual([["customer-1"]]);
    });
});

/**
 * Importance weighting is ONE multiplication, however many legs there are.
 *
 * `retrieve()` used to fold one leg in at a time — vector, then lexical, then
 * graph — and every `hybridRank` call both multiplies `importance` into the
 * score and sorts by it. So each pass after the first derived its ranks from an
 * ordering importance had already weighted, then weighted it again: a source
 * demoted to importance 0.1 lost a further ~5% on every extra pass, with the
 * penalty growing in the number of legs. The legs are collected and fused once
 * now.
 */
describe("rag fusion applies importance once", () => {
    it("scores a demoted source by a single importance multiplication across three legs", async () => {
        expect.assertions(4);

        const graph = stubGraphStore([{ id: "g#0", score: 1, text: "connected" }]);
        const docs = defineRag({
            allowSharedNamespace: true,
            embeddingModel: model,
            graphStore: graph.store,
            index: "docs",
            lexicalStore: stubLexicalStore([{ id: "x#0", score: 5, text: "keyword hit" }]),
        });
        const rag = docs({
            vectors: stubVectors([weightedMatch("light#0", 0.9, "demoted", 0.1), vectorMatch("h1#0", 0.8, "h1"), vectorMatch("h2#0", 0.7, "h2")]),
        });

        const result = await rag.retrieve("anything", { topK: 5 });
        const light = result.chunks.find((entry) => entry.id === "light#0");

        expect(light?.importance).toBe(0.1);
        // Rank 0 of the vector leg and in no other, weighted exactly once:
        // (1/60) * 0.1. Folding the legs in one at a time first demoted it to
        // rank 3 of an already-weighted ordering, scoring (1/63) * 0.1.
        expect(light?.score).toBeCloseTo(0.1 / 60, 10);
        // Full-weight chunks are untouched either way — the drift was specific
        // to the chunks importance had moved.
        expect(result.chunks.find((entry) => entry.id === "h1#0")?.score).toBeCloseTo(1 / 61, 10);
        // All three legs still reach the ranking.
        expect(result.chunks.map((entry) => entry.id).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["g#0", "h1#0", "h2#0", "light#0", "x#0"]);
    });

    it("seeds the graph leg from the search legs' sources, not from a fused list", async () => {
        expect.assertions(1);

        const graph = stubGraphStore([{ id: "g#0", score: 1, text: "connected" }]);
        const docs = defineRag({
            allowSharedNamespace: true,
            embeddingModel: model,
            graphStore: graph.store,
            index: "docs",
            lexicalStore: stubLexicalStore([{ id: "x#0", score: 5, text: "keyword hit" }]),
        });
        const rag = docs({ vectors: stubVectors([vectorMatch("a#0", 0.9, "a")]) });

        await rag.retrieve("anything", { topK: 5 });

        // The union of the vector and lexical legs — the same set the fused list
        // carried, which is why the fusion can move behind the graph leg.
        expect(graph.seeds.map((seed) => seed.toSorted((a, b) => a.localeCompare(b)))).toStrictEqual([["a", "x"]]);
    });
});
