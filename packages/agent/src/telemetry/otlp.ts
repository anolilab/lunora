import { estimateModelCost } from "@lunora/ai";
import type { Telemetry } from "ai";

import type { OtlpAttribute, OtlpAttributeValue } from "../../../../shared/otlp";
import { encodeAttribute, mergeHeaders, otlpRandomHex, otlpUnixNano, wrapResourceSpans } from "../../../../shared/otlp";
import type { CommonOptions } from "./common";
import { contentText, readField, summarizeGatewayTelemetry, summarizeUsage, toolInputOf, toolNameOf } from "./common";

/** Push one attribute, skipping nullish values and JSON-stringifying non-primitives. */
const pushAttribute = (attributes: OtlpAttribute[], key: string, value: unknown): void => {
    if (value === undefined || value === null) {
        return;
    }

    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
        attributes.push(encodeAttribute(key, value satisfies OtlpAttributeValue));

        return;
    }

    // Objects/arrays (a recorded prompt, tool input) — serialize so the
    // collector stores a queryable string rather than dropping the attribute.
    attributes.push(encodeAttribute(key, JSON.stringify(value)));
};

/**
 * Run `onSettle` once when `promise` settles — `(true, undefined, result)` on
 * success, `(false, message, undefined)` on rejection — as a **detached** observer
 * (not awaited/returned into the caller's chain). Only the `await` is guarded, so
 * a throw from `onSettle` on the success path can't be mis-caught and recorded as a
 * failure (the earlier `try { emit(true, await p) } catch { emit(false) }` did that);
 * the trailing `.catch` keeps the detached chain from floating. The caller's own
 * `promise` is returned untouched, so it still rejects for them.
 */
const observeSettled = (promise: PromiseLike<unknown>, onSettle: (ok: boolean, message: string | undefined, result: unknown) => void): void => {
    const run = async (): Promise<void> => {
        let result: unknown;

        try {
            result = await promise;
        } catch (error) {
            onSettle(false, error instanceof Error ? error.message : String(error), undefined);

            return;
        }

        onSettle(true, undefined, result);
    };

    run().catch(() => undefined);
};

/**
 * Options for {@link otlpTelemetry}.
 * @experimental
 */
export interface OtlpTelemetryOptions extends CommonOptions {
    /**
     * Conversation / session id to tag each generation span with, emitted as the
     * `gen_ai.conversation.id` semantic-convention attribute so a multi-turn
     * conversation's model turns group in the trace store. On a deployed agent the
     * platform wiring passes the run's `threadKey` here automatically (one thread =
     * one conversation). Omitted → the attribute is absent (backward-compatible),
     * and each turn's span is ungrouped.
     */
    conversationId?: string;

    /**
     * The OTLP-over-HTTP collector base endpoint (e.g. the Lunora Cloud's `/v1`
     * base). Spans are POSTed to `${endpoint}/v1/traces`; a trailing slash is
     * tolerated. On the platform this is the injected `LUNORA_OTLP_ENDPOINT`.
     */
    endpoint: string;

    /**
     * Extra headers merged onto every POST — typically the correlation headers
     * the platform injects. `Content-Type: application/json` is set by default.
     */
    headers?: Record<string, string>;

    /** `service.name` resource attribute on every span. Defaults to `lunora`. */
    serviceName?: string;

    /**
     * Bearer token added as `Authorization: Bearer` (wins over any authorization
     * in `headers`) — the injected `LUNORA_OTLP_TOKEN`. Omit for an
     * unauthenticated collector.
     */
    token?: string;

    /**
     * Trace id (32-hex) to hang every span of this run under, so one agent run
     * reads as one trace. Pass a stable id derived from the run (e.g. the
     * workflow run id). Omitted → each span mints its own trace id (still valid,
     * just ungrouped).
     */
    traceId?: string;

