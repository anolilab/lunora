import type { Telemetry } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { vi } from "vitest";

/**
 * Mock models and helpers for driving a telemetry integration through the REAL
 * `ai` SDK, shared by the otlp / sentry / braintrust bridge tests.
 *
 * Hand-invoking `executeLanguageModelCall` is what hid the streaming defect in
 * all three bridges for as long as it did: called directly, `execute()` resolves
 * with a finished result and the span looks perfect. Through `streamText`, the
 * SDK resolves the same promise the instant `doStream` hands the stream back —
 * before a token, before any usage, before any mid-stream failure — so a span
 * closed there reported every streamed turn as a ~1 ms, zero-token, always-OK
 * call. Every model-call case therefore goes through `generateText`/`streamText`.
 */

/**
 * The provider-level shapes, read off the mock model's own constructor config
 * rather than imported from the provider package, which is a transitive
 * dependency here and not a declared one.
 */
type MockConfig = NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>;
type GenerateResult = Awaited<ReturnType<Extract<MockConfig["doGenerate"], (...arguments_: never) => unknown>>>;
type StreamResult = Awaited<ReturnType<Extract<MockConfig["doStream"], (...arguments_: never) => unknown>>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const STOP: GenerateResult["finishReason"] = { raw: "stop", unified: "stop" };

/**
 * LanguageModelV4's NESTED token-usage shape, which is what the SDK normalizes
 * from. A provider reports `{ inputTokens: { total } }`, not a flat number — so a
 * flat reader run over the raw resolved value finds no usage at all.
 */
const usageOf = (input: number, output: number): GenerateResult["usage"] => {
    return {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: input, total: input },
        outputTokens: { reasoning: 0, text: output, total: output },
    };
};

/**
 * A V4 usage carrying exactly the counts given. An omitted field stays `undefined`
 * (unreported), never 0, so a test can tell an absent bucket from a counted zero.
 */
const reportedUsage = (counts: { cacheRead?: number; cacheWrite?: number; input?: number; output?: number; reasoning?: number }): GenerateResult["usage"] => {
    return {
        inputTokens: { cacheRead: counts.cacheRead, cacheWrite: counts.cacheWrite, noCache: undefined, total: counts.input },
        outputTokens: { reasoning: counts.reasoning, text: undefined, total: counts.output },
    };
};

/** Wrap the integration under test in the `telemetry` option `generateText`/`streamText` accept. */
const withTelemetry = (integration: Telemetry): { integrations: Telemetry[]; isEnabled: true } => {
    return { integrations: [integration], isEnabled: true };
};

/** A non-streaming mock model; `extra` overrides fields of the result `doGenerate` resolves with. */
const generatingModel = (extra: Partial<GenerateResult> = {}): MockLanguageModelV4 =>
    new MockLanguageModelV4({
        doGenerate: (): Promise<GenerateResult> =>
            Promise.resolve({ content: [{ text: "answer", type: "text" }], finishReason: STOP, usage: usageOf(12, 3), warnings: [], ...extra }),
    });

/**
 * A streaming mock model that emits `chunks` deltas, then either finishes or
 * errors — the shape that separates "the provider call returned" from "the model
 * call is over".
 *
 * `failAfter` emits the protocol's in-band `{ type: "error" }` part, which is how
 * a v4 provider reports a stream that dies mid-way.
 *
 * Parts are produced on demand, one per read, so the consumer drives the stream
 * rather than finding it queued whole. `gapMs` advances the faked clock before
 * each delta — a case that passes it fakes `Date` — so a span measured across
 * the stream lasts exactly `chunks x gapMs`. `holdFinish` keeps the call open
 * past its last delta until the test settles it.
 */
const streamingModel = (options: { chunks: number; failAfter?: number; gapMs?: number; holdFinish?: Promise<unknown> }): MockLanguageModelV4 =>
    new MockLanguageModelV4({
        doStream: async (): Promise<StreamResult> => {
            let index = 0;

            return {
                stream: new ReadableStream<StreamPart>({
                    async pull(controller) {
                        if (index === options.chunks) {
                            await options.holdFinish;

                            controller.enqueue({ id: "t", type: "text-end" });
                            controller.enqueue({ finishReason: STOP, type: "finish", usage: usageOf(12, 3) });
                            controller.close();

                            return;
                        }

                        if (options.gapMs !== undefined) {
                            vi.advanceTimersByTime(options.gapMs);
                        }

                        if (index === options.failAfter) {
                            controller.enqueue({ error: new Error("stream died"), type: "error" });
                            controller.close();

                            return;
                        }

                        index += 1;
                        controller.enqueue({ delta: "x", id: "t", type: "text-delta" });
                    },
                    start(controller) {
                        controller.enqueue({ type: "stream-start", warnings: [] });
                        controller.enqueue({ id: "t", type: "text-start" });
                    },
                }),
            };
        },
    });

/** Drain a text stream, swallowing the rejection an aborted one produces. */
const drain = async (textStream: AsyncIterable<string>, onDelta?: (index: number) => void): Promise<string> => {
    let text = "";
    let index = 0;

    try {
        for await (const delta of textStream) {
            text += delta;
            index += 1;
            onDelta?.(index);
        }
    } catch {
        // An aborted stream rejects its consumer; the span is what these tests assert.
    }

    return text;
};

/** The error finish a provider reports for an attempt it billed and then failed. */
const FAILED_FINISH = { raw: "length", unified: "error" } as const;

/** A non-streamed attempt that bills 2 input and 1 output tokens, then finishes with the error reason. */
const failedGenerateModel = (): MockLanguageModelV4 =>
    new MockLanguageModelV4({
        doGenerate: () => Promise.resolve({ content: [], finishReason: FAILED_FINISH, usage: reportedUsage({ input: 2, output: 1 }), warnings: [] }),
    });

/** The streamed counterpart: its only part is the error finish, carrying the same billed usage. */
const failedStreamModel = (): MockLanguageModelV4 =>
    new MockLanguageModelV4({
        doStream: () =>
            Promise.resolve({
                stream: simulateReadableStream({ chunks: [{ finishReason: FAILED_FINISH, type: "finish", usage: reportedUsage({ input: 2, output: 1 }) }] }),
            }),
    });

export type { GenerateResult };
export { drain, failedGenerateModel, failedStreamModel, generatingModel, reportedUsage, STOP, streamingModel, usageOf, withTelemetry };
