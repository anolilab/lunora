import { describe, expect, it } from "vitest";

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
 * SPIKE (plan 238) — test-only prototype of a `.withVectorIndex()` reader.
 *
 * NOT wired into any package's public API, codegen, or the emitted facade —
 * see `plans/238-vector-reader-design.md` for the design this prototypes and
 * the open questions it stops short of (async-index consistency is documented
 * there, not exercised here since the fake index is synchronous; the write-side
 * namespace-wiring gap in `packages/codegen/src/emit.ts` is reported there and
 * is out of scope for this file to fix).
 *
 * Runs over the REAL `createVectors` binding (`../../src/vectors/create-vectors`)
 * — the same code path `@lunora/ai/rag` runs behind `createContextVectors` — so
 * this exercises real namespace filtering, real topK slicing, and a real
 * upsert -> query round trip. Only the underlying `VectorizeIndexLike` is a
 * structural fake (a fresh copy of the fixture already established in
 * `end-to-end.test.ts`, kept local rather than imported so this spike file has
 * no cross-test-file coupling).
 */

// ---------------------------------------------------------------------------
// Real-shaped Vectorize fake (namespace-scoped storage + cosine scoring) —
// mirrors `end-to-end.test.ts`'s `createStatefulVectorizeIndex`.
// ---------------------------------------------------------------------------

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
        // Real Vectorize semantics being faked here on purpose (this is the
        // production `.query()` contract, not a simplification): `namespace` is
        // a hard filter over the account-global store — a query scoped to
        // namespace "tenant-a" can NEVER see a vector upserted under
        // "tenant-b", no matter how similar the embeddings are.
        query: async (vector: ReadonlyArray<number>, options?: VectorizeQueryOptions): Promise<VectorizeMatches> => {
            const candidates: VectorizeMatch[] = [];

            for (const stored of store.values()) {
                if (options?.namespace !== undefined && stored.namespace !== options.namespace) {
                    continue;
                }

                candidates.push({
                    id: stored.id,
                    metadata: options?.returnMetadata === "none" ? undefined : stored.metadata,
                    namespace: stored.namespace,
                    score: cosine(vector, stored.values),
                });
            }

            candidates.sort((a, b) => b.score - a.score);

            const matches = candidates.slice(0, options?.topK ?? candidates.length);

            return { count: matches.length, matches };
        },
        upsert: upsertVectors,
    };
};

// Character-count BYOE, same trick as the existing fixture: cheap, deterministic,
// enough signal for cosine similarity to separate near-duplicate wording from
// unrelated text.
const embed = (input: string): ReadonlyArray<number> => {
    const lower = input.toLowerCase();
    const counts: [number, number, number, number] = [0, 0, 0, 0];

    for (const character of lower) {
        switch (character) {
            case "a": {
                counts[0] += 1;
                break;
            }
            case "i": {
                counts[1] += 1;
                break;
            }
            case "o": {
                counts[2] += 1;
                break;
            }
            case "r": {
                counts[3] += 1;
                break;
            }
            default: {
                break;
            }
        }
    }

    return [counts[0] + 1, counts[1] + 1, counts[2] + 1, counts[3] + 1];
};

// ---------------------------------------------------------------------------
// Stage 2 of the design's read pipeline: a policy-aware document store fake.
// Structurally mirrors an RLS-scoped `findMany({ where: { id: { in }, ... } })`
// — filters by id set AND by the caller's tenant, independent of whatever the
// Vectorize namespace filter already did in stage 1.
// ---------------------------------------------------------------------------

interface DocRow {
    body: string;
    id: string;
    tenantId: string;
    title: string;
}

const createPolicyAwareStore = (rows: ReadonlyArray<DocRow>) => {
    return {
        /** Mirrors `ctx.db.&lt;table>.findMany({ where: { id: { in: ids } } })` under RLS scoped to `callerTenantId`. */
        findMany: (ids: ReadonlyArray<string>, callerTenantId: string): DocRow[] =>
            rows.filter((row) => ids.includes(row.id) && row.tenantId === callerTenantId),
    };
};

// ---------------------------------------------------------------------------
// The prototype reader itself — the design doc's 3-stage pipeline, hand-rolled
// here as a plain function (NOT `ctx.db.<table>.withVectorIndex(...)` — no
// facade type, no codegen, this is exactly what the plan scopes IN).
// ---------------------------------------------------------------------------

interface ScoredDoc {
    document: DocRow;
    score: number;
}

