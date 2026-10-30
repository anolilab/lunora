import { afterEach, describe, expect, it, vi } from "vitest";

import { knowledgeExcerpts } from "../../../../shared/ai-knowledge";
import loadKnowledgeExcerpts from "../../src/lib/assistant-knowledge";

describe("knowledgeExcerpts", () => {
    it("renders each matching page with its URL to cite, best match first, at most four", () => {
        expect.assertions(3);

        const excerpts = knowledgeExcerpts("how do I add an index to a table");

        expect(excerpts.length).toBeGreaterThan(0);
        expect(excerpts.length).toBeLessThanOrEqual(4);
        expect(excerpts.some((excerpt) => excerpt.includes("https://lunora.sh/docs/concepts/indexes"))).toBe(true);
    });

    it("answers a question matching nothing with one contents line rather than nothing", () => {
        expect.assertions(2);

        const excerpts = knowledgeExcerpts("zzzznotathing");

        expect(excerpts).toHaveLength(1);
        expect(excerpts[0]).toMatch(/^Documentation pages under https:\/\/lunora\.sh\/docs\/: .*concepts\/indexes/u);
    });

    it("treats a message with no usable terms as matching nothing", () => {
        expect.assertions(1);

        expect(knowledgeExcerpts("a")[0]).toContain("Documentation pages under");
    });

    it("is deterministic, so the same question always grounds the same way", () => {
        expect.assertions(1);

        expect(knowledgeExcerpts("realtime subscriptions")).toStrictEqual(knowledgeExcerpts("realtime subscriptions"));
    });
});

describe("loadKnowledgeExcerpts", () => {
    afterEach(() => {
        vi.doUnmock("../../../../shared/ai-knowledge");
        vi.resetModules();
    });

    it("loads the digest on demand and returns its excerpts", async () => {
        expect.assertions(1);

        const excerpts = await loadKnowledgeExcerpts("indexes");

        expect(excerpts.length).toBeGreaterThan(0);
    });

    it("degrades to no excerpts when the digest fails to load", async () => {
        expect.assertions(1);

        vi.resetModules();
        vi.doMock(import("../../../../shared/ai-knowledge"), () => {
            throw new Error("chunk failed to load");
        });

        const { default: fresh } = await import("../../src/lib/assistant-knowledge");

        await expect(fresh("indexes")).resolves.toStrictEqual([]);
    });
});
