import { describe, expect, it } from "vitest";

import { createVectors } from "../src/create-vectors.js";
import { createCtxVectors } from "../src/ctx.js";
import type {
    VectorizeDeleteMutation,
    VectorizeIndexLike,
    VectorizeMatch,
    VectorizeMatches,
    VectorizeQueryOptions,
    VectorizeUpsertMutation,
    VectorizeVector,
} from "../src/types.js";

/**
 * Stateful structural fake of `VectorizeIndexLike` — mirrors the spirit of
 * `@cirrus/runtime`'s `ShardNamespaceLike` mock: an in-memory store with a
 * cosine-similarity scorer that lets us drive a real upsert → query → match
 * flow without any live Cloudflare dependency.
 */
const createStatefulVectorizeIndex = (): VectorizeIndexLike => {
    const store = new Map<string, VectorizeVector>();
    const upsertVectors = async (vectors: ReadonlyArray<VectorizeVector>): Promise<VectorizeUpsertMutation> => {
        for (const vector of vectors) {
            store.set(vector.id, vector);
        }

        return { mutationId: `m_${store.size}` };
    };

    const dot = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
        let sum = 0;

        for (const [index, value] of a.entries()) {
            sum += value * (b[index] ?? 0);
        }

        return sum;
    };

    const norm = (a: ReadonlyArray<number>): number => Math.sqrt(dot(a, a));
    const cosine = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
        const denominator = norm(a) * norm(b);

        return denominator === 0 ? 0 : dot(a, b) / denominator;
    };

    return {
        upsert: upsertVectors,
        insert: upsertVectors,
        query: async (vector: ReadonlyArray<number>, options?: VectorizeQueryOptions): Promise<VectorizeMatches> => {
            const candidates: VectorizeMatch[] = [];

            for (const stored of store.values()) {
                if (options?.namespace !== undefined && stored.namespace !== options.namespace) {
                    continue;
                }

                if (options?.filter) {
                    const metadata = stored.metadata ?? {};
                    const accepted = Object.entries(options.filter).every(([key, expected]) => metadata[key] === expected);

                    if (!accepted) {
                        continue;
                    }
                }

                candidates.push({
                    id: stored.id,
                    score: cosine(vector, stored.values),
                    values: options?.returnValues ? stored.values : undefined,
                    metadata: options?.returnMetadata === "none" ? undefined : stored.metadata,
                    namespace: stored.namespace,
                });
            }

            candidates.sort((a, b) => b.score - a.score);

            const matches = candidates.slice(0, options?.topK ?? candidates.length);

            return { matches, count: matches.length };
        },
        getByIds: async (ids: ReadonlyArray<string>): Promise<ReadonlyArray<VectorizeVector>> => {
            const found: VectorizeVector[] = [];

            for (const id of ids) {
                const vector = store.get(id);

                if (vector) {
                    found.push(vector);
                }
            }

            return found;
        },
        deleteByIds: async (ids: ReadonlyArray<string>): Promise<VectorizeDeleteMutation> => {
            let count = 0;

            for (const id of ids) {
                if (store.delete(id)) {
                    count += 1;
                }
            }

            return { mutationId: `d_${count}`, count };
        },
    };
};

// Tiny BYOE — collapses the input string to a 3-D vector keyed off character
// counts. Enough signal for cosine similarity to rank "hello world" closer to
// "hello" than to "bye".
const embed = (input: string): ReadonlyArray<number> => {
    const lower = input.toLowerCase();
    const counts: [number, number, number] = [0, 0, 0];

    for (const character of lower) {
        switch (character) {
            case "e": {
                counts[1] += 1;
                break;
            }
            case "h": {
                counts[0] += 1;
                break;
            }
            case "l": {
                counts[2] += 1;
                break;
            }
            default: {
                break;
            }
        }
    }

    // Floor at 1 so two strings with no overlap still produce a non-zero norm
    // (avoids divide-by-zero in cosine and keeps the test deterministic).
    return [counts[0] + 1, counts[1] + 1, counts[2] + 1];
};

