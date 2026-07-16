import type { Telemetry } from "ai";

import type { CommonOptions } from "./common";
import { contentText, describeError, describeToolOutcome, readField, summarizeUsage, toolInputOf, toolNameOf } from "./common";

/** Default sink: route to the matching `globalThis.console` method. */
const defaultLogger: ConsoleLogger = (level, message, fields) => {
    const target = globalThis.console;

    if (level === "error") {
        target.error(message, fields);
    } else if (level === "warn") {
        target.warn(message, fields);
    } else {
        target.info(message, fields);
    }
};

/**
 * Severity level passed to a {@link ConsoleLogger}.
 * @experimental
 */
export type ConsoleLogLevel = "error" | "info" | "warn";

/**
 * Structured log sink. Receives a level, a static human message, and a bag of
 * structured fields (never interpolated into the message, so log processors can
 * index them). The default sink writes to `globalThis.console`.
 * @experimental
 */
export type ConsoleLogger = (level: ConsoleLogLevel, message: string, fields: Record<string, unknown>) => void;

/**
 * Options for {@link consoleTelemetry}.
 * @experimental
 */
export interface ConsoleTelemetryOptions extends CommonOptions {
    /**
     * Identifier prefixed into every log message (e.g. the agent name). Helps
     * correlate lines when several agents share one process. Optional.
     */
    functionId?: string;

    /**
     * Sink for structured log lines. Defaults to a `globalThis.console`-backed
     * writer that routes `info`/`warn`/`error` to the matching console method.
     */
    logger?: ConsoleLogger;
}

/**
 * A zero-dependency structured tracer for the ai@7 telemetry surface.
 *
 * It maps the generation lifecycle onto {@link ConsoleLogger} calls: operation
 * start/end, per-step start/end, model-call end (model + finish reason +
 * usage), and tool start/end (name, success, timing). By default it records
 * **only structural metadata** — set `recordInputs` to also log prompts / tool
 * arguments, and `recordOutputs` to log generated text / tool results.
 *
 * Every callback is defensive (event fields may be absent) and synchronous.
 * @experimental
 */
export const consoleTelemetry = (options: ConsoleTelemetryOptions = {}): Telemetry => {
    const { functionId, logger = defaultLogger, recordInputs = false, recordOutputs = false } = options;

    const prefix = functionId === undefined ? "" : `[${functionId}] `;

    const log = (level: ConsoleLogLevel, message: string, fields: Record<string, unknown>): void => {
        logger(level, `${prefix}${message}`, fields);
    };

    return {
        onAbort: (event: unknown) => {
            log("warn", "agent operation aborted", {
                callId: readField(event, "callId"),
                reason: readField(event, "reason"),
            });
        },
        onEnd: (event: unknown) => {
            log("info", "agent operation completed", {
                callId: readField(event, "callId"),
                finishReason: readField(event, "finishReason"),
                operationId: readField(event, "operationId"),
                usage: summarizeUsage(readField(event, "usage")),
            });
        },
        onError: (error: unknown) => {
            log("error", "agent operation errored", { error: describeError(error) });
        },
        onLanguageModelCallEnd: (event: unknown) => {
            const fields: Record<string, unknown> = {
                callId: readField(event, "callId"),
                finishReason: readField(event, "finishReason"),
                modelId: readField(event, "modelId"),
                provider: readField(event, "provider"),
                usage: summarizeUsage(readField(event, "usage")),
            };

            if (recordOutputs) {
                fields["text"] = contentText(readField(event, "content"));
            }

            log("info", "language model call ended", fields);
        },
        onStart: (event: unknown) => {
            log("info", "agent operation started", {
                callId: readField(event, "callId"),
                modelId: readField(event, "modelId"),
                operationId: readField(event, "operationId"),
                provider: readField(event, "provider"),
            });
        },
        onStepEnd: (event: unknown) => {
            log("info", "agent step ended", {
                finishReason: readField(event, "finishReason"),
                stepNumber: readField(event, "stepNumber"),
                usage: summarizeUsage(readField(event, "usage")),
            });
        },
        onStepStart: (event: unknown) => {
            log("info", "agent step started", { stepNumber: readField(event, "stepNumber") });
        },
        onToolExecutionEnd: (event: unknown) => {
            const outcome = describeToolOutcome(event);

            const fields: Record<string, unknown> = {
                success: outcome.success,
                tool: outcome.name,
                toolExecutionMs: outcome.toolExecutionMs,
            };

            if (!outcome.success) {
                fields["error"] = describeError(outcome.error);
            }

            if (recordOutputs && outcome.success) {
                fields["output"] = outcome.output;
            }

            log(outcome.success ? "info" : "warn", "tool execution ended", fields);
        },
        onToolExecutionStart: (event: unknown) => {
            const fields: Record<string, unknown> = { tool: toolNameOf(event) };

            if (recordInputs) {
                fields["input"] = toolInputOf(event);
            }

            log("info", "tool execution started", fields);
        },
    };
};
