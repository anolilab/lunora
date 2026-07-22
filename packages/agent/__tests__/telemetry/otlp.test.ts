import { afterEach, describe, expect, it, vi } from "vitest";

import { otlpTelemetry } from "../../src/telemetry/otlp";

/**
 * The ai@7 telemetry event shapes are broad and churn across patch releases;
 * `evt` widens a minimal fixture to the callback's event type without
 * fabricating (and maintaining) every unrelated field.
 */
const evt = (fixture: Record<string, unknown>): never => fixture as unknown as never;

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

/** The single span in a captured OTLP trace body. */
const spanOf = (post: CapturedPost): { attributes: { key: string; value: Record<string, unknown> }[]; name: string; status: { code: number } } => {
    const resource = post.body.resourceSpans[0] as { scopeSpans: { spans: unknown[] }[] };

    return resource.scopeSpans[0]?.spans[0] as { attributes: { key: string; value: Record<string, unknown> }[]; name: string; status: { code: number } };
};

/** Read one attribute's scalar value off a span by key. */
const attribute = (span: ReturnType<typeof spanOf>, key: string): unknown => {
    const found = span.attributes.find((entry) => entry.key === key);

    if (!found) {
        return undefined;
    }

    return Object.values(found.value)[0];
};

// A fixed 32-hex trace id used to assert span grouping. Not a credential — the
// `no-secrets` heuristic just sees a high-entropy hex run.
// eslint-disable-next-line no-secrets/no-secrets -- fake test trace id, not a real secret
const FIXED_TRACE_ID = "0123456789abcdef0123456789abcdef";