    /**
     * The Worker request's `waitUntil`, so a fire-and-forget export survives
     * isolate teardown after the turn returns. Omit and the send degrades to
     * best-effort.
     */
    waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * An OTLP-over-HTTP telemetry integration for `@lunora/agent`.
 *
 * The OTLP counterpart to the `sentryTelemetry` / `braintrustTelemetry` bridges:
 * it records each language-model call and each tool execution as an OTLP **span**
 * (`gen_ai.*` semantic-convention attributes — model, provider, token usage,
 * tool name) and ships it to a collector, so agent generations land in the same
 * trace store as the rest of an app's telemetry (the Lunora Cloud, or any OTel
 * collector). Plug it into `defineAgent({ telemetry: { isEnabled: true,
 * integrations: [otlpTelemetry({ endpoint, token })] } })`.
 *
 * **A model-call span closes when the CALL ends, not when `execute()` resolves.**
 * On a streamed turn `execute()` resolves the instant `doStream` hands back the
 * stream — before a single token, before any usage, and before any mid-stream
 * failure. Closing the span there reported every voice and workflow-streamed turn
 * as a ~1 ms, zero-token, always-OK call. So the span opens in
 * `executeLanguageModelCall` (which also owns the failure path, since a rejected
 * provider call produces no end event) and closes on `onLanguageModelCallEnd`,
 * which the SDK fires once the response is normalized — after the stream's
 * `finish` part, where the duration and the token usage actually live.
 * `onError` / `onAbort` close whatever is still open, so a stream that dies or is
 * barged in on reports a failure instead of a phantom success.
 *
 * **Tool spans come from the agent loop.** Lunora exposes tools to the model
 * schema-only, so `ai` never runs one and never fires its tool telemetry; the
 * loop calls `executeTool` itself from the durable step where the tool really
 * runs (see `telemetry/tool-execution.ts`).
 *
 * One span per REAL execution: the agent loop memoizes each `step.do(...)`, so a
 * Workflow replay returns the cached result without re-invoking the wrapped work
 * and no duplicate span is emitted. Privacy-safe by default —
 * `recordInputs`/`recordOutputs` both default `false`, so no prompt or generated
 * text leaves the worker without an explicit opt-in; only structural metadata +
 * token counts are recorded.
 *
 * Each export is fire-and-forget (registered with `waitUntil` when supplied);
 * every rejection is swallowed so a flaky collector never surfaces to the run.
 *
 * One deliberate difference from the SDK-backed bridges, which delegate to a host
 * tracer: flat, not nested. Every span gets `traceId` (shared when `traceId` is
 * set) but no `parentSpanId`, so model-call and tool spans are siblings under the
 * run rather than a tree — OTLP has no ambient span context to parent to here.
 * @param options `endpoint` (+ optional `token`/`headers`/`serviceName`),
 * `traceId` to group a run's spans, `waitUntil`, and the `recordInputs`/
 * `recordOutputs` privacy flags.
 * @experimental
 */
