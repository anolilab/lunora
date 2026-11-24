import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { defineAgent } from "../../src/define-agent";
import { createAgentGenerate, createStreamGenerate } from "../../src/generate";
import type { SentryLike, SentrySpan } from "../../src/telemetry/sentry";
import { sentryTelemetry } from "../../src/telemetry/sentry";
import type { GenerateResult } from "./model-fixtures";
import { drain, failedGenerateModel, failedStreamModel, generatingModel, reportedUsage, STOP, streamingModel, withTelemetry } from "./model-fixtures";

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

/** One span the fake Sentry handed out, with everything the bridge did to it. */
interface RecordedSpan {
    attributes: Record<string, unknown>;
    endedAt: number | undefined;
    manual: boolean;
    name: string;
    op?: string;
    startedAt: number;
    status: { code: number; message?: string } | undefined;
}

/**
 * A fake Sentry namespace recording span lifetimes. `startSpanManual` models the
 * real `@sentry/core` contract — the span is NOT finished when the callback
 * settles, only when `span.end()` is called.
 *
 * The bridge ends a model-call span synchronously inside the SDK callback that
 * closes the call, so a case reads it as soon as the SDK promise that follows
 * that callback settles — the awaited `generateText`, `stream.usage`, a drained
 * aborted stream — with no wait of its own.
 */
const fakeSentry = () => {
    const spans: RecordedSpan[] = [];
    const captured: unknown[] = [];

    const record = (context: { attributes?: Record<string, unknown>; name: string; op?: string }, manual: boolean): [RecordedSpan, SentrySpan] => {
        const recorded: RecordedSpan = {
            attributes: { ...context.attributes },
            endedAt: undefined,
            manual,
            name: context.name,
            op: context.op,
            startedAt: Date.now(),
            status: undefined,
        };

        spans.push(recorded);

        return [
            recorded,
            {
                end: () => {
                    recorded.endedAt = Date.now();
                },
                setAttributes: (attributes) => Object.assign(recorded.attributes, attributes),
                setStatus: (status) => {
                    recorded.status = status;
                },
            },
        ];
    };

    const Sentry: SentryLike = {
        captureException: (exception) => {
            captured.push(exception);

            return undefined;
        },
        startSpan: (context, callback) => {
            const [recorded, span] = record(context, false);
            const result = callback(span);

            // The auto-finishing wrapper: end when the callback settles.
            finishWhenSettled(result, () => {
                recorded.endedAt = Date.now();
            });

            return result;
        },
        startSpanManual: (context, callback) => callback(record(context, true)[1]),
    };

    return { captured, Sentry, spans };
};

