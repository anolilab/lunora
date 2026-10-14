import type { ReactElement } from "react";

import ErrorAlert from "../../components/error-alert";
import { ShardInput } from "../../components/shard-input";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { useAdminQuery } from "../../hooks/use-admin-query";
import useOpenTrace from "../../hooks/use-open-trace";
import { useShardKey } from "../../hooks/use-shard-key";
import { useT } from "../../i18n/i18n-context";
import type { MetricHistoryResult, TracesResult, TraceSummary } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { formatTimestamp } from "../../lib/internal";
import { Sparkline } from "../reports/sparkline";
import type { EvalCard } from "./eval-scores";
import { buildEvalCards, extractEvalRuns, extractEvalTrends } from "./eval-scores";

/** Coerce a (possibly partial or pre-feature) `getTraces` payload into its `traces` array. */
const tracesOf = (result: TracesResult | undefined): TraceSummary[] => (Array.isArray(result?.traces) ? result.traces : []);

/** Scores are `[0, 1]`; two decimals is the resolution a scorer's verdict actually carries. */
const formatScore = (score: number | undefined): string => (score === undefined ? "—" : score.toFixed(2));

interface EvalCardViewProps {
    readonly card: EvalCard;
    readonly onOpenTrace?: (traceId: string) => void;
}

/** One eval: its headline score, the durable trend, and the recent graded runs. */
const EvalCardView = ({ card, onOpenTrace }: EvalCardViewProps): ReactElement => {
    const t = useT();

    return (
        <Card data-testid="ev-card">
            <CardContent className="flex flex-col gap-3 p-4">
                <div className="flex items-baseline justify-between gap-3">
                    <h3 className="font-mono text-sm font-semibold text-foreground" data-testid="ev-name">
                        {card.name}
                    </h3>
                    <span className="font-mono text-lg text-foreground" data-testid="ev-latest">
                        {formatScore(card.latest)}
                    </span>
                </div>

                <p className="font-mono text-xs text-muted-foreground" data-testid="ev-summary">
                    {t("min {min} · mean {mean} · max {max}", { max: formatScore(card.max), mean: formatScore(card.mean), min: formatScore(card.min) })}
                </p>

                {card.points.length > 1 ? (
                    <Sparkline
                        ariaLabel={t("Score trend for {name}", { name: card.name })}
                        className="h-10 w-full"
                        series={card.points.map((point) => point.last)}
                        testId="ev-trend"
                    />
                ) : (
                    // No trend rather than a misleading flat line: buckets only exist
                    // once `recordEvaluation` is handed `ctx.metrics`.
                    <p className="text-xs text-muted-foreground" data-testid="ev-no-trend">
                        {t("No durable history yet — pass ctx.metrics to recordEvaluation to chart a trend.")}
                    </p>
                )}

                <div className="flex flex-col gap-1">
                    {card.runs.slice(0, 5).map((run) => (
                        <div className="flex items-center justify-between gap-2 font-mono text-xs" data-testid="ev-run" key={`${run.traceId}:${run.spanName}`}>
                            <span className="truncate text-muted-foreground">
                                {formatTimestamp(run.startTs)} · {run.spanName}
                            </span>
                            <span className="flex items-center gap-2">
                                {run.label === undefined ? null : <Badge variant="outline">{run.label}</Badge>}
                                <span className="text-foreground">{formatScore(run.score)}</span>
                                {onOpenTrace === undefined ? null : (
                                    <button
                                        className="text-muted-foreground underline-offset-2 hover:underline"
                                        onClick={() => {
                                            onOpenTrace(run.traceId);
                                        }}
                                        title={t("Open the trace {trace}", { trace: run.traceId })}
                                        type="button"
                                    >
                                        {run.traceId.slice(0, 8)}
                                    </button>
                                )}
                            </span>
                        </div>
                    ))}
                </div>
            </CardContent>
        </Card>
    );
};

interface EvalsPanelProps {
    readonly initialShardKey?: string;
}

/**
 * The Evals page: what `recordEvaluation` has scored on this deployment.
 *
 * Two reads, because the two halves answer different questions. `getTraces`
 * gives the recent individual verdicts with the trace id that earned each one —
 * clickable, but bounded by the shard's in-memory ring, so it empties on
 * hibernation. `getMetricHistory` gives the durable per-minute buckets behind
 * the trend line, but only for apps that pass `ctx.metrics` to
 * `recordEvaluation`; the card says so plainly rather than drawing a trend the
 * data can't back.
 */
const EvalsPanel = ({ initialShardKey }: EvalsPanelProps): ReactElement => {
    const t = useT();
    const { queryShardKey, setShardKey, shardKey } = useShardKey(initialShardKey);
    // The drill-down from a score to the generation that earned it — the same
    // hand-off the Metrics panel's exemplars use.
    const openTrace = useOpenTrace(queryShardKey);

    const { data, error } = useAdminQuery<TracesResult>(ADMIN_FUNCTIONS.getTraces, {}, { live: true, shardKey: queryShardKey });
    // The trend read's own failure is ignored: a worker predating the RPC, or an
    // app that never records the metric, simply has no trend — never a broken page.
    const { data: history } = useAdminQuery<MetricHistoryResult>(ADMIN_FUNCTIONS.getMetricHistory, {}, { live: true, shardKey: queryShardKey });

    const cards = buildEvalCards(extractEvalRuns(tracesOf(data)), extractEvalTrends(history));

    return (
        <section className="flex flex-col gap-4" data-testid="ev-panel">
            <ShardInput onChange={setShardKey} testId="ev-shard-input" value={shardKey} />

            {error === null ? null : <ErrorAlert error={error} testId="ev-error" />}

            {cards.length === 0 ? (
                <EmptyState
                    description={t("Call recordEvaluation from a graded run and its score shows up here.")}
                    testId="ev-empty"
                    title={t("No evals recorded")}
                />
            ) : (
                <div className="grid gap-3 md:grid-cols-2">
                    {cards.map((card) => (
                        <EvalCardView card={card} key={card.name} onOpenTrace={openTrace} />
                    ))}
                </div>
            )}
        </section>
    );
};

export default EvalsPanel;
