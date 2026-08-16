import type { EmbeddingModel } from "ai";
import { describe, expect, it, vi } from "vitest";

import defineRag from "../../src/rag/define-rag";
import bm25LexicalStore from "../../src/rag/lexical-store";
import matchesMetadataFilter from "../../src/rag/metadata-filter";
import type { RagVectors } from "../../src/rag/types";

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

describe("matchesMetadataFilter", () => {
    const metadata = { author: { id: 7, name: "ada" }, orgId: "org-1", score: 42, status: "published", tags: ["a", "b"] };

    it("matches an empty or absent filter", () => {
        expect.assertions(2);

        expect(matchesMetadataFilter(metadata, undefined)).toBe(true);
        expect(matchesMetadataFilter(metadata, {})).toBe(true);
    });

    it("evaluates implicit equality", () => {
        expect.assertions(2);

        expect(matchesMetadataFilter(metadata, { status: "published" })).toBe(true);
        expect(matchesMetadataFilter(metadata, { status: "draft" })).toBe(false);
    });

    it("aNDs multiple clauses", () => {
        expect.assertions(2);

        expect(matchesMetadataFilter(metadata, { orgId: "org-1", status: "published" })).toBe(true);
        expect(matchesMetadataFilter(metadata, { orgId: "org-2", status: "published" })).toBe(false);
    });

    it("evaluates comparison operators", () => {
        expect.assertions(6);

        expect(matchesMetadataFilter(metadata, { score: { $gt: 40 } })).toBe(true);
        expect(matchesMetadataFilter(metadata, { score: { $gte: 42 } })).toBe(true);
        expect(matchesMetadataFilter(metadata, { score: { $lt: 42 } })).toBe(false);
        expect(matchesMetadataFilter(metadata, { score: { $lte: 42 } })).toBe(true);
        expect(matchesMetadataFilter(metadata, { status: { $ne: "draft" } })).toBe(true);
        expect(matchesMetadataFilter(metadata, { status: { $eq: "published" } })).toBe(true);
    });

    it("evaluates set membership", () => {
        expect.assertions(4);

        expect(matchesMetadataFilter(metadata, { status: { $in: ["published", "review"] } })).toBe(true);
        expect(matchesMetadataFilter(metadata, { status: { $in: ["draft"] } })).toBe(false);
        expect(matchesMetadataFilter(metadata, { status: { $nin: ["draft"] } })).toBe(true);
        expect(matchesMetadataFilter(metadata, { status: { $nin: ["published"] } })).toBe(false);
    });

    it("resolves dot-notation paths into nested objects", () => {
        expect.assertions(2);

        expect(matchesMetadataFilter(metadata, { "author.id": 7 })).toBe(true);
        expect(matchesMetadataFilter(metadata, { "author.name": "grace" })).toBe(false);
    });

    it("prefers a literal dotted key over a nested path", () => {
        expect.assertions(1);

        // A stored key that literally contains a dot must win, so a caller who
        // wrote `{"a.b": 1}` at index time can filter on exactly that.
        expect(matchesMetadataFilter({ "a.b": 1, a: { b: 2 } }, { "a.b": 1 })).toBe(true);
    });

    it("does not walk the prototype chain", () => {
        expect.assertions(2);

        // `constructor.name` must resolve to nothing, not to "Object".
        expect(matchesMetadataFilter(metadata, { "constructor.name": "Object" })).toBe(false);
        expect(matchesMetadataFilter(metadata, { toString: undefined })).toBe(true);
    });

    it("fails closed on an unrecognised operator", () => {
        expect.assertions(1);

        // Guessing at an unknown operator risks admitting a row an RLS filter
        // meant to exclude — the failure mode is a cross-tenant leak.
        expect(matchesMetadataFilter(metadata, { tags: { $contains: "a" } })).toBe(false);
    });

    it("fails closed on a range predicate over an incomparable value", () => {
        expect.assertions(2);

        expect(matchesMetadataFilter(metadata, { status: { $gt: 3 } })).toBe(false);
        expect(matchesMetadataFilter(metadata, { missing: { $lt: 10 } })).toBe(false);
    });

    it("rejects everything but an empty filter when metadata is absent", () => {
        expect.assertions(2);

        expect(matchesMetadataFilter(undefined, { orgId: "org-1" })).toBe(false);
        expect(matchesMetadataFilter(undefined, {})).toBe(true);
    });
});

describe("hybrid search under metadata RLS", () => {
    it("keeps a lexical leg when rlsFilter is metadata-based", async () => {
        expect.assertions(3);

        const store = bm25LexicalStore();
        const upserted = new Map<string, { metadata?: Record<string, unknown> }>();
        const docs = defineRag({
            allowSharedNamespace: true,
            embeddingModel: model,
            index: "docs",
            lexicalStore: store,
            // The exact shape rlsFilter produces: a flat tenant predicate.
            rlsFilter: () => {
                return { orgId: "org-1" };
            },
        });

        const vectors: RagVectors = {
            deleteByIds: () => Promise.resolve(undefined),
            getByIds: () => Promise.resolve([]),
            // The vector leg finds nothing, so any hit in the result came from
            // the lexical leg — which is precisely what used to be impossible.
            query: () => Promise.resolve({ count: 0, matches: [] }),
            upsert: (_index, input) => {
                upserted.set(input.id, { metadata: input.metadata });

                return Promise.resolve(undefined);
            },
        };

        const rag = docs({ auth: { orgId: "org-1" }, vectors });

        await rag.index({ id: "own", metadata: { orgId: "org-1" }, text: "the qwerty token lives here" });
        await rag.index({ id: "other", metadata: { orgId: "org-2" }, text: "the qwerty token lives here too" });

        const result = await rag.retrieve("qwerty", { topK: 5 });

        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0]?.sourceId).toBe("own");
        // The other tenant's chunk was indexed but must never surface.
        expect(upserted.has("other#0")).toBe(true);
    });

    it("returns nothing rather than another tenant's chunk", async () => {
        expect.assertions(1);

        const store = bm25LexicalStore();
        const docs = defineRag({
            allowSharedNamespace: true,
            embeddingModel: model,
            index: "docs",
            lexicalStore: store,
            rlsFilter: () => {
                return { orgId: "org-9" };
            },
        });

        const vectors: RagVectors = {
            deleteByIds: () => Promise.resolve(undefined),
            getByIds: () => Promise.resolve([]),
            query: () => Promise.resolve({ count: 0, matches: [] }),
            upsert: () => Promise.resolve(undefined),
        };

        const rag = docs({ auth: {}, vectors });

        await rag.index({ id: "other", metadata: { orgId: "org-2" }, text: "the qwerty token lives here" });

        const result = await rag.retrieve("qwerty", { topK: 5 });

        expect(result.chunks).toStrictEqual([]);
    });
});
