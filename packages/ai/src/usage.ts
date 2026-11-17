import { estimateImageCost, estimateModelCost } from "./pricing";
import type { AiMetrics, AiSpan } from "./types";

/**
 * The slice of a finished call's result that usage accounting reads. Structural
 * rather than the spec's `LanguageModelV4Usage` so a provider that omits a
 * token bucket (they are all optional in practice) never trips a property read.
 *
 * The totals already include their breakdowns: `inputTokens.total` covers the
 * cache-read and cache-write tokens, and `outputTokens.total` covers reasoning.
 * The breakdowns are reported alongside, never added on top.
 */
interface CallOutcome {
    providerMetadata?: unknown;
    usage?: {
        inputTokens?: { cacheRead?: unknown; cacheWrite?: unknown; total?: unknown };
        outputTokens?: { reasoning?: unknown; total?: unknown };
    };
}

/**
 * Whether a call's token report is whole. `complete`: every total the call should
 * carry was reported. `partial`: some were, not all. `unavailable`: none were.
 * Only a complete call is priced by estimate; a partial one would understate.
 * @experimental
 */
type UsageStatus = "complete" | "partial" | "unavailable";

/**
 * One call's token counts, already sanitised by {@link tokenCount} or
 * {@link breakdownCount}. The breakdowns are subsets of the totals, never added on top.
 * @experimental
 */
interface UsageCounts {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
}

/**
 * The span attribute each token bucket is recorded under. Every telemetry surface
 * in the stack names a bucket through this map, so a dashboard reads one spelling.
 * @experimental
 */
const USAGE_ATTRIBUTE: Readonly<Record<keyof UsageCounts, string>> = {
    cacheReadTokens: "gen_ai.usage.cache_read.input_tokens",
    cacheWriteTokens: "gen_ai.usage.cache_creation.input_tokens",
    inputTokens: "gen_ai.usage.input_tokens",
    outputTokens: "gen_ai.usage.output_tokens",
    reasoningTokens: "gen_ai.usage.reasoning.output_tokens",
};

/**
 * A finite, non-negative token count, or `undefined`.
 * @experimental
 */
const tokenCount = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/**
 * A breakdown count that is reported and non-zero, or `undefined`. The AI SDK fills
 * 0 in for a detail the provider never sent, so a zero cannot be told from absence
 * and adds nothing to a sum anyway.
 * @experimental
 */
const breakdownCount = (value: unknown): number | undefined => {
    const count = tokenCount(value);

    return count === undefined || count === 0 ? undefined : count;
};

/**
 * Grade a call's token report. Shared by every surface that reports usage, so the
 * same counts always grade the same way. `expectsOutput` is `false` for an
 * embedding call, which has no output total to report.
 * @experimental
 */
const usageStatus = (counts: UsageCounts | undefined, { expectsOutput = true }: { expectsOutput?: boolean } = {}): UsageStatus => {
    const complete = counts?.inputTokens !== undefined && (!expectsOutput || counts.outputTokens !== undefined);
    // Only the five buckets count: a caller's `totalTokens` alone cannot be priced, so it must not grade as reported.
    const anyReported = (Object.keys(USAGE_ATTRIBUTE) as (keyof UsageCounts)[]).some((key) => counts?.[key] !== undefined);

    if (complete) {
        return "complete";
    }

    return anyReported ? "partial" : "unavailable";
};

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
 *
 * Every span carries `lunora.usage.status`. Each token bucket is emitted only when
 * the provider reported it, so an absent bucket is never a counted zero. Cache and
 * reasoning counts are subsets of the input and output totals. `expectsOutput` is
 * `false` for an embedding call, which has no output bucket to report.
 */
const recordUsage = (
    modelId: string | undefined,
    outcome: CallOutcome,
    span: AiSpan | undefined,
    metrics: AiMetrics | undefined,
    { expectsOutput = true }: { expectsOutput?: boolean } = {},
): void => {
    const counts: UsageCounts = {
        cacheReadTokens: breakdownCount(outcome.usage?.inputTokens?.cacheRead),
        cacheWriteTokens: breakdownCount(outcome.usage?.inputTokens?.cacheWrite),
        inputTokens: tokenCount(outcome.usage?.inputTokens?.total),
        outputTokens: tokenCount(outcome.usage?.outputTokens?.total),
        reasoningTokens: breakdownCount(outcome.usage?.outputTokens?.reasoning),
    };
    const status = usageStatus(counts, { expectsOutput });

    const reported = reportedCostOf(outcome.providerMetadata);
    // An estimate is priced only from a complete report: a partial one would understate the call.
    const cost = reported ?? (status === "complete" ? estimateModelCost(modelId, counts) : undefined);
    const costSource = reported === undefined ? "estimated" : "provider";
    // `"unknown"` keeps an unnamed model's series grouped rather than dropped.
    const modelAttributes = { "gen_ai.request.model": modelId ?? "unknown" };

    span?.setAttribute("lunora.usage.status", status);

    for (const key of Object.keys(USAGE_ATTRIBUTE) as (keyof UsageCounts)[]) {
        const value = counts[key];
        const name = USAGE_ATTRIBUTE[key];

        if (value !== undefined) {
            span?.setAttribute(name, value);
            metrics?.count(name, value, modelAttributes);
        }
    }

    if (cost !== undefined) {
        span?.setAttributes({ "gen_ai.usage.cost": cost, "lunora.usage.cost.source": costSource });
        metrics?.count("gen_ai.usage.cost", cost, { ...modelAttributes, "lunora.usage.cost.source": costSource });
    }
};

/**
 * Count one image call's estimated cost into the function's durable series. Images
 * are billed per image, not per token, and no provider reports a cost for them, so
 * the figure is always an estimate and is tagged as one.
 */
const recordImageUsage = (modelId: string, imageCount: number, metrics: AiMetrics | undefined): void => {
    const cost = estimateImageCost(modelId, imageCount);

    if (cost !== undefined) {
        metrics?.count("gen_ai.usage.cost", cost, { "gen_ai.request.model": modelId, "lunora.usage.cost.source": "estimated" });
    }
};

export type { CallOutcome, UsageCounts, UsageStatus };
export { breakdownCount, modelIdOf, recordImageUsage, recordUsage, tokenCount, USAGE_ATTRIBUTE, usageStatus };