const withVectorIndexPrototype = async (options: {
    callerTenantId: string;
    indexName: string;
    near: string;
    store: ReturnType<typeof createPolicyAwareStore>;
    topK: number;
    vectors: ReturnType<typeof createVectors>;
}): Promise<ScoredDoc[]> => {
    const { callerTenantId, indexName, near, store, topK, vectors } = options;

    // Stage 1: real Vectorize query, namespace-scoped to the caller's own tenant
    // — the design's "namespace derived from the table's own shard/RLS scope,
    // not a free-text argument" (the caller never gets to pass a different
    // namespace than their own tenant here).
    const result = await vectors.query(indexName, {
        embed,
        input: near,
        namespace: callerTenantId,
        returnMetadata: "none",
        topK,
    });

    // Stage 2: re-hydrate through the policy-aware store — RLS-shaped, scoped
    // to the SAME caller tenant, independently of stage 1's namespace filter.
    const ids = result.matches.map((match) => match.id);
    const rows = store.findMany(ids, callerTenantId);
    const byId = new Map(rows.map((row) => [row.id, row]));

    // Stage 3: re-order to match stage 1's rank (cosine: higher score = closer),
    // zip in the score, drop any id hydration didn't return (RLS-rejected or
    // otherwise gone).
    const ordered: ScoredDoc[] = [];

    for (const match of result.matches) {
        const document = byId.get(match.id);

        if (document) {
            ordered.push({ document, score: match.score });
        }
    }

    return ordered;
};

describe("plan 238 spike: .withVectorIndex() prototype over the real createVectors binding", () => {
    it("returns hydrated, score-ordered rows for a same-tenant query", async () => {
        expect.assertions(4);

        const index = createStatefulVectorizeIndex();
        const vectors = createVectors({ indexes: { docs: index } });

        await vectors.upsert("docs", { embed, id: "a-1", input: "a rainbow of colors", metadata: {}, namespace: "tenant-a" });
        await vectors.upsert("docs", { embed, id: "a-2", input: "quiet blue skies", metadata: {}, namespace: "tenant-a" });

        const store = createPolicyAwareStore([
            { body: "a rainbow of colors", id: "a-1", tenantId: "tenant-a", title: "Rainbow" },
            { body: "quiet blue skies", id: "a-2", tenantId: "tenant-a", title: "Sky" },
        ]);

        const results = await withVectorIndexPrototype({
            callerTenantId: "tenant-a",
            indexName: "docs",
            near: "rainbow of colors",
            store,
            topK: 5,
            vectors,
        });

        expect(results).toHaveLength(2);
        // Hydrated: full document, not bare Vectorize metadata.
        expect(results[0]?.document).toMatchObject({ id: "a-1", title: "Rainbow" });
        // Ordered best-match-first.
        expect(results[0]?.document.id).toBe("a-1");
        // Score carried through (236's `{ document, score }` shape).
        expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? Number.POSITIVE_INFINITY);
    });

    it("load-bearing: a namespace-scoped query does NOT return another tenant's near-perfect match", async () => {
        expect.assertions(3);

        const index = createStatefulVectorizeIndex();
        const vectors = createVectors({ indexes: { docs: index } });

        // Tenant A's own (weaker) match.
        await vectors.upsert("docs", { embed, id: "a-1", input: "a rainbow of colors", metadata: {}, namespace: "tenant-a" });

        // Tenant B's document is deliberately near-IDENTICAL wording to tenant
        // A's query — if namespace scoping silently no-op'd, this would rank
        // #1, ahead of tenant A's own weaker match. A test that used unrelated
        // tenant-B data could pass by accident (it just wouldn't score high
        // enough to matter); this one can only pass if the namespace filter
        // actually partitions the index.
        await vectors.upsert("docs", { embed, id: "b-1", input: "a rainbow of colors", metadata: {}, namespace: "tenant-b" });

        const store = createPolicyAwareStore([
            { body: "a rainbow of colors", id: "a-1", tenantId: "tenant-a", title: "Rainbow (tenant A)" },
            { body: "a rainbow of colors", id: "b-1", tenantId: "tenant-b", title: "Rainbow (tenant B)" },
        ]);

        const resultsForA = await withVectorIndexPrototype({
            callerTenantId: "tenant-a",
            indexName: "docs",
            near: "a rainbow of colors",
            store,
            topK: 5,
            vectors,
        });

        expect(resultsForA).toHaveLength(1);
        expect(resultsForA[0]?.document.id).toBe("a-1");
        // The near-perfect cross-tenant match must be ABSENT, not just
        // ranked lower.
        expect(resultsForA.some((entry) => entry.document.id === "b-1")).toBe(false);
    });

    it("defense in depth: RLS-shaped hydration refuses a cross-tenant id even if the namespace filter is bypassed", () => {
        expect.assertions(2);

        // Simulates stage 1 having somehow returned a cross-tenant id (e.g. a
        // misconfigured/omitted namespace on the write side — see the design
        // doc's "critical finding" about `packages/codegen/src/emit.ts` not
        // threading a namespace today). Stage 2 must still refuse it.
        const store = createPolicyAwareStore([
            { body: "a rainbow of colors", id: "a-1", tenantId: "tenant-a", title: "Rainbow (tenant A)" },
            { body: "a rainbow of colors", id: "b-1", tenantId: "tenant-b", title: "Rainbow (tenant B)" },
        ]);

        // Stage 1 "leaked" both ids to the caller scoped to tenant-a.
        const hydrated = store.findMany(["a-1", "b-1"], "tenant-a");

        expect(hydrated).toHaveLength(1);
        expect(hydrated[0]?.id).toBe("a-1");
    });
});
