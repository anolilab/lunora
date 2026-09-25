import { describe, expect, it } from "vitest";

import { vectorBackfillTargets } from "../../src/vectors";

const embed = (): number[] => [1];

const schemaWith = (model?: string) => {
    return {
        tables: { posts: { vectorIndexes: [{ dimensions: 768, embed, field: "body", metric: "cosine", model, name: "posts_body" }] } },
        vectorIndexes: { posts_mixed: { dimensions: 768, embed, metric: "cosine", model, select: () => "", table: "posts" } },
    };
};

describe(vectorBackfillTargets, () => {
    it("keeps the fingerprint an index without a declared model was recorded under", () => {
        expect.assertions(1);

        // The exact string stored before `model` existed: a changed format would re-embed every table on the next backfill.
        expect(vectorBackfillTargets(schemaWith())).toStrictEqual([
            { profile: '["posts_body","body",768,"cosine",[]]|["posts_mixed","(select)",768,"cosine"]', table: "posts" },
        ]);
    });

    it("changes the fingerprint of both index shapes when only the model changes", () => {
        expect.assertions(2);

        const [before] = vectorBackfillTargets(schemaWith("@cf/baai/bge-base-en-v1.5"));
        const [after] = vectorBackfillTargets(schemaWith("@cf/baai/bge-m3"));

        expect(before?.profile).toBe(
            '["posts_body","body",768,"cosine",[],"@cf/baai/bge-base-en-v1.5"]|["posts_mixed","(select)",768,"cosine","@cf/baai/bge-base-en-v1.5"]',
        );
        expect(after?.profile).not.toBe(before?.profile);
    });
});
