import type { Telemetry } from "ai";

import type { CommonOptions } from "./common";
import { readField, toolInputOf } from "./common";

const stringOr = (value: unknown, fallback: string): string => (typeof value === "string" && value.length > 0 ? value : fallback);

/**
 * The minimal, **structural** slice of `@sentry/cloudflare` (equivalently
 * `@sentry/node`/`@sentry/browser`) this bridge needs. `@sentry/cloudflare` is
 * intentionally **not** a dependency — the app passes its own already-initialized
 * Sentry namespace, so this package stays dependency-free and works with any
 * compatible Sentry SDK version.
 * @experimental
 */
export interface SentryLike {
    /** Capture a thrown value / exception. */
    captureException: (exception: unknown) => unknown;
    /** Run `callback` inside a new span and return its result. */
    startSpan: <T>(
        context: { attributes?: Record<string, unknown>; name: string; op?: string },
        callback: (span: { setStatus?: (status: { code: number } | string) => void }) => T,
    ) => T;
}

/**
 * Options for {@link sentryTelemetry}.
 * @experimental
 */
export interface SentryTelemetryOptions extends CommonOptions {
    /** Span-name prefix for the language-model call (e.g. the agent name). */
    functionId?: string;

    /**
     * The caller's already-initialized Sentry namespace (dependency-injected).
     * `import * as Sentry from "@sentry/cloudflare"` and pass it as `Sentry`.
     */
    Sentry: SentryLike;
}

/**
 * A dependency-injected Sentry bridge for the ai@7 telemetry surface.
 *
 * It wraps model calls and tool executions in Sentry spans (via
 * `Sentry.startSpan`) so nested provider/tool work is correctly parented, and
 * routes `onError` to `Sentry.captureException`. Span attributes carry only
 * structural metadata (model, provider, tool name) unless `recordInputs` is
 * set, in which case prompts / tool arguments are attached too.
 *
 * The tool span is driven by the agent LOOP, not by `ai`: Lunora exposes tools
 * schema-only so the SDK never executes one (see `telemetry/tool-execution.ts`).
 *
 * **A model-call span here ends when the provider call returns.** The host span
 * has to WRAP `execute()` — that is what establishes the parent context nested
 * provider work attaches to — and on a streamed turn `execute()` resolves at
 * first byte. So a streamed call's Sentry span measures time-to-first-byte, not
 * the whole generation, and carries no token usage. Use `otlpTelemetry` (which
 * closes on the SDK's model-call-end event) when the streamed duration and usage
 * are what you need.
 *
 * The app owns Sentry initialization; pass the namespace in as `Sentry`.
 * @experimental
 */
export const sentryTelemetry = (options: SentryTelemetryOptions): Telemetry => {
    const { functionId, recordInputs = false, Sentry: sentry } = options;

    return {
        executeLanguageModelCall: (options_) => {
            const attributes: Record<string, unknown> = {
                "gen_ai.operation.name": stringOr(functionId, "language_model_call"),
                "gen_ai.request.model": readField(options_, "modelId"),
                "gen_ai.system": readField(options_, "provider"),
            };

            if (recordInputs) {
                attributes["gen_ai.prompt"] = readField(options_, "messages");
            }

            return sentry.startSpan({ attributes, name: stringOr(functionId, "language_model_call"), op: "gen_ai.generate" }, () => options_.execute());
        },
        executeTool: (options_) => {
            const toolName = readField(readField(options_, "toolCall"), "toolName");

            const attributes: Record<string, unknown> = {
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.call.id": readField(options_, "toolCallId"),
                "gen_ai.tool.name": toolName,
            };

            if (recordInputs) {
                attributes["gen_ai.tool.input"] = toolInputOf(options_);
            }

            return sentry.startSpan({ attributes, name: `execute_tool ${stringOr(toolName, "tool")}`, op: "gen_ai.execute_tool" }, () => options_.execute());
        },
        onError: (error: unknown) => {
            sentry.captureException(error);
        },
    };
};