export const otlpTelemetry = (options: OtlpTelemetryOptions): Telemetry => {
    const { conversationId, endpoint, headers, recordInputs = false, recordOutputs = false, token, traceId: fixedTraceId, waitUntil } = options;
    const serviceName = options.serviceName ?? "lunora";

    // Strip trailing slashes without a regex (ReDoS-linter-safe; runs once).
    let base = endpoint;

    while (base.endsWith("/")) {
        base = base.slice(0, -1);
    }

    const tracesUrl = `${base}/v1/traces`;
    // `token` last so it wins over any authorization in `headers`.
    const mergedHeaders = mergeHeaders({ "content-type": "application/json" }, headers, token);

    /** POST one span body fire-and-forget, keeping it alive past the turn when a `waitUntil` is present. */
    const emitSpan = (name: string, startTs: number, ok: boolean, message: string | undefined, attributes: OtlpAttribute[]): void => {
        const span = {
            attributes,
            endTimeUnixNano: otlpUnixNano(Date.now()),
            // SPAN_KIND_INTERNAL — matches the runtime's `ctx.trace` spans.
            kind: 1,
            name,
            spanId: otlpRandomHex(8),
            startTimeUnixNano: otlpUnixNano(startTs),
            // STATUS_CODE_OK (1) / STATUS_CODE_ERROR (2).
            status: ok ? { code: 1 } : { code: 2, message: message ?? "" },
            traceId: fixedTraceId ?? otlpRandomHex(16),
        };

        try {
            const sent = fetch(tracesUrl, {
                body: JSON.stringify(wrapResourceSpans(span, "@lunora/agent", serviceName)),
                headers: mergedHeaders,
                method: "POST",
            }).catch(() => {
                // Network error / non-OK — intentionally ignored.
            });

            waitUntil?.(sent);
        } catch {
            // A synchronous `fetch` throw (e.g. invalid URL) must not break the turn.
        }
    };

    /** One model call in flight, from its start until whichever terminal event fires first. */
    interface InFlightCall {
        messages: unknown;
        modelId: unknown;
        provider: unknown;
        /** The value `execute()` resolved with; the only carrier of the gateway's `cf-aig-*` headers. */
        result: unknown;
        startTs: number;
    }

    /**
     * Model calls in flight, keyed by the SDK's `callId`. An entry is created when
     * the call starts and REMOVED by whichever terminal event fires first, so each
     * span is emitted exactly once and the map cannot grow across a long run.
     */
    const inFlight = new Map<string, InFlightCall>();

    /**
     * Emit the span for one model call and forget it. A `callId` that is no longer
     * in flight has already been reported (an error span followed by a late end
     * event) and is dropped rather than double-counted.
     */
    const closeCall = (callId: string, ok: boolean, message: string | undefined, event: unknown): void => {
        const call = inFlight.get(callId);

        if (call === undefined) {
            return;
        }

        inFlight.delete(callId);

        const { messages, modelId, provider, result, startTs } = call;
        const attributes: OtlpAttribute[] = [];

        pushAttribute(attributes, "gen_ai.operation.name", "chat");
        pushAttribute(attributes, "gen_ai.request.model", modelId);
        pushAttribute(attributes, "gen_ai.system", provider);
        // Session/thread grouping — absent unless a conversation id was set,
        // so a run with no session id emits exactly as before.
        pushAttribute(attributes, "gen_ai.conversation.id", conversationId);

        // Usage comes off the END EVENT, which the SDK fires once the response has
        // been normalized. On a stream that is after its `finish` part; the value
        // `execute()` resolves with carries no usage at all, because it resolves the
        // moment `doStream` hands the stream back.
        const usage = summarizeUsage(readField(event, "usage") ?? readField(result, "usage"));

        if (usage) {
            pushAttribute(attributes, "gen_ai.usage.input_tokens", usage.inputTokens);
            pushAttribute(attributes, "gen_ai.usage.output_tokens", usage.outputTokens);
            pushAttribute(attributes, "gen_ai.usage.total_tokens", usage.totalTokens);
        }

        // Cloudflare AI Gateway telemetry — additive, only present when the
        // call was routed through a gateway (LUNORA_AI_GATEWAY_*). `pushAttribute`
        // skips the nullish fields, so a direct-provider call emits none of these.
        // The end event carries `providerMetadata`; the resolved call value is the
        // fallback, because only it carries the `cf-aig-*` response headers.
        const gateway = summarizeGatewayTelemetry(event) ?? summarizeGatewayTelemetry(result);

        if (gateway) {
            pushAttribute(attributes, "gen_ai.response.cached", gateway.cached);
            pushAttribute(attributes, "cf.aig.log_id", gateway.logId);
        }

        // A provider-reported cost always wins; without a gateway the cost
        // is derived from token usage and the price table, so spend stays
        // visible off Cloudflare too. The two are never conflated — the
        // source is stamped alongside, exactly as the RAG embed span does.
        const reportedCost = gateway?.cost;
        const cost =
            reportedCost ??
            (typeof modelId === "string" ? estimateModelCost(modelId, { inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens }) : undefined);

        if (cost !== undefined) {
            pushAttribute(attributes, "gen_ai.usage.cost", cost);
            pushAttribute(attributes, "lunora.usage.cost.source", reportedCost === undefined ? "estimated" : "provider");
        }

        if (recordInputs) {
            pushAttribute(attributes, "gen_ai.prompt", messages);
        }

        if (recordOutputs) {
            pushAttribute(attributes, "gen_ai.completion", contentText(readField(event, "content") ?? readField(result, "content")));
        }

        emitSpan(typeof modelId === "string" ? `chat ${modelId}` : "language_model_call", startTs, ok, message, attributes);
    };

    /** Open a call's entry unless one already exists (both entry points may fire). */
    const openCall = (callId: string, source: unknown): void => {
        if (inFlight.has(callId)) {
            return;
        }

        inFlight.set(callId, {
            messages: readField(source, "messages"),
            modelId: readField(source, "modelId"),
            provider: readField(source, "provider"),
            result: undefined,
            startTs: Date.now(),
        });
    };

    /** Close every still-open call with the same failure — see `onAbort` / `onError`. */
    const failOpenCalls = (message: string): void => {
        // A Map iterator tolerates deletion of the entry it just yielded, which is
        // exactly what `closeCall` does.
        for (const callId of inFlight.keys()) {
            closeCall(callId, false, message, undefined);
        }
    };

    /**
     * Close a call that is still open when the SDK reports the step, or the whole
     * operation, finished.
     *
     * A provider that reports a mid-stream failure the protocol way — an in-band
     * `{ type: "error" }` part — never produces a model-call-end event, so this is
     * the only signal that the call is over, and `finishReason: "error"` is the
     * only thing that says it failed. A no-op once `onLanguageModelCallEnd` has
     * already closed the call. A provider whose stream REJECTS outright dispatches
     * no telemetry callback at all in ai@7.0.59, so such a call reports no span
     * rather than a false success.
     */
    const closeFromLifecycle = (event: unknown): void => {
        const callId = readField(event, "callId");

        if (typeof callId !== "string" || !inFlight.has(callId)) {
            return;
        }

        // `finishReason` is the unified string on the lifecycle events, but the
        // provider protocol's own shape is `{ unified, raw }` — read both so a
        // failure is never rounded up to a success by an event shape.
        const finishReason = readField(event, "finishReason");
        const failed = finishReason === "error" || readField(finishReason, "unified") === "error";

        closeCall(callId, !failed, failed ? "the model call ended with an error" : undefined, event);
    };

    return {
        executeLanguageModelCall: async (options_) => {
            const { callId } = options_;

            openCall(callId, options_);

            try {
                // Awaited rather than returned untouched so the resolved value is on
                // the entry BEFORE `onLanguageModelCallEnd` fires — the gateway's
                // `cf-aig-*` response headers live on it and nowhere else. The value
                // and any rejection pass through unchanged.
                const result = await options_.execute();
                const call = inFlight.get(callId);

                if (call !== undefined) {
                    call.result = result;
                }

                return result;
            } catch (error) {
                // The provider call itself failed, so this IS the end of the span and
                // no end event will follow.
                closeCall(callId, false, error instanceof Error ? error.message : String(error), undefined);

                throw error;
            }
        },
        onAbort: () => {
            // A barge-in or cancelled stream produces neither an end event nor a
            // rejection from `execute()`, which already resolved at first byte.
            failOpenCalls("aborted");
        },
        onEnd: (event: unknown) => {
            closeFromLifecycle(event);
        },
        onError: (event: unknown) => {
            // An unrecoverable failure AFTER `execute()` resolved (ai@7 dispatches
            // `{ callId, error }`). Without this the call would be reported as the
            // ~1 ms success `execute()`'s early resolution implied.
            const raw = readField(event, "error") ?? event;

            failOpenCalls(raw instanceof Error ? raw.message : String(raw));
        },
        onLanguageModelCallEnd: (event: unknown) => {
            const callId = readField(event, "callId");

            if (typeof callId !== "string") {
                return;
            }

            // Fired after the response has been normalized and parsed — for a stream
            // that is after its `finish` part, so this is the first moment the call's
            // real duration AND its token usage are both known.
            closeCall(callId, true, undefined, event);
        },
        onLanguageModelCallStart: (event: unknown) => {
            const callId = readField(event, "callId");

            // `executeLanguageModelCall` normally opens the entry; this is the
            // backstop for a host that dispatches the lifecycle events without the
            // execution wrapper, so a call is never reported with no start time.
            if (typeof callId === "string") {
                openCall(callId, event);
            }
        },
        onStepEnd: (event: unknown) => {
            closeFromLifecycle(event);
        },
        executeTool: (options_) => {
            const startTs = Date.now();
            const toolName = toolNameOf(options_);

            const promise = options_.execute();

            const emit = (ok: boolean, message: string | undefined): void => {
                const attributes: OtlpAttribute[] = [];

                pushAttribute(attributes, "gen_ai.operation.name", "execute_tool");
                pushAttribute(attributes, "gen_ai.tool.name", toolName);
                pushAttribute(attributes, "gen_ai.tool.call.id", readField(options_, "toolCallId"));

                if (recordInputs) {
                    pushAttribute(attributes, "gen_ai.tool.input", toolInputOf(options_));
                }

                emitSpan(typeof toolName === "string" ? `execute_tool ${toolName}` : "execute_tool", startTs, ok, message, attributes);
            };

            observeSettled(promise, emit);

            return promise;
        },
    };
};
