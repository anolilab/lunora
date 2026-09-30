import { generateText, streamText } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import createAi from "../src/create-ai";
import { AI_GATEWAY_ACCOUNT_ID_ENV, AI_GATEWAY_ID_ENV, AI_PROXY_TOKEN_ENV, AI_PROXY_URL_ENV } from "../src/gateway";
import type { AiBindingLike, AiSpan, AiTelemetry, AiTracer } from "../src/types";

type RunCall = [string, Record<string, unknown>, Record<string, unknown> | undefined];

/** An OpenAI chat-completions body, which is what the gateway run path returns for `openai/…`. */
const chatCompletion = (text: string): Record<string, unknown> => {
    return {
        choices: [{ finish_reason: "stop", index: 0, message: { content: text, role: "assistant" } }],
        created: 1,
        id: "chatcmpl-1",
        model: "gpt-5",
        object: "chat.completion",
        usage: { completion_tokens: 5, prompt_tokens: 12, total_tokens: 17 },
    };
};

/** An Anthropic Messages body — the gateway passes Anthropic through in its native format. */
const anthropicMessage = (text: string): Record<string, unknown> => {
    return {
        content: [{ text, type: "text" }],
        id: "msg_1",
        model: "claude-sonnet-5",
        role: "assistant",
        stop_reason: "end_turn",
        type: "message",
        usage: { input_tokens: 12, output_tokens: 5 },
    };
};

/**
 * A fake `env.AI` binding. `@cf/…` calls get a Workers AI shaped result; any other
 * id is a gateway catalog call on the run path, which asks for the raw upstream
 * response (`returnRawResponse`) and gets an OpenAI chat completion back.
 */
const fakeBinding = (): AiBindingLike & { runCalls: RunCall[] } => {
    const runCalls: RunCall[] = [];

    return {
        run: async (model, inputs, options) => {
            runCalls.push([model, inputs, options]);

            if (options?.returnRawResponse === true) {
                return Response.json(model.startsWith("anthropic/") ? anthropicMessage(`hello from ${model}`) : chatCompletion(`hello from ${model}`));
            }

            return { response: `ran ${model}`, usage: { completion_tokens: 3, prompt_tokens: 7 } };
        },
        runCalls,
    };
};

interface RecordedSpan {
    attributes: Record<string, unknown>;
    name: string;
    /** How the span's body ended; absent while it is still open. */
    settled?: "error" | "ok";
}

/** A tracer + metrics double that records what usage accounting reports. */
const fakeTelemetry = (): AiTelemetry & { counts: [string, number | undefined, Record<string, unknown> | undefined][]; spans: RecordedSpan[] } => {
    const spans: RecordedSpan[] = [];
    const counts: [string, number | undefined, Record<string, unknown> | undefined][] = [];

    const trace: AiTracer = async (name, function_, attributes) => {
        const recorded: RecordedSpan = { attributes: { ...attributes }, name };
        const span: AiSpan = {
            setAttribute: (key, value) => {
                recorded.attributes[key] = value;
            },
            setAttributes: (fields) => {
                Object.assign(recorded.attributes, fields);
            },
        };

        spans.push(recorded);

        try {
            const result = await function_(trace, span);

            recorded.settled = "ok";

            return result;
        } catch (error) {
            recorded.settled = "error";

            throw error;
        }
    };

    return {
        counts,
        metrics: {
            count: (name, value, attributes) => {
                counts.push([name, value, attributes]);
            },
        },
        spans,
        trace,
    };
};

const usage = {
    inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: undefined, total: 1000 },
    outputTokens: { reasoning: undefined, text: undefined, total: 500 },
};

