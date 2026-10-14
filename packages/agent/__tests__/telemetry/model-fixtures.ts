import type { Telemetry } from "ai";
import { MockLanguageModelV4 } from "ai/test";

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

/** Wrap the integration under test in the `telemetry` option `generateText`/`streamText` accept. */
const withTelemetry = (integration: Telemetry): { integrations: Telemetry[]; isEnabled: true } => {
    return { integrations: [integration], isEnabled: true };
};

/** A non-streaming mock model whose `doGenerate` resolves after `delayMs`. */
const generatingModel = (extra: Partial<GenerateResult> = {}, delayMs = 0): MockLanguageModelV4 =>
    new MockLanguageModelV4({
        doGenerate: async (): Promise<GenerateResult> => {
            if (delayMs > 0) {
                await new Promise((resolve) => {
                    setTimeout(resolve, delayMs);
                });
            }

            return { content: [{ text: "answer", type: "text" }], finishReason: STOP, usage: usageOf(12, 3), warnings: [], ...extra };
        },
    });

/**
 * A streaming mock model that emits `chunks` deltas `gapMs` apart, then either
 * finishes or errors — the shape that separates "the provider call returned" from
 * "the model call is over".
 *
 * `failAfter` emits the protocol's in-band `{ type: "error" }` part, which is how
 * a v4 provider reports a stream that dies mid-way.
 */
const streamingModel = (options: { chunks: number; failAfter?: number; gapMs: number }): MockLanguageModelV4 =>
    new MockLanguageModelV4({
        doStream: async (): Promise<StreamResult> => {
            return {
                stream: new ReadableStream<StreamPart>({
                    async start(controller) {
                        controller.enqueue({ type: "stream-start", warnings: [] });
                        controller.enqueue({ id: "t", type: "text-start" });

                        for (let index = 0; index < options.chunks; index += 1) {
                            // eslint-disable-next-line no-await-in-loop -- the point is a stream whose parts arrive over time
                            await new Promise((resolve) => {
                                setTimeout(resolve, options.gapMs);
                            });

                            if (options.failAfter !== undefined && index === options.failAfter) {
                                controller.enqueue({ error: new Error("stream died"), type: "error" });
                                controller.close();

                                return;
                            }

                            controller.enqueue({ delta: "x", id: "t", type: "text-delta" });
                        }

                        controller.enqueue({ id: "t", type: "text-end" });
                        controller.enqueue({ finishReason: STOP, type: "finish", usage: usageOf(12, 3) });
                        controller.close();
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

/** Let a fire-and-forget export / detached span settle before reading what was captured. */
const settle = async (): Promise<void> => {
    await new Promise((resolve) => {
        setTimeout(resolve, 20);
    });
};

export type { GenerateResult };
export { drain, generatingModel, settle, STOP, streamingModel, usageOf, withTelemetry };
