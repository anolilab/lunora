import type { AgentTokenDelta } from "@lunora/agent";
import { createStreamGenerate, defineAgent, defineAgentTool } from "@lunora/agent";
import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { agentHarness } from "../src/agent-harness";
import type { RecordedStreamPart, RecordedTurn } from "../src/recorded-model";
import { createStreamGate, recordedModel } from "../src/recorded-model";

const usage = (inputTokens: number, outputTokens: number) => {
    return {
        inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: inputTokens, total: inputTokens },
        outputTokens: { reasoning: undefined, text: outputTokens, total: outputTokens },
    };
};

const stop = (inputTokens = 1, outputTokens = 1): RecordedStreamPart => {
    return { finishReason: { raw: "stop", unified: "stop" }, type: "finish", usage: usage(inputTokens, outputTokens) };
};

const toolCalls = (inputTokens = 1, outputTokens = 1): RecordedStreamPart => {
    return { finishReason: { raw: "tool_calls", unified: "tool-calls" }, type: "finish", usage: usage(inputTokens, outputTokens) };
};

const lookupSchema = jsonSchema<{ id: string }>({
    additionalProperties: false,
    properties: { id: { type: "string" } },
    required: ["id"],
    type: "object",
});

describe("recordedModel through the production streaming seam", () => {
    it("keeps tool-input chunks out of the text and runs the tool with the tool-call part's arguments", async () => {
        expect.hasAssertions();

        const executed: unknown[] = [];
        const agent = defineAgent({
            model: "test-model",
            tools: {
                lookupOrder: defineAgentTool({
                    description: "Look up an order by id.",
                    execute: (input) => {
                        executed.push(input);

                        return { status: "shipped" };
                    },
                    inputSchema: lookupSchema,
                }),
            },
        });

        // The arguments are split across three `tool-input-delta` chunks; the
        // provider's `tool-call` part carries them assembled.
        const model = recordedModel([
            {
                parts: [
                    { type: "stream-start", warnings: [] },
                    { id: "t0", type: "text-start" },
                    { delta: "Checking ", id: "t0", type: "text-delta" },
                    { delta: "the order.", id: "t0", type: "text-delta" },
                    { id: "t0", type: "text-end" },
                    { id: "c1", toolName: "lookupOrder", type: "tool-input-start" },
                    { delta: '{"id":"', id: "c1", type: "tool-input-delta" },
                    { delta: "o_4", id: "c1", type: "tool-input-delta" },
                    { delta: '2"}', id: "c1", type: "tool-input-delta" },
                    { id: "c1", type: "tool-input-end" },
                    { input: '{"id":"o_42"}', toolCallId: "c1", toolName: "lookupOrder", type: "tool-call" },
                    toolCalls(8, 6),
                ],
            },
            {
                parts: [{ id: "t1", type: "text-start" }, { delta: "It shipped.", id: "t1", type: "text-delta" }, { id: "t1", type: "text-end" }, stop(12, 3)],
            },
        ]);

        const deltas: AgentTokenDelta[] = [];
        const harness = agentHarness(agent, {});
        const result = await harness.run(
            { input: "where is o_42?", threadKey: "t1" },
            {
                model,
                onTokenDelta: (delta) => {
                    deltas.push(delta);
                },
            },
        );

        expect(result.text).toBe("It shipped.");
        expect(executed).toStrictEqual([{ id: "o_42" }]);

        // Deltas reach the live sink in order, keyed to the turn producing them.
        expect(
            deltas.map(({ text, turn }) => {
                return { text, turn };
            }),
        ).toStrictEqual([
            { text: "Checking ", turn: 0 },
            { text: "the order.", turn: 0 },
            { text: "It shipped.", turn: 1 },
        ]);

        expect(harness.messages("t1").map((message) => message.role)).toStrictEqual(["user", "assistant", "tool", "assistant"]);
        expect(harness.messages("t1")[1]?.content).toBe("Checking the order.");
        expect(model.doStreamCalls).toHaveLength(2);
    });

    it("surfaces an error injected mid-stream as the loop's normal model-error path", async () => {
        expect.hasAssertions();

        const agent = defineAgent({ model: "test-model" });
        const model = recordedModel([
            {
                // Parts 0-2 stream (text-start and the two deltas); the failure follows them.
                error: { after: 3, cause: new Error("upstream reset") },
                parts: [
                    { id: "t0", type: "text-start" },
                    { delta: "Partial ", id: "t0", type: "text-delta" },
                    { delta: "answer", id: "t0", type: "text-delta" },
                    { id: "t0", type: "text-end" },
                    stop(),
                ],
            },
        ]);

        const deltas: string[] = [];
        const harness = agentHarness(agent, {});

        await expect(
            harness.run(
                { input: "hello", threadKey: "t1" },
                {
                    model,
                    onTokenDelta: (delta) => {
                        deltas.push(delta.text);
                    },
                },
            ),
        ).rejects.toThrow("upstream reset");

        // The deltas streamed before the failure were already delivered, and the
        // thread records the failure exactly as a non-streaming model error would.
        expect(deltas).toStrictEqual(["Partial ", "answer"]);
        expect(harness.thread("t1")?.status).toBe("error");
        expect(harness.thread("t1")?.error).toContain("upstream reset");
    });

    it("fails the turn on an in-band error part after partial text and persists none of the attempt", async () => {
        expect.hasAssertions();

        const agent = defineAgent({ model: "test-model" });
        // The provider reports the failure as a stream part, not a rejected stream,
        // and still closes the turn with a finish part.
        const model = recordedModel([
            {
                parts: [
                    { id: "t0", type: "text-start" },
                    { delta: "Partial ", id: "t0", type: "text-delta" },
                    { error: new Error("upstream reset"), type: "error" },
                    stop(),
                ],
            },
        ]);

        const deltas: string[] = [];
        const harness = agentHarness(agent, {});

        await expect(
            harness.run(
                { input: "hello", threadKey: "t1" },
                {
                    model,
                    onTokenDelta: (delta) => {
                        deltas.push(delta.text);
                    },
                },
            ),
        ).rejects.toThrow("upstream reset");

        // The thread records the failure, and the truncated prefix is not an answer.
        expect(deltas).toStrictEqual(["Partial "]);
        expect(harness.thread("t1")?.status).toBe("error");
        expect(harness.messages("t1").map((message) => message.role)).toStrictEqual(["user"]);
    });

    it("fails the turn on an in-band error part that arrives before any text", async () => {
        expect.hasAssertions();

        const agent = defineAgent({ model: "test-model" });
        const model = recordedModel([{ parts: [{ error: new Error("rate limited"), type: "error" }, stop()] }]);
        const harness = agentHarness(agent, {});

        await expect(harness.run({ input: "hello", threadKey: "t1" }, { model })).rejects.toThrow("rate limited");

        expect(harness.thread("t1")?.status).toBe("error");
        expect(harness.messages("t1").map((message) => message.role)).toStrictEqual(["user"]);
    });

    it("normalises a non-Error in-band error value into an Error that carries it as cause", async () => {
        expect.hasAssertions();

        const agent = defineAgent({ model: "test-model" });
        const model = recordedModel([
            {
                parts: [
                    { id: "t0", type: "text-start" },
                    { delta: "Partial ", id: "t0", type: "text-delta" },
                    { error: "upstream said no", type: "error" },
                    stop(),
                ],
            },
        ]);
        const harness = agentHarness(agent, {});

        const failure = await harness.run({ input: "hello", threadKey: "t1" }, { model }).then(
            () => undefined,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain("upstream said no");
        expect((failure as Error).cause).toBe("upstream said no");
        expect(harness.messages("t1").map((message) => message.role)).toStrictEqual(["user"]);
    });

    it("fails the turn when the stream ends after partial text without a finish part", async () => {
        expect.hasAssertions();

        const agent = defineAgent({ model: "test-model" });
        // The connection closes cleanly mid-answer: no error part, no finish part.
        const model = recordedModel([
            {
                parts: [
                    { id: "t0", type: "text-start" },
                    { delta: "Partial ", id: "t0", type: "text-delta" },
                    { id: "t0", type: "text-end" },
                ],
            },
        ]);
        const harness = agentHarness(agent, {});

        await expect(harness.run({ input: "hello", threadKey: "t1" }, { model })).rejects.toThrow("model stream ended without a finish part");

        expect(harness.thread("t1")?.status).toBe("error");
        expect(harness.messages("t1").map((message) => message.role)).toStrictEqual(["user"]);
    });

    it("keeps a provider's own `other` finish, with no raw reason, as a successful turn", async () => {
        expect.hasAssertions();

        const agent = defineAgent({ model: "test-model" });
        // The provider sends a finish part, but with an `other` reason and no raw
        // reason: the SDK reports the same `other` for an unfinished stream, so the
        // guard must key on the finish part itself, not the reason.
        const model = recordedModel([
            {
                parts: [
                    { id: "t0", type: "text-start" },
                    { delta: "Done.", id: "t0", type: "text-delta" },
                    { id: "t0", type: "text-end" },
                    { finishReason: { raw: undefined, unified: "other" }, type: "finish", usage: usage(2, 1) },
                ],
            },
        ]);
        const harness = agentHarness(agent, {});
        const result = await harness.run({ input: "hello", threadKey: "t1" }, { model });

        expect(result).toMatchObject({ stopped: "final", text: "Done." });
        expect(harness.messages("t1").map((message) => message.content)).toStrictEqual(["hello", "Done."]);
    });

    it("picks up usage that arrives only on the finish part", async () => {
        expect.hasAssertions();

        const agent = defineAgent({ model: "test-model" });
        // No part before `finish` carries usage: the provider reports it at the end.
        const model = recordedModel([
            {
                parts: [{ id: "t0", type: "text-start" }, { delta: "Done.", id: "t0", type: "text-delta" }, { id: "t0", type: "text-end" }, stop(12, 5)],
            },
        ]);

        const harness = agentHarness(agent, {});
        const result = await harness.run({ input: "hello", threadKey: "t1" }, { model });

        expect(result.usage).toStrictEqual({ inputTokens: 12, outputTokens: 5, totalTokens: 17 });
        expect(harness.thread("t1")?.usage).toStrictEqual({ inputTokens: 12, outputTokens: 5, totalTokens: 17 });
    });

    it("pauses mid-stream on a gate so a test can observe the partial text and then cancel", async () => {
        expect.hasAssertions();

        const gate = createStreamGate();
        const turn: RecordedTurn = {
            parts: [
                { id: "t0", type: "text-start" },
                { delta: "The ", id: "t0", type: "text-delta" },
                { delta: "quick ", id: "t0", type: "text-delta" },
                { delta: "brown fox", id: "t0", type: "text-delta" },
                { id: "t0", type: "text-end" },
                stop(),
            ],
            // Stop after the first two deltas (text-start, "The ", "quick " are parts 0-2).
            pause: { after: 3, gate },
        };
        const agent = defineAgent({ model: recordedModel([turn]) });
        const generate = createStreamGenerate(agent, {});

        const deltas: string[] = [];
        let seen: () => void = () => {};
        const twoDeltas = new Promise<void>((resolve) => {
            seen = resolve;
        });
        const controller = new AbortController();

        const pending = generate({ messages: [{ content: "hi", role: "user" }], signal: controller.signal }, (text) => {
            deltas.push(text);

            if (deltas.length === 2) {
                seen();
            }
        });

        // Observe: the stream has reached the gate and delivered two deltas.
        await Promise.all([gate.reached, twoDeltas]);

        expect(deltas).toStrictEqual(["The ", "quick "]);

        // Cancel, then release the held stream: the recorded stream does not watch
        // the signal itself, so the abort only takes effect once the stream resumes.
        // The aborted turn resolves to the text streamed so far and emits nothing more.
        controller.abort();
        gate.release();

        const result = await pending;

        expect(result.text).toBe("The quick ");
        expect(deltas).toStrictEqual(["The ", "quick "]);
    });
});
