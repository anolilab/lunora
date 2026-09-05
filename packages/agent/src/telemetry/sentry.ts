import type { Telemetry } from "ai";

import type { CommonOptions } from "./common";
import { contentText, readField, summarizeUsage, toolInputOf } from "./common";
import { createInFlightCalls } from "./in-flight-calls";

const stringOr = (value: unknown, fallback: string): string => (typeof value === "string" && value.length > 0 ? value : fallback);

/** The span context both `startSpan` and `startSpanManual` are called with. */
interface SentrySpanContext {
    attributes?: Record<string, unknown>;
    name: string;
    op?: string;
}

/**
 * The subset of a Sentry `Span` this bridge drives. Structural, like
 * {@link SentryLike} itself — a real `@sentry/*` span satisfies it.
 * @experimental
 */
export interface SentrySpan {
    /** Finish the span. Called once, from whichever terminal event closes the call. */
    end: () => void;
    /** Attach attributes discovered after the span started (token usage). */
    setAttributes?: (attributes: Record<string, unknown>) => unknown;
    /** `1` = OK, `2` = ERROR (Sentry's `SPAN_STATUS_OK` / `SPAN_STATUS_ERROR`). */
    setStatus?: (status: { code: 0 | 1 | 2; message?: string }) => unknown;
}

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

    /** Run `callback` inside a new span, finished when the callback settles. */
    startSpan: <T>(context: SentrySpanContext, callback: (span: SentrySpan) => T) => T;

    /**
     * Run `callback` inside a new span that is **not** finished automatically —
     * the caller owns its lifetime through `span.end()`. Present on every Sentry
     * SDK built on `@sentry/core` (verified against `@sentry/core@10.55.0`); it is
     * what lets a streamed model call be measured to the end of the stream while
     * still nesting the provider's own work under it.
     */
    startSpanManual: <T>(context: SentrySpanContext, callback: (span: SentrySpan) => T) => T;
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
 * It wraps model calls and tool executions in Sentry spans so nested
 * provider/tool work is correctly parented, and routes `onError` to
 * `Sentry.captureException`. Span attributes carry only structural metadata
 * (model, provider, tool name, token usage) unless `recordInputs` /
 * `recordOutputs` are set, in which case prompts, tool arguments and generated
 * text are attached too.
 *
 * The tool span is driven by the agent LOOP, not by `ai`: Lunora exposes tools
 * schema-only so the SDK never executes one (see `telemetry/tool-execution.ts`).
 *
 * **A model-call span closes when the CALL ends, not when `execute()` resolves.**
 * On a streamed turn `execute()` resolves the instant `doStream` hands back the
 * stream — before a token, before any usage. The span still OPENS around
 * `execute()`, because that is what makes it the active span nested provider work
 * parents to, but it is opened with `startSpanManual` and so is not finished
 * there: `onLanguageModelCallEnd` ends it, once the response is normalized and
 * the real duration and token usage are both known. `onAbort` / `onError` end the
 * call they name as a failure, so a stream that dies or is barged in on reports
 * one instead of a phantom success.
 *
 * The app owns Sentry initialization; pass the namespace in as `Sentry`.
 * @experimental
 */
