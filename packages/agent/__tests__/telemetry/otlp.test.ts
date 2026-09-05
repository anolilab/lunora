import type { Telemetry } from "ai";
import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { otlpTelemetry } from "../../src/telemetry/otlp";

/**
 * Every model-call case drives the REAL `ai` SDK against a mock model rather
 * than invoking the telemetry hooks by hand.
 *
 * Hand-invoking `executeLanguageModelCall` is what hid the streaming defect for
 * as long as it did: called directly, `execute()` resolves with a finished
 * result and the span looks perfect. Through `streamText`, the SDK resolves the
 * same promise the instant `doStream` hands the stream back — before a token,
 * before any usage, before any mid-stream failure — so a span closed there
 * reported every streamed turn as a ~1 ms, zero-token, always-OK call.
 */

interface CapturedPost {
    body: { resourceSpans: unknown[] };
    headers: Record<string, string>;
    url: string;
}

/** Stub the global `fetch`, recording each OTLP POST with its parsed JSON body. */
const captureFetch = (): CapturedPost[] => {
    const calls: CapturedPost[] = [];

    vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init: { body: string; headers: Record<string, string>; method: string }) => {
            calls.push({ body: JSON.parse(init.body) as CapturedPost["body"], headers: init.headers, url });

            return Promise.resolve(new Response(null, { status: 200 }));
        }),
    );

    return calls;
};

/** One captured OTLP span. */
interface CapturedSpan {
    attributes: { key: string; value: Record<string, unknown> }[];
    endTimeUnixNano: string;
    name: string;
    startTimeUnixNano: string;
    status: { code: number };
    traceId: string;
}

/** The single span in a captured OTLP trace body. */
const spanOf = (post: CapturedPost): CapturedSpan => {
    const resource = post.body.resourceSpans[0] as { scopeSpans: { spans: unknown[] }[] };

    return resource.scopeSpans[0]?.spans[0] as CapturedSpan;
};

/** Read one attribute's scalar value off a span by key. */
const attribute = (span: CapturedSpan, key: string): unknown => {
    const found = span.attributes.find((entry) => entry.key === key);

    if (!found) {
        return undefined;
    }

    return Object.values(found.value)[0];
};

/** A span's wall-clock duration in milliseconds, from the OTLP nanosecond stamps. */
const durationMs = (span: CapturedSpan): number => (Number(span.endTimeUnixNano) - Number(span.startTimeUnixNano)) / 1e6;

// A fixed 32-hex trace id used to assert span grouping. Not a credential — the
// `no-secrets` heuristic just sees a high-entropy hex run.
// eslint-disable-next-line no-secrets/no-secrets -- fake test trace id, not a real secret
const FIXED_TRACE_ID = "0123456789abcdef0123456789abcdef";

/**
 * The provider-level shapes, read off the mock model's own constructor config
 * rather than imported from the provider package, which is a transitive
 * dependency here and not a declared one.
 */
type MockConfig = NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>;
type GenerateResult = Awaited<ReturnType<Extract<MockConfig["doGenerate"], (...arguments_: never) => unknown>>>;
type StreamResult = Awaited<ReturnType<Extract<MockConfig["doStream"], (...arguments_: never) => unknown>>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

/**
 * LanguageModelV4's NESTED token-usage shape, which is what the SDK normalizes
 * from. A provider reports `{ inputTokens: { total } }`, not a flat number — so
 * the flat reader that used to run over the raw resolved value found no usage at
 * all against a real provider.
 */
const STOP: GenerateResult["finishReason"] = { raw: "stop", unified: "stop" };

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
                                // The protocol's in-band failure part — how a v4
                                // provider reports a stream that dies mid-way.
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

/** Let the fire-and-forget export settle before reading the captured POSTs. */
const settle = async (): Promise<void> => {
    await new Promise((resolve) => {
        setTimeout(resolve, 20);
    });
};

