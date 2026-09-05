import type { Telemetry } from "ai";

import type { CommonOptions } from "./common";
import { contentText, describeError, readField, summarizeUsage, toolInputOf } from "./common";
import { createInFlightCalls } from "./in-flight-calls";

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
 * `logger.traced` spans and logs structural metadata, including the call's token
 * usage as Braintrust `metrics`. Prompts / tool arguments are logged only when
 * `recordInputs` is set; generated text / tool results only when `recordOutputs`
 * is set. `onError` opens a span and logs the error.
 *
 * The tool span is driven by the agent LOOP, not by `ai`: Lunora exposes tools
 * schema-only so the SDK never executes one (see `telemetry/tool-execution.ts`).
 *
 * **A model-call span closes when the CALL ends, not when `execute()` resolves.**
 * On a streamed turn `execute()` resolves the instant `doStream` hands back the
 * stream — before a token, before any usage — so a span that simply awaited it
 * measured time-to-first-byte and logged the stream handle instead of the
 * generation. `execute()` still runs INSIDE the traced callback, which is what
 * parents the provider's own work under the span; the callback then parks until
 * the SDK's terminal event for that `callId` arrives, so `traced` finishes the
 * span at the real end of the call, with the real usage. The caller gets
 * `execute()`'s value the moment it resolves, exactly as before — the span's
 * lifetime and the caller's are deliberately separate.
 *
 * The app owns Braintrust initialization; pass the logger in as `logger`.
 * @experimental
 */
export const braintrustTelemetry = (options: BraintrustTelemetryOptions): Telemetry => {
    const { functionId, logger, recordInputs = false, recordOutputs = false } = options;

    /** One model call in flight: its span, the gate holding `traced` open, and `execute()`'s value. */
    interface InFlightCall {
        finish: () => void;
        result: unknown;
        span: BraintrustSpan;
    }

    // Keyed by `callId` and closed one at a time — see `createInFlightCalls` for
    // why a bulk close is wrong when one integration instance is shared by every
    // concurrent run in the isolate.
    const calls = createInFlightCalls<InFlightCall>((call, ok, message, event) => {
        const fields: Record<string, unknown> = {};

        // Usage comes off the END EVENT, which the SDK fires once the response has
        // been normalized. On a stream that is after its `finish` part; the value
        // `execute()` resolves with carries no usage at all.
        const usage = summarizeUsage(readField(event, "usage") ?? readField(call.result, "usage"));

        if (usage) {
            // Braintrust's LLM-span metric names, so token counts and cost roll up
            // in its own dashboards rather than landing as opaque metadata.
            fields.metrics = {
                completion_tokens: usage.outputTokens,
                prompt_tokens: usage.inputTokens,
                tokens: usage.totalTokens,
            };
        }

        if (!ok) {
            fields.error = message ?? "the model call failed";
        }

        if (recordOutputs) {
            // The normalized content parts, not the value `execute()` resolved
            // with — on a stream that value is the stream handle, which serialized
            // to nothing useful.
            const completion = contentText(readField(event, "content") ?? readField(call.result, "content"));

            if (completion !== undefined) {
                fields.output = completion;
            }
        }

        if (Object.keys(fields).length > 0) {
            call.span.log(fields);
        }

        // Releases the parked `traced` callback, which ends the span. Logged
        // fields land first: the callback resumes on a later microtask.
        call.finish();
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
            const { callId, execute } = options_;

            // The wrapper is generic in the call's result type; name it so the
            // promise handed back to the SDK is not widened to `unknown`.
            type Result = Awaited<ReturnType<typeof execute>>;

            // Two independent lifetimes. `delivered` is the CALLER's: it settles the
            // moment `execute()` does, so nothing downstream waits on telemetry.
            // `finished` is the SPAN's: the traced callback parks on it until a
            // terminal event closes the call.
            // Definite-assignment: a Promise executor runs synchronously, so both
            // are assigned before the next statement.
            let deliver!: (result: Result) => void;
            let failCall!: (error: unknown) => void;
            const delivered = new Promise<Result>((resolve, reject) => {
                deliver = resolve;
                failCall = reject;
            });

            let finish!: () => void;
            const finished = new Promise<void>((resolve) => {
                finish = resolve;
            });

            // Deliberately not returned: the caller's value is `delivered`. The
            // `.catch` keeps the detached chain from floating if the host SDK's own
            // `traced` rejects — that is a telemetry fault, never the call's.
            Promise.resolve(
                logger.traced(
                    async (span) => {
                        calls.open(callId, () => {
                            return { finish, result: undefined, span };
                        });

                        if (recordInputs) {
                            span.log({ input: readField(options_, "messages"), model: readField(options_, "modelId") });
                        }

                        let result: Result;

                        try {
                            result = await execute();
                        } catch (error) {
                            // The provider call itself failed, so this IS the end of
                            // the span and no end event will follow.
                            calls.close(callId, false, error instanceof Error ? error.message : String(error), undefined);
                            failCall(error);

                            return;
                        }

                        const call = calls.get(callId);

                        if (call !== undefined) {
                            // The usage fallback for a NON-streamed call.
                            call.result = result;
                        }

                        deliver(result);

                        await finished;
                    },
                    { name: stringOr(functionId, "language_model_call"), type: "llm" },
                ),
            ).catch(() => undefined);

            return delivered;
        },
        executeTool: (options_) => {
            const toolName = readField(readField(options_, "toolCall"), "toolName");

            // A tool execution genuinely IS over when `execute()` resolves, so the
            // plain awaiting wrapper is the right one here.
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
        onAbort: (event: unknown) => {
            closeByCallId(event, readField(event, "reason"), "aborted");
        },
        onEnd: (event: unknown) => {
            calls.fromLifecycle(event);
        },
        onError: (error: unknown) => {
            logger.traced(
                (span) => {
                    span.log({ error: describeError(readField(error, "error") ?? error) });
                },
                { name: "error", type: "error" },
            );

            closeByCallId(error, readField(error, "error"), "the model call failed");
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
