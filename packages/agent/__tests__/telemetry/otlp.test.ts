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
