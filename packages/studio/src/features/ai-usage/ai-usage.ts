/**
 * Fold the `gen_ai.*` telemetry `ctx.ai.model(...)` and `defineRag` emit into an AI-spend readout.
 *
 * Same two-halves shape as the Evals page. The **durable** half is three counter
 * series in the per-minute metric history — `gen_ai.usage.input_tokens`,
 * `gen_ai.usage.output_tokens` and `gen_ai.usage.cost`, one `ctx.metrics.count`
 * per model call, each series already keyed by `functionPath` and carrying the
 * `gen_ai.request.model` attribute. It survives hibernation and backs every
 * total, breakdown and trend. The **live** half is the `ai.generate` / `ai.stream`
 * spans in the shard's bounded trace ring: no history, but each one names its
 * trace, which is what makes a recent call clickable.
 *
 * How a counter bucket reads (see `@lunora/observability`'s `metric-history.ts`):
 * every `count(name, value)` folds into its minute bucket as `sum += value` and
 * `count += 1`. So for these series `sum` is the tokens (or USD) spent in that
 * minute and `count` is the number of model calls that reported it. `last`,
 * `min` and `max` describe a single call and are never totals.
 */
import type { MetricHistoryPoint, MetricHistoryResult, MetricHistorySeries, TraceSummary } from "../../lib/admin";

const INPUT_TOKENS = "gen_ai.usage.input_tokens";
const OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
const COST = "gen_ai.usage.cost";
const MODEL_ATTRIBUTE = "gen_ai.request.model";
const COST_SOURCE_ATTRIBUTE = "lunora.usage.cost.source";

/** Span names a model call (`ctx.ai.model(...)`) or a RAG embed (`defineRag`) is recorded under. */
const AI_SPAN_NAMES = new Set(["ai.embed", "ai.generate", "ai.stream"]);

/** Width of one metric-history bucket — the trend's gap-fill step. */
const BUCKET_MS = 60_000;

/** Upper bound on gap-filled trend buckets: the history's own 24h retention. */
const MAX_TREND_BUCKETS = 1440;

/** Where a model id is unknown (a pre-contract emitter), rows group under this key. */
const UNKNOWN_MODEL = "unknown";

/**
 * Who priced a call. `provider` is what the gateway billed; `estimated` was
 * derived from a price table and must never be shown as a measurement. A cost
 * series without a recognised source is treated as estimated — the
 * conservative reading.
 */
type CostSource = "estimated" | "provider";

/** Tokens, calls and spend for one slice of usage. Cost is split by source, never pre-summed. */
interface UsageTotals {
    calls: number;
    /** USD derived from a price table. */
    estimatedCost: number;
    inputTokens: number;
    outputTokens: number;
    /** USD the provider reported. */
    providerCost: number;
}

/** One row of a breakdown table: a function path or a model id with its totals. */
interface UsageRow extends UsageTotals {
    key: string;
}

/** One minute of spend, split by source so a chart can keep estimates visually distinct. */
interface CostTrendPoint {
    bucketMs: number;
    estimatedCost: number;
    providerCost: number;
}

/** One model call observed on a live trace span — the clickable half. */
interface AiCall {
    cost?: number;
    costSource?: CostSource;
    functionPath: string;
    inputTokens?: number;
    model: string;
    ok: boolean;
    outputTokens?: number;
    startTs: number;
    /** `true` for an `ai.stream` span, `false` for `ai.generate`. */
    streaming: boolean;
    traceId: string;
}

/** Everything the AI usage page renders. */
interface AiUsage {
    byFunction: UsageRow[];
    byModel: UsageRow[];
    /** Recent calls from the live ring, newest first. */
    calls: AiCall[];

    /**
     * Which half the totals came from: `history` (durable buckets), `live` (the
     * trace ring alone — no history yet, and it resets on hibernation) or `none`.
     */
    source: "history" | "live" | "none";
    totals: UsageTotals;
    /** Per-minute spend, oldest first, gaps filled with zero. Empty without history. */
    trend: CostTrendPoint[];
}

/** How a displayed cost was obtained — drives the "estimated" labelling. */
type CostProvenance = "estimated" | "mixed" | "none" | "provider";

const emptyTotals = (): UsageTotals => {
    return { calls: 0, estimatedCost: 0, inputTokens: 0, outputTokens: 0, providerCost: 0 };
};

const stringAttribute = (attributes: Record<string, unknown> | undefined, key: string): string | undefined => {
    const value = attributes?.[key];

    return typeof value === "string" && value !== "" ? value : undefined;
};

