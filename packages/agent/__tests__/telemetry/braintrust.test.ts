import { describe, expect, it, vi } from "vitest";

import type { BraintrustLike, BraintrustSpan } from "../../src/telemetry/braintrust";
import { braintrustTelemetry } from "../../src/telemetry/braintrust";

/**
 * The ai@7 `Telemetry` event shapes are broad and churn across patch releases;
 * these tests intentionally pass minimal fixtures to exercise the integration's
 * defensive partial-field reads. `evt` widens a fixture to the callback's event
 * type without fabricating (and then having to maintain) every unrelated field.
 */
const evt = (fixture: Record<string, unknown>): never => fixture as unknown as never;

interface TracedCall {
    args?: { name?: string; type?: string };
    logs: Record<string, unknown>[];
}

const fakeBraintrust = () => {
    const calls: TracedCall[] = [];

    const logger: BraintrustLike = {
        traced: (callback, args) => {
            const logs: Record<string, unknown>[] = [];
            const span: BraintrustSpan = {
                log: (event) => {
                    logs.push(event);
                },
            };

            calls.push({ args, logs });

            return callback(span);
        },
    };

    return { calls, logger };
};

/** All logged fields across every traced span, flattened for assertions. */
const dumpLogs = (calls: TracedCall[]): string => JSON.stringify(calls.map((call) => call.logs));

describe(braintrustTelemetry, () => {
    it("wraps a tool execution in a traced llm/tool span and returns the result", async () => {
        const { calls, logger } = fakeBraintrust();
        const telemetry = braintrustTelemetry({ logger });

        const result = await telemetry.executeTool?.({
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

    it("logs input when recordInputs is set and output when recordOutputs is set", async () => {
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

    it("wraps a language-model call as an llm span named from functionId", async () => {
        const { calls, logger } = fakeBraintrust();

        const result = await braintrustTelemetry({ functionId: "support", logger }).executeLanguageModelCall?.({
            callId: "call-1",
            execute: () => Promise.resolve("answer"),
            modelId: "gpt-4o",
            provider: "openai",
        });

        expect(result).toBe("answer");
        expect(calls[0]?.args).toStrictEqual({ name: "support", type: "llm" });
    });

    it("logs the error on onError", () => {
        const { calls, logger } = fakeBraintrust();

        braintrustTelemetry({ logger }).onError?.(new Error("kaboom"));

        expect(calls).toHaveLength(1);
        expect(calls[0]?.args).toStrictEqual({ name: "error", type: "error" });
        expect(calls[0]?.logs[0]).toStrictEqual({ error: { message: "kaboom", name: "Error" } });
    });

    it("passes the caller's logger through (dependency injection)", async () => {
        const traced = vi.fn<(callback: (span: BraintrustSpan) => unknown) => unknown>((callback) => callback({ log: () => undefined }));
        const logger = { traced } as unknown as BraintrustLike;

        await braintrustTelemetry({ logger }).executeLanguageModelCall?.({
            callId: "c",
            execute: () => Promise.resolve("x"),
        });

        expect(traced).toHaveBeenCalledTimes(1);
    });
});
