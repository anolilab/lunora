import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { createCompact, createEpisodeExtract, createGraphExtract } from "../src/generate";

/**
 * The memory-maintenance seams (history compaction, the run-end episode summary and
 * graph extraction) persist a model's output as durable memory. A generation the
 * provider reports as cut short must fail them, not be stored as the summary.
 */

const usage = {
    inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 2, total: 2 },
    outputTokens: { reasoning: undefined, text: 1, total: 1 },
};

const modelFinishing = (text: string, finishReason: { raw: string; unified: "error" | "other" | "stop" }): MockLanguageModelV4 =>
    new MockLanguageModelV4({
        doGenerate: () => Promise.resolve({ content: [{ text, type: "text" }], finishReason, usage, warnings: [] }),
    });

const truncated = { raw: "stream-truncated", unified: "error" } as const;
const stopped = { raw: "stop", unified: "stop" } as const;

describe("memory-maintenance seams and an error finish", () => {
    it("compaction fails instead of storing a truncated summary", async () => {
        expect.hasAssertions();

        const compact = createCompact();

        await expect(
            compact({ env: {}, messages: [{ content: "hi", role: "user" }], model: modelFinishing("Half a sum", truncated), previousSummary: undefined }),
        ).rejects.toThrow("provider reason: stream-truncated");
    });

    it("compaction keeps a completed summary", async () => {
        expect.hasAssertions();

        const compact = createCompact();

        await expect(
            compact({ env: {}, messages: [{ content: "hi", role: "user" }], model: modelFinishing(" A whole summary. ", stopped), previousSummary: undefined }),
        ).resolves.toBe("A whole summary.");
    });

    it("the episode summary fails instead of storing a truncated sentence", async () => {
        expect.hasAssertions();

        const episode = createEpisodeExtract();

        await expect(episode({ assistantText: "ok", env: {}, model: modelFinishing("The user as", truncated), userInput: "hi" })).rejects.toThrow(
            "provider reason: stream-truncated",
        );
        await expect(episode({ assistantText: "ok", env: {}, model: modelFinishing("The user asked.", stopped), userInput: "hi" })).resolves.toStrictEqual({
            summary: "The user asked.",
        });
    });

    it("graph extraction fails on an error finish and treats an `other` finish as healthy", async () => {
        expect.hasAssertions();

        const graph = createGraphExtract();
        const body = JSON.stringify({ entities: [], relations: [] });

        await expect(graph({ assistantText: "ok", env: {}, model: modelFinishing(body, truncated), userInput: "hi" })).rejects.toThrow(
            "provider reason: stream-truncated",
        );
        await expect(
            graph({ assistantText: "ok", env: {}, model: modelFinishing(body, { raw: "other", unified: "other" }), userInput: "hi" }),
        ).resolves.toStrictEqual({
            entities: [],
            relations: [],
        });
    });
});