describe(sentryTelemetry, () => {
    it("measures a STREAMED call to the end of the stream, with its usage", async () => {
        // Only `Date` is faked: the model advances it 30 ms per delta, so a span
        // that runs to the end of the stream lasts exactly 3 x 30 ms.
        vi.useFakeTimers({ toFake: ["Date"] });
        onTestFinished(() => {
            vi.useRealTimers();
        });

        const { Sentry, spans } = fakeSentry();

        const stream = streamText({
            model: streamingModel({ chunks: 3, gapMs: 30 }),
            prompt: "hi",
            telemetry: withTelemetry(sentryTelemetry({ Sentry })),
        });

        await expect(drain(stream.textStream)).resolves.toBe("xxx");

        await stream.usage;

        const span = spans[0] as RecordedSpan;

        // The old shape wrapped `execute()`, which resolves the instant `doStream`
        // hands the stream back: the span measured ~1 ms of a ~100 ms call and
        // carried no token usage at all.
        expect(span.manual).toBe(true);
        expect(span.endedAt).toBeDefined();
        expect((span.endedAt as number) - span.startedAt).toBe(3 * 30);
        expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(12);
        expect(span.attributes["gen_ai.usage.output_tokens"]).toBe(3);
        expect(span.status?.code).toBe(1);
    });

    it("reports token usage on a non-streamed call through generateText", async () => {
        const { Sentry, spans } = fakeSentry();

        const result = await generateText({
            model: generatingModel(),
            prompt: "hi",
            telemetry: withTelemetry(sentryTelemetry({ functionId: "support", Sentry })),
        });

        expect(result.text).toBe("answer");

        const span = spans[0] as RecordedSpan;

        expect(span.name).toBe("support");
        expect(span.op).toBe("gen_ai.generate");
        expect(span.attributes["gen_ai.request.model"]).toBe("mock-model-id");
        expect(span.attributes["gen_ai.system"]).toBe("mock-provider");
        // Usage is read off the SDK's NORMALIZED end event; a LanguageModelV4
        // provider reports `{ inputTokens: { total } }`, which a flat reader over
        // the raw resolved value sees as no usage at all.
        expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(12);
        expect(span.attributes["gen_ai.usage.total_tokens"]).toBe(15);
        expect(span.attributes["lunora.usage.status"]).toBe("complete");
        // No breakdown was reported, so no bucket attribute is written at all.
        expect(span.attributes["gen_ai.usage.cache_read.input_tokens"]).toBeUndefined();
        expect(span.endedAt).toBeDefined();
    });

    it("carries the cache and reasoning buckets when the provider reports them", async () => {
        const { Sentry, spans } = fakeSentry();

        await generateText({
            model: new MockLanguageModelV4({
                doGenerate: (): Promise<GenerateResult> =>
                    Promise.resolve({
                        content: [{ text: "answer", type: "text" }],
                        finishReason: STOP,
                        usage: reportedUsage({ input: 12, output: 3, cacheRead: 4, cacheWrite: 2, reasoning: 2 }),
                        warnings: [],
                    }),
                modelId: "mock-model-id",
            }),
            prompt: "hi",
            telemetry: withTelemetry(sentryTelemetry({ functionId: "support", Sentry })),
        });

        const span = spans[0] as RecordedSpan;

        expect(span.attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(4);
        expect(span.attributes["gen_ai.usage.cache_creation.input_tokens"]).toBe(2);
        expect(span.attributes["gen_ai.usage.reasoning.output_tokens"]).toBe(2);
        expect(span.attributes["gen_ai.usage.output_tokens"]).toBe(3);
    });

    it("marks a stream that dies mid-way as failed", async () => {
        const { Sentry, spans } = fakeSentry();

        const stream = streamText({
            model: streamingModel({ chunks: 3, failAfter: 1 }),
            prompt: "hi",
            telemetry: withTelemetry(sentryTelemetry({ Sentry })),
        });

        await drain(stream.textStream);

        await expect(stream.finishReason).resolves.toBe("error");

        // `execute()` had already resolved successfully at first byte, so under the
        // old shape this failure never reached a span.
        expect((spans[0] as RecordedSpan).status?.code).toBe(2);
        expect((spans[0] as RecordedSpan).endedAt).toBeDefined();
    });

    it("marks the span errored when the provider call itself rejects", async () => {
        const { captured, Sentry, spans } = fakeSentry();

        await expect(
            generateText({
                maxRetries: 0,
                model: new MockLanguageModelV4({ doGenerate: () => Promise.reject(new Error("model down")) }),
                prompt: "hi",
                telemetry: withTelemetry(sentryTelemetry({ Sentry })),
            }),
        ).rejects.toThrow("model down");

        expect((spans[0] as RecordedSpan).status?.code).toBe(2);
        expect((spans[0] as RecordedSpan).endedAt).toBeDefined();
        // ai@7 dispatches `onError` as `{ callId, error }`; the ERROR is what Sentry
        // should capture, not the envelope.
        expect(captured[0]).toBeInstanceOf(Error);
        expect((captured[0] as Error).message).toBe("model down");
    });

    it("meters the usage a non-streamed attempt was billed before it failed, on an errored span", async () => {
        const { Sentry, spans } = fakeSentry();
        const agent = defineAgent({ model: failedGenerateModel(), telemetry: withTelemetry(sentryTelemetry({ Sentry })) });

        await expect(createAgentGenerate(agent, {})({ messages: [{ content: "hi", role: "user" }] })).rejects.toThrow("model finished with an error reason");

        expect((spans[0] as RecordedSpan).status?.code).toBe(2);
        expect((spans[0] as RecordedSpan).attributes["gen_ai.usage.input_tokens"]).toBe(2);
        expect((spans[0] as RecordedSpan).attributes["gen_ai.usage.output_tokens"]).toBe(1);
        expect((spans[0] as RecordedSpan).attributes["lunora.usage.status"]).toBe("complete");
    });

    it("meters the usage a streamed attempt that fails in-band was billed, on an errored span", async () => {
        const { Sentry, spans } = fakeSentry();
        const agent = defineAgent({ model: failedStreamModel(), telemetry: withTelemetry(sentryTelemetry({ Sentry })) });

        await expect(createStreamGenerate(agent, {})({ messages: [{ content: "hi", role: "user" }] }, () => undefined)).rejects.toThrow(
            "model finished with an error reason",
        );

        expect((spans[0] as RecordedSpan).status?.code).toBe(2);
        expect((spans[0] as RecordedSpan).attributes["gen_ai.usage.input_tokens"]).toBe(2);
        expect((spans[0] as RecordedSpan).attributes["gen_ai.usage.output_tokens"]).toBe(1);
    });

    it("an abort in one run does not close a concurrent run's span on a SHARED integration", async () => {
        const { Sentry, spans } = fakeSentry();
        // One integration instance, as `defineAgent({ telemetry: { integrations:
        // [sentryTelemetry(...)] } })` at module scope produces.
        const shared = sentryTelemetry({ Sentry });

        const abortController = new AbortController();
        const aborted = streamText({
            abortSignal: abortController.signal,
            model: streamingModel({ chunks: 20 }),
            prompt: "A",
            telemetry: withTelemetry(shared),
        });
        // The healthy call stays open until the sibling's abort has been handled,
        // so the abort always lands while it is in flight.
        const abortHandled = Promise.withResolvers<undefined>();
        const healthy = streamText({
            model: streamingModel({ chunks: 4, holdFinish: abortHandled.promise }),
            prompt: "B",
            telemetry: withTelemetry(shared),
        });

        await Promise.all([
            drain(aborted.textStream, (index) => {
                if (index === 2) {
                    abortController.abort();
                }
            }).finally(() => {
                // The SDK awaits `onAbort` before it closes the aborted stream.
                abortHandled.resolve(undefined);
            }),
            drain(healthy.textStream),
        ]);
        // The SDK awaits `onAbort` before it closes the aborted stream, so the drain
        // covers that run; the healthy call closes on its step end, which settles
        // before `finishReason` does.
        await healthy.finishReason;

        const modelSpans = spans.filter((span) => span.manual);

        expect(modelSpans).toHaveLength(2);
        expect(modelSpans.filter((span) => span.status?.code === 2)).toHaveLength(1);

        const ok = modelSpans.filter((span) => span.status?.code === 1);

        expect(ok).toHaveLength(1);
        expect((ok[0] as RecordedSpan).attributes["gen_ai.usage.input_tokens"]).toBe(12);
    });

    // A stream that dies via `controller.error()` dispatches no telemetry callback
    // at all, so nothing ever closes its entry. The registry sweeps those out on
    // the next `open` — but `startSpanManual` hands back a span that ends only
    // when someone ends it, so dropping the RECORD without ending the SPAN leaves
    // it open in the Sentry SDK for the life of the isolate.
    it("ends the span of an abandoned call when the registry sweeps it", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        // Never settles: the model call is opened and no terminal event follows.
        const pending = async (): Promise<never> =>
            new Promise(() => {
                // Intentionally never resolved.
            });

        try {
            const { Sentry, spans } = fakeSentry();
            const shared = sentryTelemetry({ Sentry });

            // Open a call and never deliver a terminal event for it.
            const opened = shared.executeLanguageModelCall?.(evt({ callId: "call-abandoned", execute: pending, modelId: "m", provider: "p" })) as
                | Promise<unknown>
                | undefined;

            opened?.catch(() => undefined);

            expect(spans.filter((span) => span.manual)).toHaveLength(1);

            // Past the abandoned-call cutoff, then open an unrelated call so the
            // sweep runs.
            vi.setSystemTime(Date.now() + 11 * 60 * 1000);

            const openedLater = shared.executeLanguageModelCall?.(evt({ callId: "call-later", execute: pending, modelId: "m", provider: "p" })) as
                | Promise<unknown>
                | undefined;

            openedLater?.catch(() => undefined);

            const swept = spans.find((span) => span.manual);

            expect(swept?.endedAt).toBeDefined();
            // Swept, not reported: it was never observed to succeed or fail.
            expect(swept?.status).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not record the prompt or the completion unless asked", async () => {
        const { Sentry, spans } = fakeSentry();

        await generateText({ model: generatingModel(), prompt: "SENSITIVE", telemetry: withTelemetry(sentryTelemetry({ Sentry })) });

        expect(JSON.stringify(spans)).not.toContain("SENSITIVE");
        expect((spans[0] as RecordedSpan).attributes).not.toHaveProperty("gen_ai.prompt");
        expect((spans[0] as RecordedSpan).attributes).not.toHaveProperty("gen_ai.completion");
    });

    it("records the prompt and the completion when both flags are set", async () => {
        const { Sentry, spans } = fakeSentry();

        await generateText({
            model: generatingModel(),
            prompt: "hello",
            telemetry: withTelemetry(sentryTelemetry({ recordInputs: true, recordOutputs: true, Sentry })),
        });

        expect(JSON.stringify((spans[0] as RecordedSpan).attributes["gen_ai.prompt"])).toContain("hello");
        // The normalized content, not the raw resolved value.
        expect((spans[0] as RecordedSpan).attributes["gen_ai.completion"]).toBe("answer");
    });

    it("wraps a tool execution in an auto-finished span and returns its result", async () => {
        const { Sentry, spans } = fakeSentry();

        const result = await sentryTelemetry({ Sentry }).executeTool?.({
            callId: "call-1",
            execute: () => Promise.resolve("tool-value"),
            toolCall: evt({ input: { q: "SENSITIVE" }, toolName: "lookup" }),
            toolCallId: "tc-1",
        });

        expect(result).toBe("tool-value");
        expect(spans).toHaveLength(1);
        expect(spans[0]?.manual).toBe(false);
        expect(spans[0]?.op).toBe("gen_ai.execute_tool");
        expect(spans[0]?.name).toBe("execute_tool lookup");
        expect(spans[0]?.attributes["gen_ai.tool.name"]).toBe("lookup");
        expect(JSON.stringify(spans)).not.toContain("SENSITIVE");
    });

    it("attaches tool input attributes when recordInputs is set", async () => {
        const { Sentry, spans } = fakeSentry();

        await sentryTelemetry({ recordInputs: true, Sentry }).executeTool?.({
            callId: "call-1",
            execute: () => Promise.resolve("ok"),
            toolCall: evt({ input: { q: "hello" }, toolName: "lookup" }),
            toolCallId: "tc-1",
        });

        expect(spans[0]?.attributes["gen_ai.tool.input"]).toStrictEqual({ q: "hello" });
    });

    it("routes a bare thrown value to captureException", () => {
        const { captured, Sentry } = fakeSentry();
        const error = new Error("kaboom");

        sentryTelemetry({ Sentry }).onError?.(error);

        expect(captured).toStrictEqual([error]);
    });

    it("passes the caller's Sentry namespace through (dependency injection)", async () => {
        const startSpan = vi.fn<(context: unknown, callback: (span: unknown) => unknown) => unknown>((_context, callback) =>
            callback({ end: () => undefined }),
        );
        const Sentry = { captureException: vi.fn<(error: unknown) => void>(), startSpan } as unknown as SentryLike;

        await sentryTelemetry({ Sentry }).executeTool?.({
            callId: "c",
            execute: () => Promise.resolve(1),
            toolCall: evt({ toolName: "t" }),
            toolCallId: "tc",
        });

        expect(startSpan).toHaveBeenCalledTimes(1);
    });
});