const numberAttribute = (attributes: Record<string, unknown> | undefined, key: string): number | undefined => {
    const value = attributes?.[key];

    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const costSourceOf = (attributes: Record<string, unknown> | undefined): CostSource =>
    stringAttribute(attributes, COST_SOURCE_ATTRIBUTE) === "provider" ? "provider" : "estimated";

const sumOf = (points: ReadonlyArray<MetricHistoryPoint>, pick: (point: MetricHistoryPoint) => number): number =>
    points.reduce((total, point) => total + pick(point), 0);

/** Total USD for a slice, both sources together. */
const totalCost = (totals: UsageTotals): number => totals.providerCost + totals.estimatedCost;

/** Classify a slice's spend so the UI can label an estimate as one. */
const costProvenance = (totals: Pick<UsageTotals, "estimatedCost" | "providerCost">): CostProvenance => {
    if (totals.estimatedCost > 0) {
        return totals.providerCost > 0 ? "mixed" : "estimated";
    }

    return totals.providerCost > 0 ? "provider" : "none";
};

/** Two slices' totals added field by field. */
const addTotals = (a: UsageTotals, b: UsageTotals): UsageTotals => {
    return {
        calls: a.calls + b.calls,
        estimatedCost: a.estimatedCost + b.estimatedCost,
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        providerCost: a.providerCost + b.providerCost,
    };
};

/** The totals of one `(function, model)` pair, the finest grain both halves share. */
interface UsageSlice extends UsageTotals {
    functionPath: string;
    model: string;
}

/**
 * One pair's totals from its series. A call counts into up to three series
 * (input tokens, output tokens, cost — whichever it reported), so the pair's
 * call count is the largest series' bucket count, never their sum. Cost series
 * are split by source, but a call has only one source, so those counts add.
 */
const pairTotals = (series: ReadonlyArray<MetricHistorySeries>): UsageTotals => {
    const totals = emptyTotals();
    let inputCalls = 0;
    let outputCalls = 0;
    let costCalls = 0;

    for (const entry of series) {
        const sum = sumOf(entry.points, (point) => point.sum);
        const count = sumOf(entry.points, (point) => point.count);

        if (entry.name === INPUT_TOKENS) {
            totals.inputTokens += sum;
            inputCalls += count;
        } else if (entry.name === OUTPUT_TOKENS) {
            totals.outputTokens += sum;
            outputCalls += count;
        } else {
            costCalls += count;

            if (costSourceOf(entry.attributes) === "provider") {
                totals.providerCost += sum;
            } else {
                totals.estimatedCost += sum;
            }
        }
    }

    totals.calls = Math.max(inputCalls, outputCalls, costCalls);

    return totals;
};

/** Most expensive first, then most tokens, then by key — a stable leaderboard. */
const byWeight = (a: UsageRow, b: UsageRow): number =>
    totalCost(b) - totalCost(a) || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) || a.key.localeCompare(b.key);

/** Group slices by `keyOf` into breakdown rows, heaviest first. */
const groupRows = (slices: ReadonlyArray<UsageSlice>, keyOf: (slice: UsageSlice) => string): UsageRow[] => {
    const rows = new Map<string, UsageRow>();

    for (const slice of slices) {
        const key = keyOf(slice);

        rows.set(key, { key, ...addTotals(rows.get(key) ?? emptyTotals(), slice) });
    }

    return [...rows.values()].toSorted(byWeight);
};

/** The `gen_ai.usage.*` series in a metric-history payload. */
const aiSeriesOf = (history: MetricHistoryResult | undefined): MetricHistorySeries[] =>
    (history?.series ?? []).filter((series) => series.name === INPUT_TOKENS || series.name === OUTPUT_TOKENS || series.name === COST);

const modelOfSeries = (series: MetricHistorySeries): string => stringAttribute(series.attributes, MODEL_ATTRIBUTE) ?? UNKNOWN_MODEL;

/** The durable half as `(function, model)` slices. */
const historySlices = (series: ReadonlyArray<MetricHistorySeries>): UsageSlice[] => {
    const pairs = new Map<string, { functionPath: string; model: string; series: MetricHistorySeries[] }>();

    for (const entry of series) {
        const model = modelOfSeries(entry);
        const key = JSON.stringify([entry.functionPath, model]);
        const pair = pairs.get(key) ?? { functionPath: entry.functionPath, model, series: [] };

        pair.series.push(entry);
        pairs.set(key, pair);
    }

    return [...pairs.values()].map(({ functionPath, model, series: pairSeries }) => {
        return { functionPath, model, ...pairTotals(pairSeries) };
    });
};