describe("self-hosted proxy", () => {
    it("sends a slug to LUNORA_AI_PROXY_URL as an OpenAI chat completion, with no binding", async () => {
        expect.assertions(4);

        const fetchMock = vi.fn<typeof fetch>(async () => Response.json(chatCompletion("hello from proxy")));

        vi.stubGlobal("fetch", fetchMock);

        try {
            const ai = createAi({ env: { [AI_PROXY_TOKEN_ENV]: "secret", [AI_PROXY_URL_ENV]: "https://ai-proxy.test/v1" } });
            const { text } = await generateText({ model: ai.model("anthropic/claude-sonnet-5"), prompt: "hi" });

            expect(text).toBe("hello from proxy");

            const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(url).toBe("https://ai-proxy.test/v1/chat/completions");
            expect(JSON.parse(init.body as string)).toMatchObject({ model: "anthropic/claude-sonnet-5" });
            expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("refuses to send a proxy token over plain HTTP off loopback", () => {
        expect.assertions(2);

        const token = { [AI_PROXY_TOKEN_ENV]: "secret" };
        const remote = createAi({ env: { ...token, [AI_PROXY_URL_ENV]: "http://ai-proxy.test/v1" } });
        const loopback = createAi({ env: { ...token, [AI_PROXY_URL_ENV]: "http://127.0.0.1:4000/v1" } });

        expect(() => remote.model("openai/gpt-5")).toThrow(/not HTTPS/);
        expect(() => loopback.model("openai/gpt-5")).not.toThrow();
    });

    it("rejects a Workers AI id when only a proxy is configured", () => {
        expect.assertions(1);

        const ai = createAi({ env: { [AI_PROXY_URL_ENV]: "https://ai-proxy.test/v1" } });

        expect(() => ai.model("@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toThrow(/binding/);
    });
});

describe("gateway catalog models", () => {
    it("routes a `<provider>/<model>` slug through the account's default gateway over the binding", async () => {
        expect.assertions(4);

        const binding = fakeBinding();
        const ai = createAi({ binding, metadata: { functionPath: "chat:send", traceId: "a".repeat(32) } });

        const { text } = await generateText({ model: ai.model("openai/gpt-5"), prompt: "hi" });

        expect(text).toBe("hello from openai/gpt-5");
        expect(binding.runCalls).toHaveLength(1);

        const [model, , options] = binding.runCalls[0] as RunCall;

        expect(model).toBe("openai/gpt-5");
        // No LUNORA_AI_GATEWAY_ID → the account's auto-created `default` gateway,
        // still carrying the function + trace correlation.
        expect(options?.gateway).toStrictEqual({ id: "default", metadata: { functionPath: "chat:send", traceId: "a".repeat(32) } });
    });

    it("parses an `anthropic/…` slug in Anthropic's native wire format", async () => {
        expect.assertions(2);

        const binding = fakeBinding();
        const { text } = await generateText({ model: createAi({ binding }).model("anthropic/claude-sonnet-5"), prompt: "hi" });

        expect(text).toBe("hello from anthropic/claude-sonnet-5");
        expect((binding.runCalls[0] as RunCall)[0]).toBe("anthropic/claude-sonnet-5");
    });

    it("selects the gateway by LUNORA_AI_GATEWAY_ID alone on the binding path", async () => {
        expect.assertions(1);

        const binding = fakeBinding();
        const ai = createAi({ binding, env: { [AI_GATEWAY_ID_ENV]: "my-gateway" } });

        await generateText({ model: ai.model("openai/gpt-5"), prompt: "hi" });

        expect((binding.runCalls[0] as RunCall)[2]?.gateway).toMatchObject({ id: "my-gateway" });
    });

    it("adds no per-call metadata on top of an explicit gateway's own", async () => {
        expect.assertions(1);

        const binding = fakeBinding();
        const metadata = { a: "1", b: "2", c: "3", d: "4", e: "5" };
        const ai = createAi({ binding, gateway: { id: "g", metadata }, metadata: { functionPath: "chat:send", traceId: "a".repeat(32) } });

        await generateText({ model: ai.model("openai/gpt-5"), prompt: "hi" });

        expect((binding.runCalls[0] as RunCall)[2]?.gateway).toStrictEqual({ id: "g", metadata });
    });

    it("uses the configured gateway for slugs when LUNORA_AI_GATEWAY_ID is set", async () => {
        expect.assertions(1);

        const binding = fakeBinding();
        const ai = createAi({ binding, env: { [AI_GATEWAY_ACCOUNT_ID_ENV]: "acct", [AI_GATEWAY_ID_ENV]: "my-gateway" } });

        await generateText({ model: ai.model("openai/gpt-5"), prompt: "hi" });

        expect((binding.runCalls[0] as RunCall)[2]?.gateway).toMatchObject({ id: "my-gateway" });
    });

    it("keeps `@cf/…` ids on Workers AI", async () => {
        expect.assertions(2);

        const binding = fakeBinding();
        const ai = createAi({ binding });

        const { text } = await generateText({ model: ai.model("@cf/meta/llama-3.1-8b-instruct"), prompt: "hi" });

        expect(text).toBe("ran @cf/meta/llama-3.1-8b-instruct");
        expect((binding.runCalls[0] as RunCall)[2]?.returnRawResponse).toBeUndefined();
    });
});

describe("usage telemetry", () => {
    it("records a span and token/cost counters for a generate call", async () => {
        expect.assertions(3);

        const telemetry = fakeTelemetry();
        const ai = createAi({ binding: fakeBinding(), telemetry });
        const model = new MockLanguageModelV4({
            doGenerate: async () => {
                return { content: [{ text: "ok", type: "text" as const }], finishReason: { raw: "stop", unified: "stop" as const }, usage, warnings: [] };
            },
            modelId: "gpt-4o-mini",
        });

        await generateText({ model: ai.model(model), prompt: "hi" });

        // gpt-4o-mini: $0.15 / $0.60 per million → 1000 in + 500 out = $0.00045.
        const cost = (1000 * 0.15 + 500 * 0.6) / 1_000_000;

        expect(telemetry.spans).toStrictEqual([
            {
                attributes: {
                    "gen_ai.operation.name": "chat",
                    "gen_ai.request.model": "gpt-4o-mini",
                    "gen_ai.usage.cost": cost,
                    "gen_ai.usage.input_tokens": 1000,
                    "gen_ai.usage.output_tokens": 500,
                    "lunora.usage.cost.source": "estimated",
                },
                name: "ai.generate",
                settled: "ok",
            },
        ]);
        expect(telemetry.counts).toContainEqual(["gen_ai.usage.input_tokens", 1000, { "gen_ai.request.model": "gpt-4o-mini" }]);
        expect(telemetry.counts).toContainEqual([
            "gen_ai.usage.cost",
            cost,
            { "gen_ai.request.model": "gpt-4o-mini", "lunora.usage.cost.source": "estimated" },
        ]);
    });

    it("prefers a gateway-reported cost and attributes spend to the requested slug", async () => {
        expect.assertions(1);

        const telemetry = fakeTelemetry();
        const ai = createAi({ binding: fakeBinding(), telemetry });

        await generateText({ model: ai.model("openai/gpt-5"), prompt: "hi" });

        // The fake gateway reports no cost, so gpt-5 is estimated — but grouped
        // under the id the caller asked for, not the provider's internal id.
        expect(telemetry.counts.map(([name, , attributes]) => [name, attributes?.["gen_ai.request.model"]])).toStrictEqual([
            ["gen_ai.usage.input_tokens", "openai/gpt-5"],
            ["gen_ai.usage.output_tokens", "openai/gpt-5"],
            ["gen_ai.usage.cost", "openai/gpt-5"],
        ]);
    });

    it("uses a provider-reported cost over the estimate", async () => {
        expect.assertions(1);

        const telemetry = fakeTelemetry();
        const ai = createAi({ binding: fakeBinding(), telemetry });
        const model = new MockLanguageModelV4({
            doGenerate: async () => {
                return {
                    content: [{ text: "ok", type: "text" as const }],
                    finishReason: { raw: "stop", unified: "stop" as const },
                    providerMetadata: { gateway: { cost: 0.0123 } },
                    usage,
                    warnings: [],
                };
            },
            modelId: "gpt-4o-mini",
        });

        await generateText({ model: ai.model(model), prompt: "hi" });

        expect(telemetry.spans[0]?.attributes).toMatchObject({ "gen_ai.usage.cost": 0.0123, "lunora.usage.cost.source": "provider" });
    });

    it("keeps a stream's span open until the stream finishes", async () => {
        expect.assertions(3);

        const telemetry = fakeTelemetry();
        const ai = createAi({ binding: fakeBinding(), telemetry });
        const model = new MockLanguageModelV4({
            doStream: async () => {
                return {
                    stream: convertArrayToReadableStream([
                        { id: "t", type: "text-start" as const },
                        { delta: "hel", id: "t", type: "text-delta" as const },
                        { delta: "lo", id: "t", type: "text-delta" as const },
                        { id: "t", type: "text-end" as const },
                        { finishReason: { raw: "stop", unified: "stop" as const }, type: "finish" as const, usage },
                    ]),
                };
            },
            modelId: "gpt-4o-mini",
        });

        const result = streamText({ model: ai.model(model), prompt: "hi" });

        await expect(result.text).resolves.toBe("hello");
        expect(telemetry.spans[0]?.name).toBe("ai.stream");
        expect(telemetry.spans[0]?.attributes).toMatchObject({ "gen_ai.usage.input_tokens": 1000, "gen_ai.usage.output_tokens": 500 });
    });

    it("closes a stream's span when the consumer cancels it", async () => {
        expect.assertions(1);

        const telemetry = fakeTelemetry();
        const model = new MockLanguageModelV4({
            doStream: async () => {
                return { stream: new ReadableStream({ pull: () => new Promise(() => {}) }) };
            },
            modelId: "gpt-4o-mini",
        });
        const wrapped = createAi({ binding: fakeBinding(), telemetry }).model(model) as MockLanguageModelV4;
        const { stream } = await wrapped.doStream({ prompt: [] });

        await stream.cancel("client went away");

        await vi.waitFor(() => {
            expect(telemetry.spans[0]?.settled).toBe("ok");
        });
    });

    it("fails a stream's span when the upstream stream errors", async () => {
        expect.assertions(2);

        const telemetry = fakeTelemetry();
        const model = new MockLanguageModelV4({
            doStream: async () => {
                return {
                    stream: new ReadableStream({
                        pull: (controller) => {
                            controller.error(new Error("upstream reset"));
                        },
                    }),
                };
            },
            modelId: "gpt-4o-mini",
        });
        const wrapped = createAi({ binding: fakeBinding(), telemetry }).model(model) as MockLanguageModelV4;
        const { stream } = await wrapped.doStream({ prompt: [] });

        await expect(stream.getReader().read()).rejects.toThrow("upstream reset");

        await vi.waitFor(() => {
            expect(telemetry.spans[0]?.settled).toBe("error");
        });
    });

    it("returns models unwrapped when no telemetry is configured", () => {
        expect.assertions(1);

        const model = new MockLanguageModelV4({ modelId: "m" });

        expect(createAi({ binding: fakeBinding() }).model(model)).toBe(model);
    });
});
