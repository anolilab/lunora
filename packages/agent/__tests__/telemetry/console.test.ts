import { describe, expect, it, vi } from "vitest";

import type { ConsoleLogLevel } from "../../src/telemetry/console";
import { consoleTelemetry } from "../../src/telemetry/console";

/**
 * The ai@7 `Telemetry` event shapes are broad and churn across patch releases;
 * these tests intentionally pass minimal fixtures to exercise the logger's
 * defensive partial-field reads. `evt` widens a fixture to the callback's event
 * type without fabricating (and then having to maintain) every unrelated field.
 */
const evt = (fixture: Record<string, unknown>): never => fixture as unknown as never;

interface Entry {
    fields: Record<string, unknown>;
    level: ConsoleLogLevel;
    message: string;
}

const capture = () => {
    const entries: Entry[] = [];
    const logger = (level: ConsoleLogLevel, message: string, fields: Record<string, unknown>): void => {
        entries.push({ fields, level, message });
    };

    return { entries, logger };
};

/** Deeply stringify captured fields so we can assert a value never leaked. */
const dump = (entries: Entry[]): string => JSON.stringify(entries);

describe(consoleTelemetry, () => {
    it("logs operation start with the operationId and a functionId prefix", () => {
        const { entries, logger } = capture();
        const telemetry = consoleTelemetry({ functionId: "support", logger });

        telemetry.onStart?.(evt({ callId: "c1", modelId: "gpt", operationId: "ai.generateText", provider: "openai" }));

        expect(entries).toHaveLength(1);
        expect(entries[0]?.message).toContain("[support]");
        expect(entries[0]?.fields["operationId"]).toBe("ai.generateText");
    });

    it("does NOT record prompts or tool input by default (recordInputs false)", () => {
        const { entries, logger } = capture();
        const telemetry = consoleTelemetry({ logger });

        telemetry.onToolExecutionStart?.(evt({ toolCall: { input: { ssn: "SECRET-INPUT" }, toolName: "lookup" } }));

        expect(dump(entries)).not.toContain("SECRET-INPUT");
        // The tool name itself is structural and IS logged.
        expect(entries[0]?.fields["tool"]).toBe("lookup");
        expect(entries[0]?.fields).not.toHaveProperty("input");
    });

    it("does NOT record model text or tool output by default (recordOutputs false)", () => {
        const { entries, logger } = capture();
        const telemetry = consoleTelemetry({ logger });

        telemetry.onLanguageModelCallEnd?.(
            evt({
                content: [{ text: "SECRET-MODEL-TEXT", type: "text" }],
                finishReason: "stop",
                modelId: "gpt",
                provider: "openai",
            }),
        );
        telemetry.onToolExecutionEnd?.(
            evt({
                toolCall: { toolName: "lookup" },
                toolExecutionMs: 12,
                toolOutput: { output: "SECRET-TOOL-OUTPUT", type: "tool-result" },
            }),
        );

        expect(dump(entries)).not.toContain("SECRET-MODEL-TEXT");
        expect(dump(entries)).not.toContain("SECRET-TOOL-OUTPUT");
    });

    it("records inputs and outputs when explicitly opted in", () => {
        const { entries, logger } = capture();
        const telemetry = consoleTelemetry({ logger, recordInputs: true, recordOutputs: true });

        telemetry.onToolExecutionStart?.(evt({ toolCall: { input: { q: "hello" }, toolName: "lookup" } }));
        telemetry.onLanguageModelCallEnd?.(evt({ content: [{ text: "the answer", type: "text" }], modelId: "gpt", provider: "openai" }));
        telemetry.onToolExecutionEnd?.(
            evt({
                toolCall: { toolName: "lookup" },
                toolExecutionMs: 5,
                toolOutput: { output: "tool-result-value", type: "tool-result" },
            }),
        );

        expect(dump(entries)).toContain("hello");
        expect(dump(entries)).toContain("the answer");
        expect(dump(entries)).toContain("tool-result-value");
    });

    it("logs tool success at info and reports the execution time and usage", () => {
        const { entries, logger } = capture();
        const telemetry = consoleTelemetry({ logger });

        telemetry.onToolExecutionEnd?.(
            evt({
                toolCall: { toolName: "lookup" },
                toolExecutionMs: 42,
                toolOutput: { output: "ok", type: "tool-result" },
            }),
        );
        telemetry.onStepEnd?.(evt({ finishReason: "stop", stepNumber: 0, usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } }));

        const toolEntry = entries.find((entry) => entry.message.includes("tool execution ended"));

        expect(toolEntry?.level).toBe("info");
        expect(toolEntry?.fields["success"]).toBe(true);
        expect(toolEntry?.fields["toolExecutionMs"]).toBe(42);

        const stepEntry = entries.find((entry) => entry.message.includes("agent step ended"));

        expect(stepEntry?.fields["usage"]).toStrictEqual({ inputTokens: 10, outputTokens: 3, totalTokens: 13 });
    });

    it("logs tool failure at warn with the error and never leaks it as output", () => {
        const { entries, logger } = capture();
        const telemetry = consoleTelemetry({ logger, recordOutputs: true });

        telemetry.onToolExecutionEnd?.(
            evt({
                toolCall: { toolName: "lookup" },
                toolExecutionMs: 7,
                toolOutput: { error: new Error("boom"), type: "tool-error" },
            }),
        );

        const entry = entries[0];

        expect(entry?.level).toBe("warn");
        expect(entry?.fields["success"]).toBe(false);
        expect(entry?.fields["error"]).toStrictEqual({ message: "boom", name: "Error" });
        // Even with recordOutputs on, a failed tool logs no `output` field.
        expect(entry?.fields).not.toHaveProperty("output");
    });

    it("routes onError to the error level", () => {
        const { entries, logger } = capture();
        const telemetry = consoleTelemetry({ logger });

        telemetry.onError?.(new Error("kaboom"));

        expect(entries[0]?.level).toBe("error");
        expect(entries[0]?.fields["error"]).toStrictEqual({ message: "kaboom", name: "Error" });
    });

    it("is defensive against missing event fields (no throw on empty events)", () => {
        const { entries, logger } = capture();
        const telemetry = consoleTelemetry({ logger });

        expect(() => {
            telemetry.onStart?.(evt({}));
            telemetry.onStepStart?.(evt({}));
            telemetry.onLanguageModelCallEnd?.(evt({}));
            telemetry.onToolExecutionStart?.(evt({}));
            telemetry.onToolExecutionEnd?.(evt({}));
            telemetry.onStepEnd?.(evt({}));
            telemetry.onEnd?.(evt({}));
            telemetry.onAbort?.(evt({}));
        }).not.toThrow();

        expect(entries.length).toBeGreaterThan(0);
    });

    it("defaults to a globalThis.console-backed logger", () => {
        const info = vi.spyOn(globalThis.console, "info").mockImplementation(() => undefined);
        const telemetry = consoleTelemetry();

        telemetry.onStart?.(evt({ operationId: "ai.generateText" }));

        expect(info).toHaveBeenCalledTimes(1);

        info.mockRestore();
    });

    it("routes the default logger to the matching console method per level (error/warn/info)", () => {
        expect.assertions(3);

        const error = vi.spyOn(globalThis.console, "error").mockImplementation(() => undefined);
        const warn = vi.spyOn(globalThis.console, "warn").mockImplementation(() => undefined);
        const info = vi.spyOn(globalThis.console, "info").mockImplementation(() => undefined);
        const telemetry = consoleTelemetry();

        // onStart → info, onAbort → warn, onError → error
        telemetry.onStart?.(evt({ operationId: "op" }));
        telemetry.onAbort?.(evt({ callId: "c1" }));
        telemetry.onError?.(new Error("boom"));

        expect(info).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledTimes(1);

        error.mockRestore();
        warn.mockRestore();
        info.mockRestore();
    });
});
