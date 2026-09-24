import type { LanguageModel, LanguageModelMiddleware } from "ai";
import { wrapLanguageModel } from "ai";

import { estimateModelCost } from "./pricing";
import type { AiMetrics, AiSpan, AiTelemetry } from "./types";
import reportedCostOf from "./usage";

/** The already-built (non-string) arm of {@link LanguageModel} — what `wrapLanguageModel` takes. */
type LanguageModelObject = Exclude<LanguageModel, string>;

/**
 * The slice of a finished call's result that usage accounting reads. Structural
 * rather than the spec's `LanguageModelV4Usage` so a provider that omits a
 * token bucket (they are all optional in practice) never trips a property read.
 */
interface CallOutcome {
    providerMetadata?: unknown;
    usage?: {
        inputTokens?: { total?: number };
        outputTokens?: { total?: number };
    };
}

/** A finite, non-negative token count, or `undefined`. */
const tokenCount = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/**
 * Attach one call's usage to its span and count it into the function's durable
 * metric series. A provider-reported (gateway) cost always wins over an
 * estimate, and the source is stamped next to it so a dashboard never presents
 * a derived number as a measured one.
 */
const recordUsage = (modelId: string, outcome: CallOutcome, span: AiSpan | undefined, metrics: AiMetrics | undefined): void => {
    const inputTokens = tokenCount(outcome.usage?.inputTokens?.total);
    const outputTokens = tokenCount(outcome.usage?.outputTokens?.total);
    const reported = reportedCostOf(outcome.providerMetadata);
    const cost = reported ?? estimateModelCost(modelId, { inputTokens, outputTokens });
    const costSource = reported === undefined ? "estimated" : "provider";
    const modelAttributes = { "gen_ai.request.model": modelId };

    if (inputTokens !== undefined) {
        span?.setAttribute("gen_ai.usage.input_tokens", inputTokens);
        metrics?.count("gen_ai.usage.input_tokens", inputTokens, modelAttributes);
    }

    if (outputTokens !== undefined) {
        span?.setAttribute("gen_ai.usage.output_tokens", outputTokens);
        metrics?.count("gen_ai.usage.output_tokens", outputTokens, modelAttributes);
    }

    if (cost !== undefined) {
        span?.setAttributes({ "gen_ai.usage.cost": cost, "lunora.usage.cost.source": costSource });
        metrics?.count("gen_ai.usage.cost", cost, { ...modelAttributes, "lunora.usage.cost.source": costSource });
    }
};

/**
 * Middleware that opens an `ai.generate` / `ai.stream` span around every model
 * call and records its token usage and cost — on the span (live trace ring)
 * and as `gen_ai.usage.*` counters (the durable, per-function history Studio's
 * AI usage view reads).
 *
 * A stream's span stays open until the stream finishes, so its duration is the
 * whole generation rather than the time to the first byte. A consumer that
 * abandons the stream leaves that span unfinished; it is dropped with the
 * request rather than reported with made-up numbers.
 */
const usageMiddleware = (modelId: string, { metrics, trace }: AiTelemetry): LanguageModelMiddleware => {
    const attributes = { "gen_ai.operation.name": "chat", "gen_ai.request.model": modelId };

    return {
        wrapGenerate: async ({ doGenerate }) => {
            if (trace === undefined) {
                const result = await doGenerate();

                recordUsage(modelId, result, undefined, metrics);

                return result;
            }

            return trace(
                "ai.generate",
                async (_trace, span) => {
                    const result = await doGenerate();

                    recordUsage(modelId, result, span, metrics);

                    return result;
                },
                attributes,
            );
        },

        wrapStream: async ({ doStream }) => {
            type StreamResult = Awaited<ReturnType<typeof doStream>>;

            const instrument = (result: StreamResult, onFinish: (outcome: CallOutcome) => void): StreamResult => {
                let outcome: CallOutcome = {};

                return {
                    ...result,
                    stream: result.stream.pipeThrough(
                        new TransformStream({
                            flush: () => {
                                onFinish(outcome);
                            },
                            transform: (part, controller) => {
                                if (part.type === "finish") {
                                    outcome = { providerMetadata: part.providerMetadata, usage: part.usage };
                                }

                                controller.enqueue(part);
                            },
                        }),
                    ),
                };
            };

            if (trace === undefined) {
                return instrument(await doStream(), (outcome) => {
                    recordUsage(modelId, outcome, undefined, metrics);
                });
            }

            const streamed = Promise.withResolvers<StreamResult>();
            const finished = Promise.withResolvers<CallOutcome>();

            trace(
                "ai.stream",
                async (_trace, span) => {
                    // A failed dispatch throws here, so the tracer marks the span
                    // errored before the rejection reaches the caller below.
                    streamed.resolve(instrument(await doStream(), finished.resolve));
                    recordUsage(modelId, await finished.promise, span, metrics);
                },
                attributes,
            ).catch(streamed.reject);

            return streamed.promise;
        },
    };
};

/** A model's stable id for attribution, defensively; `"unknown"` keeps the series grouped rather than dropped. */
const modelIdOf = (model: LanguageModelObject): string => {
    const id = (model as { modelId?: unknown }).modelId;

    return typeof id === "string" && id.length > 0 ? id : "unknown";
};

/**
 * Wrap a resolved language model so every call through it is traced and
 * counted. `requestedId` is the id the caller asked for (e.g.
 * `anthropic/claude-sonnet-5`), which is what spend should be grouped by even
 * when the provider reports a different internal id. Without telemetry — or for
 * a bare model-id string, which has nothing to wrap — the model passes through.
 */
const instrumentModel = (model: LanguageModel, telemetry: AiTelemetry | undefined, requestedId?: string): LanguageModel => {
    let instrumented: LanguageModel = model;

    if (telemetry !== undefined && typeof model !== "string") {
        instrumented = wrapLanguageModel({ middleware: usageMiddleware(requestedId ?? modelIdOf(model), telemetry), model });
    }

    return instrumented;
};

export default instrumentModel;
