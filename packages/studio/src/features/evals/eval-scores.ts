/**
 * Pull eval scores out of the two places `recordEvaluation` emits them.
 *
 * Both halves matter and neither is redundant: the **durable** half is the
 * `gen_ai.evaluation.<name>.score` metric series, persisted in per-minute
 * buckets, which is the only thing that can back a trend across a hibernation.
 * The **live** half is the same key as a span attribute in the shard's bounded
 * trace ring — no history, but it carries the trace id, which is what makes a
 * score clickable back to the generation that earned it.
 */
import type { MetricHistoryPoint, MetricHistoryResult, TraceSummary } from "../../lib/admin";

/** `gen_ai.evaluation.<name>.score` — the name is the capture group. */
const SCORE_KEY = /^gen_ai\.evaluation\.(.+)\.score$/u;

/** One score observed on a trace span: the live, clickable half. */
export interface EvalRun {
    /** Categorical verdict from the sibling `.label` attribute, when the scorer emitted one. */
    label?: string;
    /** Eval name (the key's middle segment). */
    name: string;
    score: number;
    /** The span that carried the score — names the generation being graded. */
    spanName: string;
    startTs: number;
    /** Trace the span belongs to, for the "open in Traces" hand-off. */
    traceId: string;
}

/** One eval's durable trend: its per-minute buckets, oldest first. */
export interface EvalTrend {
    name: string;
    points: MetricHistoryPoint[];
}

/** Everything the panel shows for one eval, live and durable halves joined by name. */
export interface EvalCard {
    /** Most recent score, whichever half saw it last. */
    latest?: number;
    max?: number;
    mean?: number;
    min?: number;
    name: string;
    /** Buckets for the sparkline; empty when only live scores exist. */
    points: MetricHistoryPoint[];
    /** Recent individual runs, newest first — each links to its trace. */
    runs: EvalRun[];
}

/** Extract every eval score carried by a trace span's attributes. */
export const extractEvalRuns = (traces: ReadonlyArray<TraceSummary>): EvalRun[] => {
    const runs: EvalRun[] = [];

    for (const trace of traces) {
        for (const span of trace.spans) {
            for (const [key, value] of Object.entries(span.attributes ?? {})) {
                const matched = SCORE_KEY.exec(key);

                if (!matched || typeof value !== "number") {
                    continue;
                }

                const name = matched[1] as string;
                const label = span.attributes?.[`gen_ai.evaluation.${name}.label`];

                runs.push({
                    ...(typeof label === "string" ? { label } : {}),
                    name,
                    score: value,
                    spanName: span.name,
                    // Spans carry an offset from the trace anchor, not a wall clock.
                    startTs: trace.startTs + span.offsetMs,
                    traceId: trace.traceId,
                });
            }
        }
    }

    return runs.toSorted((a, b) => b.startTs - a.startTs);
};

/** Extract the durable trend for every eval that has one. */
export const extractEvalTrends = (history: MetricHistoryResult | undefined): EvalTrend[] => {
    const trends: EvalTrend[] = [];

    for (const series of history?.series ?? []) {
        const matched = SCORE_KEY.exec(series.name);

        if (matched) {
            trends.push({ name: matched[1] as string, points: series.points });
        }
    }

    return trends;
};

/**
 * Join the two halves into one card per eval name.
 *
 * The summary (min/mean/max) prefers the durable buckets when they exist and
 * falls back to the live ring otherwise, so an app that has not passed
 * `ctx.metrics` to `recordEvaluation` still gets a useful panel — just without
 * a trend that survives a restart.
 */
export const buildEvalCards = (runs: ReadonlyArray<EvalRun>, trends: ReadonlyArray<EvalTrend>): EvalCard[] => {
    const names = new Set<string>([...runs.map((run) => run.name), ...trends.map((trend) => trend.name)]);
    const cards: EvalCard[] = [];

    for (const name of names) {
        const ownRuns = runs.filter((run) => run.name === name);
        const points = trends.find((trend) => trend.name === name)?.points ?? [];
        const values = points.length > 0 ? points.map((point) => point.last) : ownRuns.map((run) => run.score);
        const latest = points.at(-1)?.last ?? ownRuns[0]?.score;

        cards.push({
            ...(latest === undefined ? {} : { latest }),
            ...(values.length === 0
                ? {}
                : {
                      max: Math.max(...values),
                      mean: values.reduce((total, value) => total + value, 0) / values.length,
                      min: Math.min(...values),
                  }),
            name,
            points,
            runs: ownRuns,
        });
    }

    return cards.toSorted((a, b) => a.name.localeCompare(b.name));
};
