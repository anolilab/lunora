import { describe, expect, it } from "vitest";

import { buildModelMessages } from "../src/model-messages";

describe(buildModelMessages, () => {
    it("orders instructions, memory context, then the correlated history", () => {
        const messages = buildModelMessages({
            history: [
                { content: "what's the weather?", role: "user", seq: 0 },
                { content: "checking…", role: "assistant", seq: 1, toolCalls: [{ id: "call_1", input: { city: "Berlin" }, name: "getWeather" }] },
                { content: "sunny", role: "tool", seq: 2, toolCallId: "call_1", toolName: "getWeather" },
                { content: "It is sunny.", role: "assistant", seq: 3 },
            ],
            instructions: "Be brief.",
            memoryContext: "[source:doc-1#0]\nBerlin facts.",
        });

        expect(messages[0]).toStrictEqual({ content: "Be brief.", role: "system" });
        expect(messages[1]?.role).toBe("system");
        expect(messages[1]?.content as string).toContain("Berlin facts.");
        expect(messages[2]).toStrictEqual({ content: "what's the weather?", role: "user" });

        // The assistant tool call and the tool result correlate by toolCallId.
        expect(messages[3]).toStrictEqual({
            content: [
                { text: "checking…", type: "text" },
                { input: { city: "Berlin" }, toolCallId: "call_1", toolName: "getWeather", type: "tool-call" },
            ],
            role: "assistant",
        });
        expect(messages[4]).toStrictEqual({
            content: [{ output: { type: "text", value: "sunny" }, toolCallId: "call_1", toolName: "getWeather", type: "tool-result" }],
            role: "tool",
        });
        expect(messages[5]).toStrictEqual({ content: "It is sunny.", role: "assistant" });
    });

    it("inserts the compaction summary after memory context and before the recent tail", () => {
        const messages = buildModelMessages({
            history: [{ content: "and now?", role: "user", seq: 9 }],
            instructions: "Be brief.",
            memoryContext: "Berlin facts.",
            summary: "Earlier the user asked about the weather; it was sunny.",
        });

        expect(messages[0]).toStrictEqual({ content: "Be brief.", role: "system" });
        expect(messages[1]?.content as string).toContain("Berlin facts.");
        // The summary is its own system message, after memory, before history.
        expect(messages[2]?.role).toBe("system");
        expect(messages[2]?.content as string).toContain("Summary of the earlier conversation:");
        expect(messages[2]?.content as string).toContain("it was sunny.");
        expect(messages[3]).toStrictEqual({ content: "and now?", role: "user" });
    });

    it("omits an empty compaction summary", () => {
        const messages = buildModelMessages({ history: [{ content: "hi", role: "user", seq: 0 }], summary: "" });

        expect(messages).toStrictEqual([{ content: "hi", role: "user" }]);
    });

    it("omits empty instructions and memory, and skips text-less tool-call parts", () => {
        const messages = buildModelMessages({
            history: [{ content: "", role: "assistant", seq: 0, toolCalls: [{ id: "c", input: {}, name: "t" }] }],
        });

        // The second message is the synthetic result pairing the dangling call.
        expect(messages).toHaveLength(2);
        expect(messages[0]?.content).toStrictEqual([{ input: {}, toolCallId: "c", toolName: "t", type: "tool-call" }]);
    });

    it("pairs a tool call the interrupted run never answered with a synthetic result", () => {
        const messages = buildModelMessages({
            history: [
                { content: "do both", role: "user", seq: 0 },
                {
                    content: "",
                    role: "assistant",
                    seq: 1,
                    toolCalls: [
                        { id: "call_1", input: {}, name: "first" },
                        { id: "call_2", input: {}, name: "second" },
                    ],
                },
                { content: "done", role: "tool", seq: 2, toolCallId: "call_1", toolName: "first" },
            ],
        });

        expect(messages.filter((message) => message.role === "tool")).toHaveLength(2);
        expect(messages[1]?.role).toBe("assistant");
        expect(messages[2]).toStrictEqual({
            content: [{ output: { type: "text", value: "done" }, toolCallId: "call_1", toolName: "first", type: "tool-result" }],
            role: "tool",
        });
        expect(messages[3]).toStrictEqual({
            content: [
                {
                    output: { type: "text", value: "Tool call was not executed: the run was interrupted before it ran." },
                    toolCallId: "call_2",
                    toolName: "second",
                    type: "tool-result",
                },
            ],
            role: "tool",
        });
    });

    it("pairs a call whose only tool row is an awaiting-approval placeholder", () => {
        const messages = buildModelMessages({
            history: [
                { content: "delete it", role: "user", seq: 0 },
                { content: "", role: "assistant", seq: 1, toolCalls: [{ id: "call_a", input: {}, name: "remove" }] },
                { content: "", role: "tool", seq: 2, status: "awaiting_approval", toolCallId: "call_a", toolName: "remove" },
            ],
        });

        const results = messages.filter((message) => message.role === "tool");

        expect(results).toHaveLength(1);
        expect(results[0]).toStrictEqual({
            content: [
                {
                    output: { type: "text", value: "Tool call was not executed: the run was interrupted before it ran." },
                    toolCallId: "call_a",
                    toolName: "remove",
                    type: "tool-result",
                },
            ],
            role: "tool",
        });
    });
});
