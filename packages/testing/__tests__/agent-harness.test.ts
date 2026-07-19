import type { AgentToolConfig } from "@lunora/agent";
import { defineAgent, defineAgentTool } from "@lunora/agent";
import { describe, expect, it } from "vitest";

import { agentHarness, finalTurn, toolCallTurn } from "../src/agent-harness";

/**
 * A stand-in tool `inputSchema`. The harness drives a scripted model (the tool
 * input arrives pre-formed on the scripted turn), so the loop never converts the
 * schema for a real model call — any assignable value works, and this keeps the
 * suite from taking a direct `ai` dependency just for `jsonSchema`.
 */
const anySchema = {} as AgentToolConfig["inputSchema"];

describe("agentHarness", () => {
    it("drives a final-answer run and persists the user + assistant turns", async () => {
        expect.hasAssertions();

        const agent = defineAgent({ instructions: "You help.", model: "test-model" });
        const harness = agentHarness(agent, { script: [finalTurn("Hi there.")] });

        const result = await harness.run({ input: "hello", threadKey: "t1" });

        expect(result.stopped).toBe("final");
        expect(result.text).toBe("Hi there.");
        expect(result.turns).toBe(1);

        // The thread persisted both turns and settled idle.
        expect(harness.messages("t1")).toStrictEqual([
            { content: "hello", role: "user", seq: 0 },
            { content: "Hi there.", role: "assistant", seq: 1 },
        ]);
        expect(harness.thread("t1")?.status).toBe("idle");
    });

    it("runs the agent's real tool inside the loop and records its dispatch", async () => {
        expect.hasAssertions();

        const agent = defineAgent({
            model: "test-model",
            tools: {
                lookupOrder: defineAgentTool({
                    description: "Look up an order by id.",
                    execute: async (input, { run }) => run({ __lunoraRef: "orders:byId" }, { id: (input as { id: string }).id }),
                    inputSchema: anySchema,
                }),
            },
        });

        const harness = agentHarness(agent, {
            functions: {
                "orders:byId": () => {
                    return { status: "shipped" };
                },
            },
            script: [toolCallTurn("call_1", "lookupOrder", { id: "o_42" }, "checking…"), finalTurn("It shipped.")],
        });

        const result = await harness.run({ input: "where is o_42?", threadKey: "t1" });

        expect(result.text).toBe("It shipped.");

        // The tool's `ctx.run` dispatch is recorded with the exact args.
        expect(harness.dispatches).toContainEqual({ args: { id: "o_42" }, path: "orders:byId" });

        // A tool result message landed between the assistant tool-call turn and the answer.
        const roles = harness.messages("t1").map((message) => message.role);

        expect(roles).toStrictEqual(["user", "assistant", "tool", "assistant"]);
    });

    it("continues a conversation across runs on the same thread key", async () => {
        expect.hasAssertions();

        const agent = defineAgent({ model: "test-model" });
        const harness = agentHarness(agent, { script: [finalTurn("one")] });

        await harness.run({ input: "first", threadKey: "t1" });
        await harness.run({ input: "second", threadKey: "t1" }, { script: [finalTurn("two")] });

        // History carried over — seq keeps counting, both runs are present.
        expect(harness.messages("t1").map((message) => message.content)).toStrictEqual(["first", "one", "second", "two"]);
        expect(harness.thread("t1")?.messageCount).toBe(4);
    });

    it("injects a stubbed memory source and dispatches it once per run", async () => {
        expect.hasAssertions();

        const agent = defineAgent({ memory: { source: "rag:search", topK: 3 }, model: "test-model" });
        const harness = agentHarness(agent, {
            functions: {
                "rag:search": () => {
                    return { context: "Return policy is 30 days." };
                },
            },
            script: [finalTurn("30 days.")],
        });

        await harness.run({ input: "what is the return policy?", threadKey: "t1" });

        expect(harness.dispatches).toContainEqual({ args: { query: "what is the return policy?", topK: 3 }, path: "rag:search" });
    });

    it("surfaces per-run usage on the result and the thread record", async () => {
        expect.hasAssertions();

        const agent = defineAgent({ model: "test-model" });
        const harness = agentHarness(agent, {
            script: [finalTurn("done", { usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } })],
        });

        const result = await harness.run({ input: "go", threadKey: "t1" });

        expect(result.usage).toStrictEqual({ inputTokens: 5, outputTokens: 7, totalTokens: 12 });
        expect(harness.thread("t1")?.usage).toStrictEqual({ inputTokens: 5, outputTokens: 7, totalTokens: 12 });
    });

    it("stops at maxTurns when the model never finalizes", async () => {
        expect.hasAssertions();

        const agent = defineAgent({
            maxTurns: 2,
            model: "test-model",
            tools: {
                spin: defineAgentTool({ description: "Spin.", execute: () => "spun", inputSchema: anySchema }),
            },
        });

        const harness = agentHarness(agent, {
            script: [toolCallTurn("c1", "spin", {}), toolCallTurn("c2", "spin", {})],
        });

        const result = await harness.run({ input: "loop", threadKey: "t1" });

        expect(result.stopped).toBe("maxTurns");
        expect(result.turns).toBe(2);
        expect(harness.thread("t1")?.status).toBe("error");
    });

    it("throws on an unstubbed app dispatch so a missing stub fails loudly", async () => {
        expect.hasAssertions();

        const agent = defineAgent({
            model: "test-model",
            tools: {
                charge: defineAgentTool({
                    description: "Charge a card.",
                    execute: async (_input, { run }) => run({ __lunoraRef: "billing:charge" }, {}),
                    inputSchema: anySchema,
                }),
            },
        });

        const harness = agentHarness(agent, { script: [toolCallTurn("c1", "charge", {}), finalTurn("done")] });

        await expect(harness.run({ input: "pay", threadKey: "t1" })).rejects.toThrow(/unstubbed dispatch "billing:charge"/u);
    });

    it("throws when the script runs out of scripted turns", async () => {
        expect.hasAssertions();

        const agent = defineAgent({
            model: "test-model",
            tools: {
                spin: defineAgentTool({ description: "Spin.", execute: () => "spun", inputSchema: anySchema }),
            },
        });

        // A tool turn with no follow-up decision exhausts the script.
        const harness = agentHarness(agent, { script: [toolCallTurn("c1", "spin", {})] });

        await expect(harness.run({ input: "go", threadKey: "t1" })).rejects.toThrow(/scripted generate exhausted/u);
    });
});
