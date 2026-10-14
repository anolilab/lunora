import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import type { BraintrustLike, BraintrustSpan } from "../../src/telemetry/braintrust";
import { braintrustTelemetry } from "../../src/telemetry/braintrust";
import { drain, generatingModel, settle, streamingModel, withTelemetry } from "./model-fixtures";

/**
 * The ai@7 `Telemetry` event shapes are broad and churn across patch releases;
 * the tool cases intentionally pass minimal fixtures to exercise the
 * integration's defensive partial-field reads. `evt` widens a fixture to the
 * callback's event type without fabricating every unrelated field.
 */
const evt = (fixture: Record<string, unknown>): never => fixture as unknown as never;

/** Run `end` once `result` settles, either way — a detached observer, never awaited. */
const finishWhenSettled = (result: unknown, end: () => void): void => {
    const observe = async (): Promise<void> => {
        try {
            await result;
        } catch {
            // Settled either way; the timestamp is what matters.
        }

        end();
    };

    observe().catch(() => undefined);
};

interface TracedCall {
    args?: { name?: string; type?: string };
    endedAt: number | undefined;
    logs: Record<string, unknown>[];
    startedAt: number;
}

/**
 * A fake Braintrust logger. `traced` finishes the span when the callback's
 * returned promise settles — the real SDK's contract, and what lets the bridge
 * hold a model-call span open past `execute()`.
 */
const fakeBraintrust = () => {
    const calls: TracedCall[] = [];

    const logger: BraintrustLike = {
        traced: (callback, args) => {
            const call: TracedCall = { args, endedAt: undefined, logs: [], startedAt: Date.now() };
            const span: BraintrustSpan = {
                log: (event) => {
                    call.logs.push(event);
                },
            };

            calls.push(call);

            const result = callback(span);

            // The real SDK finishes the span when the callback's promise settles.
            finishWhenSettled(result, () => {
                call.endedAt = Date.now();
            });

            return result;
        },
    };

    return { calls, logger };
};

/** All logged fields across every traced span, flattened for assertions. */
const dumpLogs = (calls: TracedCall[]): string => JSON.stringify(calls.map((call) => call.logs));

/** Merge everything logged onto one span, so an assertion need not know which `log` call carried a field. */
const merged = (call: TracedCall): Record<string, unknown> => Object.assign({}, ...call.logs) as Record<string, unknown>;

