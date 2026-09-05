import type { Telemetry } from "ai";

import type { CommonOptions } from "./common";
import { describeError, readField, toolInputOf } from "./common";

const stringOr = (value: unknown, fallback: string): string => (typeof value === "string" && value.length > 0 ? value : fallback);

/**
 * The span handle a {@link BraintrustLike.traced} callback receives.
 * @experimental
 */
export interface BraintrustSpan {
    /** Attach structured fields to the current span. */
    log: (event: Record<string, unknown>) => void;
}

/**
 * The minimal, **structural** slice of the `braintrust` SDK this bridge needs.
 * `braintrust` is intentionally **not** a dependency — the app passes its own
 * initialized logger, so this package stays dependency-free and works with any
 * compatible Braintrust SDK version.
 * @experimental
 */
export interface BraintrustLike {
    /** Run `callback` inside a new traced span and return its result. */
    traced: <T>(callback: (span: BraintrustSpan) => T, args?: { name?: string; type?: string }) => T;
}

/**
 * Options for {@link braintrustTelemetry}.
 * @experimental
 */
export interface BraintrustTelemetryOptions extends CommonOptions {
    /** Span-name prefix for the language-model call (e.g. the agent name). */
    functionId?: string;

    /**
     * The caller's initialized Braintrust logger (dependency-injected). Import
     * and initialize `braintrust` in your app and pass it as `logger`.
     */
    logger: BraintrustLike;
}

/**
 * A dependency-injected Braintrust bridge for the ai@7 telemetry surface.
 *
 * It wraps model calls (`type: "llm"`) and tool executions (`type: "tool"`) in
 * `logger.traced` spans and logs structural metadata. Prompts / tool arguments
 * are logged only when `recordInputs` is set; generated text / tool results
 * only when `recordOutputs` is set. `onError` opens a span and logs the error.
 *
 * The tool span is driven by the agent LOOP, not by `ai`: Lunora exposes tools
 * schema-only so the SDK never executes one (see `telemetry/tool-execution.ts`).
 *
 * **A model-call span here ends when the provider call returns.** The traced span
 * has to WRAP `execute()` so nested work is parented under it, and on a streamed
 * turn `execute()` resolves at first byte — so a streamed call's span measures
 * time-to-first-byte and logs the stream handle rather than the generation. Use
 * `otlpTelemetry` (which closes on the SDK's model-call-end event) when the
 * streamed duration and token usage are what you need.
 *
 * The app owns Braintrust initialization; pass the logger in as `logger`.
 * @experimental
 */
export const braintrustTelemetry = (options: BraintrustTelemetryOptions): Telemetry => {
    const { functionId, logger, recordInputs = false, recordOutputs = false } = options;

    return {
        executeLanguageModelCall: (options_) =>
            logger.traced(
                async (span) => {
                    if (recordInputs) {
                        span.log({ input: readField(options_, "messages"), model: readField(options_, "modelId") });
                    }

                    const output = await options_.execute();

                    if (recordOutputs) {
                        span.log({ output });
                    }

                    return output;
                },
                { name: stringOr(functionId, "language_model_call"), type: "llm" },
            ),
        executeTool: (options_) => {
            const toolName = readField(readField(options_, "toolCall"), "toolName");

            return logger.traced(
                async (span) => {
                    if (recordInputs) {
                        span.log({ input: toolInputOf(options_), tool: toolName });
                    }

                    const output = await options_.execute();

                    if (recordOutputs) {
                        span.log({ output });
                    }

                    return output;
                },
                { name: stringOr(toolName, "execute_tool"), type: "tool" },
            );
        },
        onError: (error: unknown) => {
            logger.traced(
                (span) => {
                    span.log({ error: describeError(error) });
                },
                { name: "error", type: "error" },
            );
        },
    };
};
