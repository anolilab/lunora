import { estimateModelCost } from "./pricing";
import type { AiMetrics, AiSpan } from "./types";

/**
 * The slice of a finished call's result that usage accounting reads. Structural
 * rather than the spec's `LanguageModelV4Usage` so a provider that omits a
 * token bucket (they are all optional in practice) never trips a property read.
 */
interface CallOutcome {
    providerMetadata?: unknown;
    usage?: {
        inputTokens?: { total?: unknown };
        outputTokens?: { total?: unknown };
    };
}

/** A finite, non-negative token count, or `undefined`. */
const tokenCount = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/**
 * Read a call's dollar cost from AI SDK `providerMetadata`, defensively. AI
 * Gateway surfaces per-request cost there (under a provider bag's `cost` field)
 * once cost routing is enabled; until then it is absent and this returns
 * `undefined`. Probing rather than hard-depending keeps a span correct with or
 * without a gateway in front.
 */
const reportedCostOf = (providerMetadata: unknown): number | undefined => {
    if (typeof providerMetadata !== "object" || providerMetadata === null) {
        return undefined;
    }

    for (const bag of Object.values(providerMetadata as Record<string, unknown>)) {
        if (typeof bag === "object" && bag !== null) {
            const { cost } = bag as { cost?: unknown };

            if (typeof cost === "number" && Number.isFinite(cost)) {
                return cost;
            }
        }
    }

    return undefined;
};

/** An AI SDK model's stable id, defensively; `undefined` when the provider does not name it. */
const modelIdOf = (model: unknown): string | undefined => {
    const id = (model as { modelId?: unknown }).modelId;

    return typeof id === "string" && id.length > 0 ? id : undefined;
};

/**
 * Attach one call's usage to its span and count it into the function's durable
 * metric series — the one accounting step every model and embedding call goes
 * through. A provider-reported (gateway) cost always wins over an estimate, and
 * the source is stamped next to it so a dashboard never presents a derived
 * number as a measured one.
 */
const recordUsage = (modelId: string | undefined, outcome: CallOutcome, span: AiSpan | undefined, metrics: AiMetrics | undefined): void => {
    const inputTokens = tokenCount(outcome.usage?.inputTokens?.total);
    const outputTokens = tokenCount(outcome.usage?.outputTokens?.total);
    const reported = reportedCostOf(outcome.providerMetadata);
    const cost = reported ?? estimateModelCost(modelId, { inputTokens, outputTokens });
    const costSource = reported === undefined ? "estimated" : "provider";
    // `"unknown"` keeps an unnamed model's series grouped rather than dropped.
    const modelAttributes = { "gen_ai.request.model": modelId ?? "unknown" };

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

export type { CallOutcome };
export { modelIdOf, recordUsage };
