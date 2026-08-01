import { describe, expect, it } from "vitest";

import type { SchemaLike } from "../../src/vectors/context";
import { createContextVectors, createVectorSyncHook } from "../../src/vectors/context";
import createVectors from "../../src/vectors/create-vectors";
import type {
    VectorizeDeleteMutation,
    VectorizeIndexLike,
    VectorizeMatch,
    VectorizeMatches,
    VectorizeQueryOptions,
    VectorizeUpsertMutation,
    VectorizeVector,
} from "../../src/vectors/types";

/**
 * Stateful structural fake of `VectorizeIndexLike` — mirrors the spirit of
 * `@lunora/runtime`'s `ShardNamespaceLike` mock: an in-memory store with a
 * cosine-similarity scorer that lets us drive a real upsert → query → match
 * flow without any live Cloudflare dependency.
 */
const createStatefulVectorizeIndex = (): VectorizeIndexLike => {
    const store = new Map<string, VectorizeVector>();
    const upsertVectors = async (vectors: ReadonlyArray<VectorizeVector>): Promise<VectorizeUpsertMutation> => {
        for (const vector of vectors) {
            store.set(vector.id, vector);
        }

        return { mutationId: `m_${String(store.size)}` };
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
        deleteByIds: async (ids: ReadonlyArray<string>): Promise<VectorizeDeleteMutation> => {
            let count = 0;

            for (const id of ids) {
                if (store.delete(id)) {
                    count += 1;
                }
            }

            return { count, mutationId: `d_${String(count)}` };
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
                    metadata: options?.returnMetadata === "none" ? undefined : stored.metadata,
                    namespace: stored.namespace,
                    score: cosine(vector, stored.values),
                    values: options?.returnValues ? stored.values : undefined,
                });
            }

            candidates.sort((a, b) => b.score - a.score);

            const matches = candidates.slice(0, options?.topK ?? candidates.length);

            return { count: matches.length, matches };
        },
        upsert: upsertVectors,
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
        expect.assertions(4);

        const index = createStatefulVectorizeIndex();
        const vectors = createVectors({ indexes: { docs: index } });

        await vectors.upsert("docs", { embed, id: "doc-1", input: "hello world", metadata: { kind: "greeting" } });
        await vectors.upsert("docs", { embed, id: "doc-2", input: "bye", metadata: { kind: "farewell" } });
        await vectors.upsert("docs", { embed, id: "doc-3", input: "hello there", metadata: { kind: "greeting" } });

        const result = await vectors.query("docs", { embed, input: "hello", returnMetadata: "all", topK: 2 });

        expect(result.count).toBe(2);
        expect(result.matches.map((match) => match.id)).toEqual(["doc-1", "doc-3"]);
        expect(result.matches[0]?.metadata).toEqual({ kind: "greeting" });
        // Cosine of identical-direction vectors is 1; "hello" matches "hello world"
        // and "hello there" with the same projection, so both score 1.
        expect(result.matches[0]?.score).toBeGreaterThan(0.9);
    });

    it("createVectors: a metadata filter narrows query results to the matching subset", async () => {
        expect.assertions(1);

        const index = createStatefulVectorizeIndex();
        const vectors = createVectors({ indexes: { docs: index } });

        await vectors.upsertMany("docs", [
            { embed, id: "g1", input: "hello", metadata: { kind: "greeting" } },
            { embed, id: "g2", input: "hey", metadata: { kind: "greeting" } },
            { embed, id: "f1", input: "bye", metadata: { kind: "farewell" } },
        ]);

        const result = await vectors.query("docs", { embed, filter: { kind: "farewell" }, input: "hello" });

        expect(result.matches.map((match) => match.id)).toEqual(["f1"]);
    });

    it("createContextVectors: server-shape query returns the upserted matches with mapped fields", async () => {
        expect.assertions(3);

        const index = createStatefulVectorizeIndex();
        const context = createContextVectors(createVectors({ indexes: { docs: index } }));

        await context.upsert("docs", { embed, id: "row-1", input: "hello world", metadata: { title: "Greeting" } });
        await context.upsertNow("docs", { embed, id: "row-2", input: "bye", metadata: { title: "Farewell" } });

        const matches = await context.query("docs", { embed, input: "hello", topK: 1 });

        expect(matches.count).toBe(1);
        expect(matches.matches[0]).toMatchObject({ id: "row-1", metadata: { title: "Greeting" } });
        expect(matches.matches[0]?.score).toBeGreaterThan(0);
    });

    it("createContextVectors: deleteByIds removes a row from subsequent query results", async () => {
        expect.assertions(1);

        const index = createStatefulVectorizeIndex();
        const context = createContextVectors(createVectors({ indexes: { docs: index } }));

        await context.upsert("docs", { embed, id: "row-1", input: "hello" });
        await context.upsert("docs", { embed, id: "row-2", input: "hello there" });

        await context.deleteByIds("docs", ["row-1"]);

        const matches = await context.query("docs", { embed, input: "hello" });

        expect(matches.matches.map((match) => match.id)).toEqual(["row-2"]);
    });

    it("createContextVectors: a precomputed vector skips embed and returns the same ranked list", async () => {
        expect.assertions(1);

        const index = createStatefulVectorizeIndex();
        const context = createContextVectors(createVectors({ indexes: { docs: index } }));

        await context.upsert("docs", { embed, id: "row-1", input: "hello world" });
        await context.upsert("docs", { embed, id: "row-2", input: "bye" });

        const matches = await context.query("docs", { topK: 1, vector: embed("hello") });

        expect(matches.matches[0]?.id).toBe("row-1");
    });
});