describe(otlpTelemetry, () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("emits a language-model span with model + token attributes and returns the result", async () => {
        const calls = captureFetch();
        const telemetry = otlpTelemetry({ endpoint: "https://collector.test/", token: "ingest-key" });

        const result = await telemetry.executeLanguageModelCall?.(
            evt({
                execute: () => Promise.resolve({ content: [{ text: "answer", type: "text" }], usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } }),
                modelId: "@cf/meta/llama",
                provider: "workers-ai",
            }),
        );

        expect(result).toStrictEqual({ content: [{ text: "answer", type: "text" }], usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe("https://collector.test/v1/traces");
        expect(calls[0]?.headers.authorization).toBe("Bearer ingest-key");

        const span = spanOf(calls[0] as CapturedPost);

        expect(span.name).toBe("chat @cf/meta/llama");
        expect(span.status.code).toBe(1);
        expect(attribute(span, "gen_ai.request.model")).toBe("@cf/meta/llama");
        expect(attribute(span, "gen_ai.system")).toBe("workers-ai");
        // OTLP encodes int64 as a decimal string (proto3 JSON) — this is the wire
        // form the cloud decoder parses back to a number.
        expect(attribute(span, "gen_ai.usage.input_tokens")).toBe("12");
        expect(attribute(span, "gen_ai.usage.output_tokens")).toBe("3");
    });

    it("tags the generation span with gen_ai.conversation.id when a conversation id is set", async () => {
        const calls = captureFetch();

        await otlpTelemetry({ conversationId: "thread-42", endpoint: "https://collector.test" }).executeLanguageModelCall?.(
            evt({ execute: () => Promise.resolve({}), modelId: "m" }),
        );

        expect(attribute(spanOf(calls[0] as CapturedPost), "gen_ai.conversation.id")).toBe("thread-42");
    });

    it("omits gen_ai.conversation.id when no conversation id is set", async () => {
        const calls = captureFetch();

        await otlpTelemetry({ endpoint: "https://collector.test" }).executeLanguageModelCall?.(evt({ execute: () => Promise.resolve({}), modelId: "m" }));

        expect(attribute(spanOf(calls[0] as CapturedPost), "gen_ai.conversation.id")).toBeUndefined();
    });

    it("groups every span under a shared traceId when one is given", async () => {
        const calls = captureFetch();
        const telemetry = otlpTelemetry({ endpoint: "https://collector.test", traceId: FIXED_TRACE_ID });

        await telemetry.executeLanguageModelCall?.(evt({ execute: () => Promise.resolve({}), modelId: "m" }));
        await telemetry.executeTool?.(evt({ execute: () => Promise.resolve("ok"), toolCall: { toolName: "lookup" }, toolCallId: "tc-1" }));

        const traceIds = calls.map(
            (post) => (post.body.resourceSpans[0] as { scopeSpans: { spans: { traceId: string }[] }[] }).scopeSpans[0]?.spans[0]?.traceId,
        );

        expect(traceIds).toStrictEqual([FIXED_TRACE_ID, FIXED_TRACE_ID]);
    });

    it("does not record the prompt unless recordInputs is set", async () => {
        const calls = captureFetch();

        await otlpTelemetry({ endpoint: "https://collector.test" }).executeLanguageModelCall?.(
            evt({ execute: () => Promise.resolve({}), messages: [{ content: "SENSITIVE", role: "user" }], modelId: "m" }),
        );

        expect(JSON.stringify(calls)).not.toContain("SENSITIVE");
        expect(attribute(spanOf(calls[0] as CapturedPost), "gen_ai.prompt")).toBeUndefined();
    });

    it("records the prompt as a serialized attribute when recordInputs is set", async () => {
        const calls = captureFetch();

        await otlpTelemetry({ endpoint: "https://collector.test", recordInputs: true }).executeLanguageModelCall?.(
            evt({ execute: () => Promise.resolve({}), messages: [{ content: "hello", role: "user" }], modelId: "m" }),
        );

        expect(attribute(spanOf(calls[0] as CapturedPost), "gen_ai.prompt")).toContain("hello");
    });

    it("marks the span errored and re-throws when the model call throws", async () => {
        const calls = captureFetch();

        await expect(
            otlpTelemetry({ endpoint: "https://collector.test" }).executeLanguageModelCall?.(
                evt({
                    execute: () => Promise.reject(new Error("model down")),
                    modelId: "m",
                }),
            ),
        ).rejects.toThrow("model down");

        const span = spanOf(calls[0] as CapturedPost);

        expect(span.status.code).toBe(2);
    });

    it("attaches AI Gateway cost/cache/log-id from providerMetadata when present", async () => {
        const calls = captureFetch();

        await otlpTelemetry({ endpoint: "https://collector.test" }).executeLanguageModelCall?.(
            evt({
                execute: () =>
                    Promise.resolve({
                        providerMetadata: { gateway: { cached: false, cost: 0.000_123, logId: "aig-log-42" } },
                        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
                    }),
                modelId: "@cf/meta/llama",
            }),
        );

        const span = spanOf(calls[0] as CapturedPost);

        // Fractional USD cost is a double — encoded as a JSON number, not a string.
        expect(attribute(span, "gen_ai.usage.cost")).toBe(0.000_123);
        expect(attribute(span, "gen_ai.response.cached")).toBe(false);
        expect(attribute(span, "cf.aig.log_id")).toBe("aig-log-42");
    });

    it("derives cached + log-id from the gateway's cf-aig-* response headers", async () => {
        const calls = captureFetch();

        await otlpTelemetry({ endpoint: "https://collector.test" }).executeLanguageModelCall?.(
            evt({
                execute: () =>
                    Promise.resolve({
                        response: { headers: { "cf-aig-cache-status": "HIT", "cf-aig-log-id": "aig-log-7" } },
                    }),
                modelId: "m",
            }),
        );

        const span = spanOf(calls[0] as CapturedPost);

        expect(attribute(span, "gen_ai.response.cached")).toBe(true);
        expect(attribute(span, "cf.aig.log_id")).toBe("aig-log-7");
    });

    it("emits no gateway attributes when the call did not route through a gateway", async () => {
        const calls = captureFetch();

        await otlpTelemetry({ endpoint: "https://collector.test" }).executeLanguageModelCall?.(
            evt({ execute: () => Promise.resolve({ usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }), modelId: "m" }),
        );

        const span = spanOf(calls[0] as CapturedPost);

        expect(attribute(span, "gen_ai.usage.cost")).toBeUndefined();
        expect(attribute(span, "gen_ai.response.cached")).toBeUndefined();
        expect(attribute(span, "cf.aig.log_id")).toBeUndefined();
    });

    it("emits a tool-execution span named from the tool", async () => {
        const calls = captureFetch();

        const result = await otlpTelemetry({ endpoint: "https://collector.test" }).executeTool?.(
            evt({ execute: () => Promise.resolve("tool-value"), toolCall: { toolName: "lookup" }, toolCallId: "tc-1" }),
        );

        expect(result).toBe("tool-value");

        const span = spanOf(calls[0] as CapturedPost);

        expect(span.name).toBe("execute_tool lookup");
        expect(attribute(span, "gen_ai.tool.name")).toBe("lookup");
    });
});