describe(otlpTelemetry, () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("emits a language-model span with model + token attributes through generateText", async () => {
        const calls = captureFetch();

        const result = await generateText({
            model: generatingModel(),
            prompt: "hi",
            telemetry: withTelemetry(otlpTelemetry({ endpoint: "https://collector.test/", token: "ingest-key" })),
        });

        await settle();

        expect(result.text).toBe("answer");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe("https://collector.test/v1/traces");
        expect(calls[0]?.headers.authorization).toBe("Bearer ingest-key");

        const span = spanOf(calls[0] as CapturedPost);

        expect(span.name).toBe("chat mock-model-id");
        expect(span.status.code).toBe(1);
        expect(attribute(span, "gen_ai.request.model")).toBe("mock-model-id");
        expect(attribute(span, "gen_ai.system")).toBe("mock-provider");
        // Usage is read off the SDK's NORMALIZED end event, not off the raw value
        // the provider call resolved with — a LanguageModelV4 provider reports
        // `{ inputTokens: { total } }`, which the flat reader saw as no usage at all.
        // OTLP encodes int64 as a decimal string (proto3 JSON).
        expect(attribute(span, "gen_ai.usage.input_tokens")).toBe("12");
        expect(attribute(span, "gen_ai.usage.output_tokens")).toBe("3");
    });

    it("measures a STREAMED call to the end of the stream, with its usage", async () => {
        const calls = captureFetch();

        const started = Date.now();
        const stream = streamText({
            model: streamingModel({ chunks: 3, gapMs: 30 }),
            prompt: "hi",
            telemetry: withTelemetry(otlpTelemetry({ endpoint: "https://collector.test" })),
        });

        let text = "";

        for await (const delta of stream.textStream) {
            text += delta;
        }

        await stream.usage;
        await settle();

        const wallMs = Date.now() - started;
        const span = spanOf(calls[0] as CapturedPost);

        expect(text).toBe("xxx");
        // `execute()` resolves the moment `doStream` returns, so a span closed
        // there measured ~1 ms of a ~100 ms call and reported no tokens at all.
        expect(durationMs(span)).toBeGreaterThan(wallMs / 2);
        expect(attribute(span, "gen_ai.usage.input_tokens")).toBe("12");
        expect(attribute(span, "gen_ai.usage.output_tokens")).toBe("3");
    });

    it("marks a stream that dies mid-way as failed", async () => {
        expect.assertions(3);

        const calls = captureFetch();

        const stream = streamText({
            model: streamingModel({ chunks: 3, failAfter: 1, gapMs: 5 }),
            prompt: "hi",
            telemetry: withTelemetry(otlpTelemetry({ endpoint: "https://collector.test" })),
        });

        // The error arrives as a stream part, so the text stream ends rather than
        // throwing; `finishReason` is what carries the failure.
        let drained = 0;

        for await (const delta of stream.textStream) {
            drained += delta.length;
        }

        expect(drained).toBeGreaterThan(0);

        await expect(stream.finishReason).resolves.toBe("error");

        await settle();

        // The old shape reported status 1 for this: `execute()` had already
        // resolved successfully at first byte, so the failure never reached a span.
        expect(spanOf(calls[0] as CapturedPost).status.code).toBe(2);
    });

    it("marks the span errored when the provider call itself rejects", async () => {
        const calls = captureFetch();

        await expect(
            generateText({
                model: new MockLanguageModelV4({ doGenerate: () => Promise.reject(new Error("model down")) }),
                maxRetries: 0,
                prompt: "hi",
                telemetry: withTelemetry(otlpTelemetry({ endpoint: "https://collector.test" })),
            }),
        ).rejects.toThrow("model down");

        await settle();

        expect(spanOf(calls[0] as CapturedPost).status.code).toBe(2);
    });

    it("tags the generation span with gen_ai.conversation.id when a conversation id is set", async () => {
        const calls = captureFetch();

        await generateText({
            model: generatingModel(),
            prompt: "hi",
            telemetry: withTelemetry(otlpTelemetry({ conversationId: "thread-42", endpoint: "https://collector.test" })),
        });
        await settle();

        expect(attribute(spanOf(calls[0] as CapturedPost), "gen_ai.conversation.id")).toBe("thread-42");
    });

    it("omits gen_ai.conversation.id when no conversation id is set", async () => {
        const calls = captureFetch();

        await generateText({ model: generatingModel(), prompt: "hi", telemetry: withTelemetry(otlpTelemetry({ endpoint: "https://collector.test" })) });
        await settle();

        expect(attribute(spanOf(calls[0] as CapturedPost), "gen_ai.conversation.id")).toBeUndefined();
    });

    it("groups every span under a shared traceId when one is given", async () => {
        const calls = captureFetch();
        const telemetry = otlpTelemetry({ endpoint: "https://collector.test", traceId: FIXED_TRACE_ID });

        await generateText({ model: generatingModel(), prompt: "hi", telemetry: withTelemetry(telemetry) });
        await telemetry.executeTool?.({ callId: "c-1", execute: () => Promise.resolve("ok"), toolCallId: "tc-1" });
        await settle();

        expect(calls.map((post) => spanOf(post).traceId)).toStrictEqual([FIXED_TRACE_ID, FIXED_TRACE_ID]);
    });

    it("does not record the prompt unless recordInputs is set", async () => {
        const calls = captureFetch();

        await generateText({
            model: generatingModel(),
            prompt: "SENSITIVE",
            telemetry: withTelemetry(otlpTelemetry({ endpoint: "https://collector.test" })),
        });
        await settle();

        expect(JSON.stringify(calls)).not.toContain("SENSITIVE");
        expect(attribute(spanOf(calls[0] as CapturedPost), "gen_ai.prompt")).toBeUndefined();
    });

    it("records the prompt as a serialized attribute when recordInputs is set", async () => {
        const calls = captureFetch();

        await generateText({
            model: generatingModel(),
            prompt: "hello",
            telemetry: withTelemetry(otlpTelemetry({ endpoint: "https://collector.test", recordInputs: true })),
        });
        await settle();

        expect(attribute(spanOf(calls[0] as CapturedPost), "gen_ai.prompt")).toContain("hello");
    });

    it("attaches AI Gateway cost/cache/log-id from providerMetadata when present", async () => {
        const calls = captureFetch();

        await generateText({
            model: generatingModel({ providerMetadata: { gateway: { cached: false, cost: 0.000_123, logId: "aig-log-42" } } }),
            prompt: "hi",
            telemetry: withTelemetry(otlpTelemetry({ endpoint: "https://collector.test" })),
        });
        await settle();

        const span = spanOf(calls[0] as CapturedPost);

        // Fractional USD cost is a double — encoded as a JSON number, not a string.
        expect(attribute(span, "gen_ai.usage.cost")).toBe(0.000_123);
        expect(attribute(span, "gen_ai.response.cached")).toBe(false);
        expect(attribute(span, "cf.aig.log_id")).toBe("aig-log-42");
    });

    it("derives cached + log-id from the gateway's cf-aig-* response headers", async () => {
        const calls = captureFetch();

        await generateText({
            model: generatingModel({ response: { headers: { "cf-aig-cache-status": "HIT", "cf-aig-log-id": "aig-log-7" } } }),
            prompt: "hi",
            telemetry: withTelemetry(otlpTelemetry({ endpoint: "https://collector.test" })),
        });
        await settle();

        const span = spanOf(calls[0] as CapturedPost);

        // The headers ride the value `execute()` resolved with and nowhere else, so
        // this is what pins the wrapper's result being kept alongside the end event.
        expect(attribute(span, "gen_ai.response.cached")).toBe(true);
        expect(attribute(span, "cf.aig.log_id")).toBe("aig-log-7");
    });

    it("estimates the cost from token usage when no gateway reported one", async () => {
        const calls = captureFetch();

        await generateText({
            model: new MockLanguageModelV4({
                doGenerate: (): Promise<GenerateResult> =>
                    Promise.resolve({
                        content: [{ text: "answer", type: "text" }],
                        finishReason: STOP,
                        usage: usageOf(1_000_000, 0),
                        warnings: [],
                    }),
                modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            }),
            prompt: "hi",
            telemetry: withTelemetry(otlpTelemetry({ endpoint: "https://collector.test" })),
        });
        await settle();

        const span = spanOf(calls[0] as CapturedPost);

        // Without this the chat/generation path — the one every agent runs — emitted
        // no cost at all unless an AI Gateway happened to report one.
        expect(attribute(span, "gen_ai.usage.cost")).toBeGreaterThan(0);
        // An estimate is never presented as a measurement.
        expect(attribute(span, "lunora.usage.cost.source")).toBe("estimated");
    });

    it("prefers a gateway-reported cost over the estimate and says so", async () => {
        const calls = captureFetch();

        await generateText({
            model: new MockLanguageModelV4({
                doGenerate: (): Promise<GenerateResult> =>
                    Promise.resolve({
                        content: [{ text: "answer", type: "text" }],
                        finishReason: STOP,
                        providerMetadata: { gateway: { cost: 0.5 } },
                        usage: usageOf(1_000_000, 0),
                        warnings: [],
                    }),
                modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            }),
            prompt: "hi",
            telemetry: withTelemetry(otlpTelemetry({ endpoint: "https://collector.test" })),
        });
        await settle();

        const span = spanOf(calls[0] as CapturedPost);

        expect(attribute(span, "gen_ai.usage.cost")).toBe(0.5);
        expect(attribute(span, "lunora.usage.cost.source")).toBe("provider");
    });

    it("emits no gateway attributes when the call did not route through a gateway", async () => {
        const calls = captureFetch();

        await generateText({ model: generatingModel(), prompt: "hi", telemetry: withTelemetry(otlpTelemetry({ endpoint: "https://collector.test" })) });
        await settle();

        const span = spanOf(calls[0] as CapturedPost);

        expect(attribute(span, "gen_ai.response.cached")).toBeUndefined();
        expect(attribute(span, "cf.aig.log_id")).toBeUndefined();
    });

    it("emits a tool-execution span named from the tool", async () => {
        const calls = captureFetch();

        const result = await otlpTelemetry({ endpoint: "https://collector.test" }).executeTool?.({
            callId: "c-1",
            execute: () => Promise.resolve("tool-value"),
            toolCall: { dynamic: true, input: {}, toolCallId: "tc-1", toolName: "lookup", type: "tool-call" },
            toolCallId: "tc-1",
        });

        await settle();

        expect(result).toBe("tool-value");

        const span = spanOf(calls[0] as CapturedPost);

        expect(span.name).toBe("execute_tool lookup");
        expect(attribute(span, "gen_ai.tool.name")).toBe("lookup");
    });
});