describe(braintrustTelemetry, () => {
    it("measures a STREAMED call to the end of the stream, with its usage", async () => {
        const { calls, logger } = fakeBraintrust();

        const stream = streamText({
            model: streamingModel({ chunks: 3, gapMs: 30 }),
            prompt: "hi",
            telemetry: withTelemetry(braintrustTelemetry({ logger })),
        });

        await expect(drain(stream.textStream)).resolves.toBe("xxx");

        await stream.usage;
        await settle();

        const call = calls[0] as TracedCall;

        // Floor at half the STREAM's own delay budget (3 chunks x 30 ms), not at a
        // fraction of wall clock: `wallMs` starts before the span does, so a slow
        // runner inflates the divisor past the span and the assertion fails on
        // timing alone (CI hit `expected 94 to be greater than 96`). The defect
        // this guards is a span that ends at time-to-first-byte — ~1 ms — which
        // any floor in this range separates decisively.
        const minStreamedMs = (3 * 30) / 2;

        // The old shape simply awaited `execute()`, which resolves the instant
        // `doStream` hands the stream back: the span measured ~1 ms of a ~100 ms
        // call and logged the stream handle instead of the generation.
        expect(call.endedAt).toBeDefined();
        expect((call.endedAt as number) - call.startedAt).toBeGreaterThan(minStreamedMs);
        expect(merged(call).metrics).toStrictEqual({ completion_tokens: 3, prompt_tokens: 12, tokens: 15 });
    });

    it("logs token usage as metrics on a non-streamed call through generateText", async () => {
        const { calls, logger } = fakeBraintrust();

        const result = await generateText({
            model: generatingModel(),
            prompt: "hi",
            telemetry: withTelemetry(braintrustTelemetry({ functionId: "support", logger })),
        });

        await settle();

        expect(result.text).toBe("answer");
        expect(calls[0]?.args).toStrictEqual({ name: "support", type: "llm" });
        // Usage is read off the SDK's NORMALIZED end event; a LanguageModelV4
        // provider reports `{ inputTokens: { total } }`, which a flat reader over
        // the raw resolved value sees as no usage at all.
        expect(merged(calls[0] as TracedCall).metrics).toStrictEqual({ completion_tokens: 3, prompt_tokens: 12, tokens: 15 });
        expect(calls[0]?.endedAt).toBeDefined();
    });

    it("returns execute()'s value to the caller without waiting for the span to close", async () => {
        const { calls, logger } = fakeBraintrust();

        const result = await generateText({ model: generatingModel(), prompt: "hi", telemetry: withTelemetry(braintrustTelemetry({ logger })) });

        expect(result.text).toBe("answer");
        expect(calls).toHaveLength(1);
    });

    it("logs an error on a stream that dies mid-way", async () => {
        const { calls, logger } = fakeBraintrust();

        const stream = streamText({
            model: streamingModel({ chunks: 3, failAfter: 1, gapMs: 5 }),
            prompt: "hi",
            telemetry: withTelemetry(braintrustTelemetry({ logger })),
        });

        await drain(stream.textStream);

        await expect(stream.finishReason).resolves.toBe("error");

        await settle();

        expect(merged(calls[0] as TracedCall).error).toBe("the model call ended with an error");
        expect(calls[0]?.endedAt).toBeDefined();
    });

    it("logs an error when the provider call itself rejects", async () => {
        const { calls, logger } = fakeBraintrust();

        await expect(
            generateText({
                maxRetries: 0,
                model: new MockLanguageModelV4({ doGenerate: () => Promise.reject(new Error("model down")) }),
                prompt: "hi",
                telemetry: withTelemetry(braintrustTelemetry({ logger })),
            }),
        ).rejects.toThrow("model down");

        await settle();

        // The llm span records the failure; a separate `type: "error"` span carries
        // the exception itself.
        expect(merged(calls[0] as TracedCall).error).toBe("model down");
        expect(calls.some((call) => call.args?.type === "error")).toBe(true);
    });

    it("an abort in one run does not close a concurrent run's span on a SHARED integration", async () => {
        const { calls, logger } = fakeBraintrust();
        const shared = braintrustTelemetry({ logger });

        const abortController = new AbortController();
        const aborted = streamText({
            abortSignal: abortController.signal,
            model: streamingModel({ chunks: 20, gapMs: 10 }),
            prompt: "A",
            telemetry: withTelemetry(shared),
        });
        const healthy = streamText({ model: streamingModel({ chunks: 4, gapMs: 10 }), prompt: "B", telemetry: withTelemetry(shared) });

        await Promise.all([
            drain(aborted.textStream, (index) => {
                if (index === 2) {
                    abortController.abort();
                }
            }),
            drain(healthy.textStream),
        ]);
        await settle();

        const llmSpans = calls.filter((call) => call.args?.type === "llm");

        expect(llmSpans).toHaveLength(2);
        expect(llmSpans.filter((call) => merged(call).error !== undefined)).toHaveLength(1);

        // The healthy run still reports its real usage rather than being swept up
        // in the sibling's abort.
        const ok = llmSpans.filter((call) => merged(call).error === undefined);

        expect(ok).toHaveLength(1);
        expect(merged(ok[0] as TracedCall).metrics).toStrictEqual({ completion_tokens: 3, prompt_tokens: 12, tokens: 15 });
    });

    it("does NOT log the prompt or the completion by default", async () => {
        const { calls, logger } = fakeBraintrust();

        await generateText({ model: generatingModel(), prompt: "SENSITIVE", telemetry: withTelemetry(braintrustTelemetry({ logger })) });
        await settle();

        expect(dumpLogs(calls)).not.toContain("SENSITIVE");
        expect(merged(calls[0] as TracedCall)).not.toHaveProperty("input");
        expect(merged(calls[0] as TracedCall)).not.toHaveProperty("output");
    });

    it("logs the prompt and the completion when both flags are set", async () => {
        const { calls, logger } = fakeBraintrust();

        await generateText({
            model: generatingModel(),
            prompt: "hello",
            telemetry: withTelemetry(braintrustTelemetry({ logger, recordInputs: true, recordOutputs: true })),
        });
        await settle();

        expect(dumpLogs(calls)).toContain("hello");
        // The normalized content, not the raw resolved value.
        expect(merged(calls[0] as TracedCall).output).toBe("answer");
    });

    // The mirror of the Sentry sweep case, for a different resource: Braintrust's
    // span ends when the `traced` callback's promise settles, and the bridge parks
    // that callback on a gate the terminal event releases. An abandoned call never
    // gets that event, so dropping its record without releasing the gate parks the
    // callback — and its span — for the life of the isolate.
    it("releases the parked traced callback of an abandoned call when swept", async () => {
        expect.assertions(2);

        const { calls, logger } = fakeBraintrust();
        const shared = braintrustTelemetry({ logger });

        // `execute()` RESOLVES — a stream handed back at first byte — and only then
        // does the stream die without a callback. That is what leaves the traced
        // callback parked on the gate rather than on `execute()` itself.
        const opened = shared.executeLanguageModelCall?.(evt({ callId: "call-abandoned", execute: () => Promise.resolve({}), modelId: "m", provider: "p" })) as
            Promise<unknown> | undefined;

        opened?.catch(() => undefined);

        await settle();

        expect(calls).toHaveLength(1);

        const cutoffPassed = Date.now() + 11 * 60 * 1000;

        vi.spyOn(Date, "now").mockReturnValue(cutoffPassed);

        try {
            const openedLater = shared.executeLanguageModelCall?.(
                evt({ callId: "call-later", execute: () => Promise.resolve({}), modelId: "m", provider: "p" }),
            ) as Promise<unknown> | undefined;

            openedLater?.catch(() => undefined);
        } finally {
            vi.mocked(Date.now).mockRestore();
        }

        await settle();

        expect((calls[0] as TracedCall).endedAt).toBeDefined();
    });

    it("wraps a tool execution in a traced tool span and returns the result", async () => {
        const { calls, logger } = fakeBraintrust();

        const result = await braintrustTelemetry({ logger }).executeTool?.({
            callId: "call-1",
            execute: () => Promise.resolve("tool-value"),
            toolCall: evt({ input: { q: "x" }, toolName: "lookup" }),
            toolCallId: "tc-1",
        });

        expect(result).toBe("tool-value");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.args).toStrictEqual({ name: "lookup", type: "tool" });
    });

    it("does NOT log tool input or output by default", async () => {
        const { calls, logger } = fakeBraintrust();

        await braintrustTelemetry({ logger }).executeTool?.({
            callId: "call-1",
            execute: () => Promise.resolve("SECRET-OUTPUT"),
            toolCall: evt({ input: { q: "SECRET-INPUT" }, toolName: "lookup" }),
            toolCallId: "tc-1",
        });

        const logs = dumpLogs(calls);

        expect(logs).not.toContain("SECRET-INPUT");
        expect(logs).not.toContain("SECRET-OUTPUT");
    });

    it("logs tool input when recordInputs is set and output when recordOutputs is set", async () => {
        const { calls, logger } = fakeBraintrust();

        await braintrustTelemetry({ logger, recordInputs: true, recordOutputs: true }).executeTool?.({
            callId: "call-1",
            execute: () => Promise.resolve("the-output"),
            toolCall: evt({ input: { q: "the-input" }, toolName: "lookup" }),
            toolCallId: "tc-1",
        });

        const logs = dumpLogs(calls);

        expect(logs).toContain("the-input");
        expect(logs).toContain("the-output");
    });

    it("logs a bare thrown value on onError", () => {
        const { calls, logger } = fakeBraintrust();

        braintrustTelemetry({ logger }).onError?.(new Error("kaboom"));

        expect(calls).toHaveLength(1);
        expect(calls[0]?.args).toStrictEqual({ name: "error", type: "error" });
        expect(calls[0]?.logs[0]).toStrictEqual({ error: { message: "kaboom", name: "Error" } });
    });

    it("passes the caller's logger through (dependency injection)", async () => {
        const traced = vi.fn<(callback: (span: BraintrustSpan) => unknown) => unknown>((callback) => callback({ log: () => undefined }));
        const logger = { traced } as unknown as BraintrustLike;

        await braintrustTelemetry({ logger }).executeTool?.({
            callId: "c",
            execute: () => Promise.resolve("x"),
            toolCall: evt({ toolName: "t" }),
            toolCallId: "tc",
        });

        expect(traced).toHaveBeenCalledTimes(1);
    });
});