describe("createVectorSyncHook: cross-shard namespace isolation (codegen write path)", () => {
    it("scopes each shard's auto-synced upsert to its own namespace so a second shard's query can't see it", async () => {
        expect.assertions(3);

        // One account-global Vectorize index shared by every shard DO — exactly
        // the topology `.vectorize()` + `.shardBy()` produces. `vectors` here is
        // the SAME `VectorSearchLike` the codegen emit hands to
        // `createVectorSyncHook({ namespace, schema, vectors })`.
        const index = createStatefulVectorizeIndex();
        const vectors = createContextVectors(createVectors({ indexes: { docs: index } }));
        const schema: SchemaLike = {
            tables: { docs: { vectorIndexes: [{ embed, field: "body", name: "docs" }] } },
            vectorIndexes: {},
        };

        // Mirrors `emit.ts`'s `buildCtx`: each shard DO builds its OWN onWrite
        // hook, scoped by ITS OWN shard key — never a shared, namespace-less hook.
        const shardAHook = createVectorSyncHook({ namespace: "shard-a", schema, vectors });
        const shardBHook = createVectorSyncHook({ namespace: "shard-b", schema, vectors });

        await shardAHook({ doc: { body: "hello from tenant A" }, id: "row-1", op: "insert", table: "docs" });
        await shardBHook({ doc: { body: "hello from tenant B" }, id: "row-2", op: "insert", table: "docs" });

        const shardAView = await vectors.query("docs", { embed, input: "hello", namespace: "shard-a" });
        const shardBView = await vectors.query("docs", { embed, input: "hello", namespace: "shard-b" });

        // The actual isolation assertion: each shard's namespaced query returns
        // ONLY its own row — the other tenant's vector is invisible, not merely
        // "a namespace was passed" on the write call.
        expect(shardAView.matches.map((match) => match.id)).toEqual(["row-1"]);
        expect(shardBView.matches.map((match) => match.id)).toEqual(["row-2"]);

        // Sanity check on the fake itself: an unnamespaced query (today's
        // `.withVectorIndex()` reader, plan 238) still sees both tenants' rows in
        // the same account-global index — confirming the isolation above comes
        // from the namespace filter, not from the fake accidentally partitioning
        // storage some other way.
        const unscoped = await vectors.query("docs", { embed, input: "hello" });

        expect(unscoped.matches.map((match) => match.id).toSorted((a, b) => a.localeCompare(b))).toEqual(["row-1", "row-2"]);
    });
});