describe("upsert -> query end-to-end against a structural Vectorize fake", () => {
    it("createVectors: an upsert is visible to a subsequent query with metadata + topK", async () => {
        const index = createStatefulVectorizeIndex();
        const vectors = createVectors({ indexes: { docs: index } });

        await vectors.upsert("docs", { id: "doc-1", input: "hello world", embed, metadata: { kind: "greeting" } });
        await vectors.upsert("docs", { id: "doc-2", input: "bye", embed, metadata: { kind: "farewell" } });
        await vectors.upsert("docs", { id: "doc-3", input: "hello there", embed, metadata: { kind: "greeting" } });

        const result = await vectors.query("docs", { input: "hello", embed, topK: 2, returnMetadata: "all" });

        expect(result.count).toBe(2);
        expect(result.matches.map((match) => match.id)).toEqual(["doc-1", "doc-3"]);
        expect(result.matches[0]?.metadata).toEqual({ kind: "greeting" });
        // Cosine of identical-direction vectors is 1; "hello" matches "hello world"
        // and "hello there" with the same projection, so both score 1.
        expect(result.matches[0]?.score).toBeGreaterThan(0.9);
    });

    it("createVectors: a metadata filter narrows query results to the matching subset", async () => {
        const index = createStatefulVectorizeIndex();
        const vectors = createVectors({ indexes: { docs: index } });

        await vectors.upsertMany("docs", [
            { id: "g1", input: "hello", embed, metadata: { kind: "greeting" } },
            { id: "g2", input: "hey", embed, metadata: { kind: "greeting" } },
            { id: "f1", input: "bye", embed, metadata: { kind: "farewell" } },
        ]);

        const result = await vectors.query("docs", { input: "hello", embed, filter: { kind: "farewell" } });

        expect(result.matches.map((match) => match.id)).toEqual(["f1"]);
    });

    it("createCtxVectors: server-shape query returns the upserted matches with mapped fields", async () => {
        const index = createStatefulVectorizeIndex();
        const ctx = createCtxVectors(createVectors({ indexes: { docs: index } }));

        await ctx.upsert("docs", { id: "row-1", input: "hello world", embed, metadata: { title: "Greeting" } });
        await ctx.upsertNow("docs", { id: "row-2", input: "bye", embed, metadata: { title: "Farewell" } });

        const matches = await ctx.query("docs", { input: "hello", embed, topK: 1 });

        expect(matches.count).toBe(1);
        expect(matches.matches[0]).toMatchObject({ id: "row-1", metadata: { title: "Greeting" } });
        expect(matches.matches[0]?.score).toBeGreaterThan(0);
    });

    it("createCtxVectors: deleteByIds removes a row from subsequent query results", async () => {
        const index = createStatefulVectorizeIndex();
        const ctx = createCtxVectors(createVectors({ indexes: { docs: index } }));

        await ctx.upsert("docs", { id: "row-1", input: "hello", embed });
        await ctx.upsert("docs", { id: "row-2", input: "hello there", embed });

        await ctx.deleteByIds("docs", ["row-1"]);

        const matches = await ctx.query("docs", { input: "hello", embed });

        expect(matches.matches.map((match) => match.id)).toEqual(["row-2"]);
    });

    it("createCtxVectors: a precomputed vector skips embed and returns the same ranked list", async () => {
        const index = createStatefulVectorizeIndex();
        const ctx = createCtxVectors(createVectors({ indexes: { docs: index } }));

        await ctx.upsert("docs", { id: "row-1", input: "hello world", embed });
        await ctx.upsert("docs", { id: "row-2", input: "bye", embed });

        const matches = await ctx.query("docs", { vector: embed("hello"), topK: 1 });

        expect(matches.matches[0]?.id).toBe("row-1");
    });
});