export const sentryTelemetry = (options: SentryTelemetryOptions): Telemetry => {
    const { functionId, recordInputs = false, recordOutputs = false, Sentry: sentry } = options;

    /** One model call in flight: the span awaiting its end, and the value `execute()` resolved with. */
    interface InFlightCall {
        result: unknown;
        span: SentrySpan;
    }

    // Keyed by `callId` and closed one at a time — see `createInFlightCalls` for
    // why a bulk close is wrong when one integration instance is shared by every
    // concurrent run in the isolate.
    const calls = createInFlightCalls<InFlightCall>((call, ok, message, event) => {
        const attributes: Record<string, unknown> = {};

        // Usage comes off the END EVENT, which the SDK fires once the response has
        // been normalized. On a stream that is after its `finish` part; the value
        // `execute()` resolves with carries no usage at all, because it resolves
        // the moment `doStream` hands the stream back.
        const usage = summarizeUsage(readField(event, "usage") ?? readField(call.result, "usage"));

        if (usage) {
            attributes["gen_ai.usage.input_tokens"] = usage.inputTokens;
            attributes["gen_ai.usage.output_tokens"] = usage.outputTokens;
            attributes["gen_ai.usage.total_tokens"] = usage.totalTokens;
        }

        if (recordOutputs) {
            const completion = contentText(readField(event, "content") ?? readField(call.result, "content"));

            if (completion !== undefined) {
                attributes["gen_ai.completion"] = completion;
            }
        }

        if (Object.keys(attributes).length > 0) {
            call.span.setAttributes?.(attributes);
        }

        call.span.setStatus?.(ok ? { code: 1 } : { code: 2, message: message ?? "" });
        call.span.end();
    });

    /**
     * Close the call an `onAbort` / `onError` event names. Both carry the model
     * call's `callId` in ai@7; an event without one closes nothing rather than
     * charging the failure to an unrelated run's still-open span.
     */
    const closeByCallId = (event: unknown, raw: unknown, fallbackMessage: string): void => {
        const callId = readField(event, "callId");

        if (typeof callId !== "string") {
            return;
        }

        // Only a real message is preferred over the fallback: `String(unknown)`
        // renders an event object as "[object Object]", which is worse than
        // saying nothing. A DOMException abort reason IS an Error here.
        let message = fallbackMessage;

        if (raw instanceof Error) {
            message = raw.message;
        } else if (typeof raw === "string" && raw.length > 0) {
            message = raw;
        }

        calls.close(callId, false, message, undefined);
    };

    return {
        executeLanguageModelCall: (options_) => {
            const { callId } = options_;

            const attributes: Record<string, unknown> = {
                "gen_ai.operation.name": stringOr(functionId, "language_model_call"),
                "gen_ai.request.model": readField(options_, "modelId"),
                "gen_ai.system": readField(options_, "provider"),
            };

            if (recordInputs) {
                attributes["gen_ai.prompt"] = readField(options_, "messages");
            }

            // `startSpanManual`, not `startSpan`: the span must still be ACTIVE
            // around `execute()` so the provider's own instrumentation nests under
            // it, but it must outlive `execute()`, which on a stream resolves at
            // first byte. The terminal event ends it.
            return sentry.startSpanManual({ attributes, name: stringOr(functionId, "language_model_call"), op: "gen_ai.generate" }, async (span) => {
                calls.open(callId, () => {
                    return { result: undefined, span };
                });

                try {
                    const result = await options_.execute();
                    const call = calls.get(callId);

                    if (call !== undefined) {
                        // The resolved value is the usage fallback for a NON-streamed
                        // call and the only carrier of provider response metadata.
                        call.result = result;
                    }

                    return result;
                } catch (error) {
                    // The provider call itself failed, so this IS the end of the
                    // span and no end event will follow.
                    calls.close(callId, false, error instanceof Error ? error.message : String(error), undefined);

                    throw error;
                }
            });
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

            // A tool execution genuinely IS over when `execute()` resolves, so the
            // auto-finishing wrapper is the right one here.
            return sentry.startSpan({ attributes, name: `execute_tool ${stringOr(toolName, "tool")}`, op: "gen_ai.execute_tool" }, () => options_.execute());
        },
        onAbort: (event: unknown) => {
            closeByCallId(event, readField(event, "reason"), "aborted");
        },
        onEnd: (event: unknown) => {
            calls.fromLifecycle(event);
        },
        onError: (event: unknown) => {
            // ai@7 dispatches `{ callId, error }`; a caller invoking the hook by
            // hand passes the thrown value itself, and both must reach Sentry.
            sentry.captureException(readField(event, "error") ?? event);
            closeByCallId(event, readField(event, "error"), "the model call failed");
        },
        onLanguageModelCallEnd: (event: unknown) => {
            const callId = readField(event, "callId");

            if (typeof callId !== "string") {
                return;
            }

            // Fired after the response has been normalized and parsed — for a
            // stream that is after its `finish` part, so this is the first moment
            // the call's real duration AND its token usage are both known.
            calls.close(callId, true, undefined, event);
        },
        onStepEnd: (event: unknown) => {
            calls.fromLifecycle(event);
        },
    };
};
