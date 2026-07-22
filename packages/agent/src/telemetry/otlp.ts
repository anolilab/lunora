import type { Telemetry } from "ai";

import type { OtlpAttribute, OtlpAttributeValue } from "../../../../shared/otlp";
import { encodeAttribute, mergeHeaders, otlpRandomHex, otlpUnixNano, wrapResourceSpans } from "../../../../shared/otlp";
import type { CommonOptions } from "./common";
import { contentText, readField, summarizeUsage, toolInputOf, toolNameOf } from "./common";

/**
 * Options for {@link otlpTelemetry}.
 * @experimental
 */
export interface OtlpTelemetryOptions extends CommonOptions {
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
 * An OTLP-over-HTTP telemetry integration for `@lunora/agent`.
 *
 * The OTLP counterpart to {@link sentryTelemetry} / {@link braintrustTelemetry}:
 * it wraps each language-model call and tool execution in an OTLP **span**
 * (`gen_ai.*` semantic-convention attributes — model, provider, token usage,
 * tool name) and ships it to a collector, so agent generations land in the same
 * trace store as the rest of an app's telemetry (the Lunora Cloud, or any OTel
 * collector). Plug it into `defineAgent({ telemetry: { isEnabled: true,
 * integrations: [otlpTelemetry({ endpoint, token })] } })`.
 *
 * Emitting inside the turn's execution wrapper means one span per **real** turn:
 * the agent loop memoizes each `step.do('llm:turn:N')`, so a Workflow replay
 * returns the cached result without re-invoking `execute`, and no duplicate span
 * is emitted. Privacy-safe by default — `recordInputs`/`recordOutputs` both
 * default `false`, so no prompt or generated text leaves the worker without an
 * explicit opt-in; only structural metadata + token counts are recorded.
 *
 * Each export is fire-and-forget (registered with `waitUntil` when supplied);
 * every rejection is swallowed so a flaky collector never surfaces to the run.
 *
 * Two deliberate differences from the SDK-backed integrations (`sentryTelemetry`
 * / `braintrustTelemetry`), which delegate to a host tracer:
 * - **No `onError`.** A failed call already emits a span with `status.code === 2`,
 *   so the failure is on the trace; there is no host client to also notify.
 * - **Flat, not nested.** Every span gets `traceId` (shared when `traceId` is set)
 *   but no `parentSpanId`, so model-call and tool spans are siblings under the run
 *   rather than a tree — OTLP has no ambient span context to parent to here.
 * @param options `endpoint` (+ optional `token`/`headers`/`serviceName`),
 * `traceId` to group a run's spans, `waitUntil`, and the `recordInputs`/
 * `recordOutputs` privacy flags.
 * @experimental
 */
export const otlpTelemetry = (options: OtlpTelemetryOptions): Telemetry => {
    const { endpoint, headers, recordInputs = false, recordOutputs = false, token, traceId: fixedTraceId, waitUntil } = options;
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

    return {
        executeLanguageModelCall: (options_) => {
            const startTs = Date.now();
            const modelId = readField(options_, "modelId");

            // Return the original promise unchanged (so the exact `PromiseLike<T>`
            // the caller expects flows through); a detached observer emits the span
            // once the call settles. Its `onRejected` handles the rejection in this
            // chain — no unhandled rejection — while the returned promise still
            // rejects for the caller.
            const promise = options_.execute();

            const emit = (ok: boolean, message: string | undefined, result: unknown): void => {
                const attributes: OtlpAttribute[] = [];

                pushAttribute(attributes, "gen_ai.operation.name", "chat");
                pushAttribute(attributes, "gen_ai.request.model", modelId);
                pushAttribute(attributes, "gen_ai.system", readField(options_, "provider"));

                const usage = summarizeUsage(readField(result, "usage"));

                if (usage) {
                    pushAttribute(attributes, "gen_ai.usage.input_tokens", usage.inputTokens);
                    pushAttribute(attributes, "gen_ai.usage.output_tokens", usage.outputTokens);
                    pushAttribute(attributes, "gen_ai.usage.total_tokens", usage.totalTokens);
                }

                if (recordInputs) {
                    pushAttribute(attributes, "gen_ai.prompt", readField(options_, "messages"));
                }

                if (recordOutputs) {
                    pushAttribute(attributes, "gen_ai.completion", contentText(readField(result, "content")));
                }

                emitSpan(typeof modelId === "string" ? `chat ${modelId}` : "language_model_call", startTs, ok, message, attributes);
            };

            promise.then(
                (result) => {
                    emit(true, undefined, result);
                },
                (error: unknown) => {
                    emit(false, error instanceof Error ? error.message : String(error), undefined);
                },
            );

            return promise;
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

            promise.then(
                () => {
                    emit(true, undefined);
                },
                (error: unknown) => {
                    emit(false, error instanceof Error ? error.message : String(error));
                },
            );

            return promise;
        },
    };
};