/** Per-minute cost, split by source, with empty minutes between the first and last bucket filled as zero. */
const buildTrend = (series: ReadonlyArray<MetricHistorySeries>): CostTrendPoint[] => {
    const buckets = new Map<number, CostTrendPoint>();

    for (const entry of series) {
        if (entry.name !== COST) {
            continue;
        }

        const provider = costSourceOf(entry.attributes) === "provider";

        for (const point of entry.points) {
            const bucket = buckets.get(point.bucketMs) ?? { bucketMs: point.bucketMs, estimatedCost: 0, providerCost: 0 };

            if (provider) {
                bucket.providerCost += point.sum;
            } else {
                bucket.estimatedCost += point.sum;
            }

            buckets.set(point.bucketMs, bucket);
        }
    }

    const keys = [...buckets.keys()].toSorted((a, b) => a - b);
    const first = keys[0];
    const last = keys.at(-1);

    if (first === undefined || last === undefined) {
        return [];
    }

    // A counter's silent minute is a real zero, so a gap is filled rather than
    // letting the bars close ranks and draw a busier hour than there was. The
    // window is clamped to the history's retention, newest end kept.
    const start = Math.max(first, last - (MAX_TREND_BUCKETS - 1) * BUCKET_MS);
    const trend: CostTrendPoint[] = [];

    for (let bucketMs = start; bucketMs <= last; bucketMs += BUCKET_MS) {
        trend.push(buckets.get(bucketMs) ?? { bucketMs, estimatedCost: 0, providerCost: 0 });
    }

    return trend;
};

/** Extract every `ai.generate` / `ai.stream` span from the live trace ring, newest first. */
const extractAiCalls = (traces: ReadonlyArray<TraceSummary>): AiCall[] => {
    const calls: AiCall[] = [];

    for (const trace of traces) {
        for (const span of trace.spans) {
            if (!AI_SPAN_NAMES.has(span.name)) {
                continue;
            }

            const { attributes } = span;
            const cost = numberAttribute(attributes, COST);
            const inputTokens = numberAttribute(attributes, INPUT_TOKENS);
            const outputTokens = numberAttribute(attributes, OUTPUT_TOKENS);

            calls.push({
                ...(cost === undefined ? {} : { cost, costSource: costSourceOf(attributes) }),
                functionPath: trace.functionPath,
                ...(inputTokens === undefined ? {} : { inputTokens }),
                model: stringAttribute(attributes, MODEL_ATTRIBUTE) ?? UNKNOWN_MODEL,
                ok: span.ok,
                ...(outputTokens === undefined ? {} : { outputTokens }),
                // Spans carry an offset from the trace anchor, not a wall clock.
                startTs: trace.startTs + span.offsetMs,
                streaming: span.name === "ai.stream",
                traceId: trace.traceId,
            });
        }
    }

    return calls.toSorted((a, b) => b.startTs - a.startTs);
};

/** The live half: every span is one call, whether or not it reported usage. */
const liveSlices = (calls: ReadonlyArray<AiCall>): UsageSlice[] =>
    calls.map((call) => {
        const cost = call.cost ?? 0;

        return {
            calls: 1,
            estimatedCost: call.costSource === "provider" ? 0 : cost,
            functionPath: call.functionPath,
            inputTokens: call.inputTokens ?? 0,
            model: call.model,
            outputTokens: call.outputTokens ?? 0,
            providerCost: call.costSource === "provider" ? cost : 0,
        };
    });

/**
 * Build the whole readout. Totals and breakdowns prefer the durable history;
 * with none (a fresh deployment, or a worker whose history read failed) they
 * fall back to the live ring so the page is still useful — flagged via
 * `source` so the panel can say those numbers reset on hibernation.
 */
const buildAiUsage = (history: MetricHistoryResult | undefined, traces: ReadonlyArray<TraceSummary>): AiUsage => {
    const series = aiSeriesOf(history);
    const calls = extractAiCalls(traces);
    const fromHistory = series.length > 0;
    const slices = fromHistory ? historySlices(series) : liveSlices(calls);
    let totals = emptyTotals();
    let source: AiUsage["source"] = "none";

    for (const slice of slices) {
        totals = addTotals(totals, slice);
    }

    if (fromHistory) {
        source = "history";
    } else if (calls.length > 0) {
        source = "live";
    }

    return {
        byFunction: groupRows(slices, (slice) => slice.functionPath),
        byModel: groupRows(slices, (slice) => slice.model),
        calls,
        source,
        totals,
        trend: fromHistory ? buildTrend(series) : [],
    };
};

export { buildAiUsage, costProvenance, extractAiCalls, totalCost };
export type { AiCall, AiUsage, CostProvenance, CostSource, CostTrendPoint, UsageRow, UsageTotals };
