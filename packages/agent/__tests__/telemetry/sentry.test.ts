import { describe, expect, it, vi } from "vitest";

import type { SentryLike } from "../../src/telemetry/sentry";
import { sentryTelemetry } from "../../src/telemetry/sentry";

/**
 * The ai@7 `Telemetry` event shapes are broad and churn across patch releases;
 * these tests intentionally pass minimal fixtures to exercise the integration's
 * defensive partial-field reads. `evt` widens a fixture to the callback's event
 * type without fabricating (and then having to maintain) every unrelated field.
 */
const evt = (fixture: Record<string, unknown>): never => fixture as unknown as never;

interface Span {
    attributes?: Record<string, unknown>;
    name: string;
    op?: string;
}

const fakeSentry = () => {
    const spans: Span[] = [];
    const captured: unknown[] = [];

    const Sentry: SentryLike = {
        captureException: (exception) => {
            captured.push(exception);

            return undefined;
        },
        startSpan: (context, callback) => {
            spans.push(context);

            return callback({});
        },
    };

    return { captured, Sentry, spans };
};

describe(sentryTelemetry, () => {
    it("wraps a tool execution in a span and returns its result", async () => {
        const { Sentry, spans } = fakeSentry();
        const telemetry = sentryTelemetry({ Sentry });

        const result = await telemetry.executeTool?.({
            callId: "call-1",
            execute: () => Promise.resolve("tool-value"),
            toolCall: evt({ input: { q: "SENSITIVE" }, toolName: "lookup" }),
            toolCallId: "tc-1",
        });

        expect(result).toBe("tool-value");
        expect(spans).toHaveLength(1);
        expect(spans[0]?.op).toBe("gen_ai.execute_tool");
        expect(spans[0]?.name).toBe("execute_tool lookup");
        expect(spans[0]?.attributes?.["gen_ai.tool.name"]).toBe("lookup");
    });

    it("does NOT attach tool input attributes unless recordInputs is set", async () => {
        const { Sentry, spans } = fakeSentry();

        await sentryTelemetry({ Sentry }).executeTool?.({
            callId: "call-1",
            execute: () => Promise.resolve("ok"),
            toolCall: evt({ input: { q: "SENSITIVE" }, toolName: "lookup" }),
            toolCallId: "tc-1",
        });

        expect(JSON.stringify(spans)).not.toContain("SENSITIVE");
        expect(spans[0]?.attributes).not.toHaveProperty("gen_ai.tool.input");
    });

    it("attaches tool input attributes when recordInputs is set", async () => {
        const { Sentry, spans } = fakeSentry();

        await sentryTelemetry({ recordInputs: true, Sentry }).executeTool?.({
            callId: "call-1",
            execute: () => Promise.resolve("ok"),
            toolCall: evt({ input: { q: "hello" }, toolName: "lookup" }),
            toolCallId: "tc-1",
        });

        expect(spans[0]?.attributes?.["gen_ai.tool.input"]).toStrictEqual({ q: "hello" });
    });

    it("wraps a language-model call, naming the span from functionId", async () => {
        const { Sentry, spans } = fakeSentry();
        const telemetry = sentryTelemetry({ functionId: "support", Sentry });

        const result = await telemetry.executeLanguageModelCall?.({
            callId: "call-1",
            execute: () => Promise.resolve("answer"),
            modelId: "gpt-4o",
            provider: "openai",
        });

        expect(result).toBe("answer");
        expect(spans[0]?.name).toBe("support");
        expect(spans[0]?.op).toBe("gen_ai.generate");
        expect(spans[0]?.attributes?.["gen_ai.request.model"]).toBe("gpt-4o");
        expect(spans[0]?.attributes?.["gen_ai.system"]).toBe("openai");
    });

    it("routes onError to captureException", () => {
        const { captured, Sentry } = fakeSentry();
        const error = new Error("kaboom");

        sentryTelemetry({ Sentry }).onError?.(error);

        expect(captured).toStrictEqual([error]);
    });

    it("passes the caller's Sentry namespace through (dependency injection)", async () => {
        const startSpan = vi.fn<(context: unknown, callback: (span: unknown) => unknown) => unknown>((_context, callback) => callback({}));
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
