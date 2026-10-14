import type { ReactElement } from "react";

import ErrorAlert from "../../components/error-alert";
import { ShardInput } from "../../components/shard-input";
import StatCard from "../../components/stat-card";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import useOpenTrace from "../../hooks/use-open-trace";
import { useShardKey } from "../../hooks/use-shard-key";
import { useT } from "../../i18n/i18n-context";
import type { MetricHistoryResult, TracesResult, TraceSummary } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { formatTimestamp } from "../../lib/internal";
import { formatTokens, formatUsd } from "../reports/metrics-format";
import { Sparkline } from "../reports/sparkline";
import type { AiCall, CostProvenance, UsageRow, UsageTotals } from "./ai-usage";
import { buildAiUsage, costProvenance, totalCost } from "./ai-usage";

/** Coerce a (possibly partial or pre-feature) `getTraces` payload into its `traces` array. */
const tracesOf = (result: TracesResult | undefined): TraceSummary[] => (Array.isArray(result?.traces) ? result.traces : []);

/** Recent calls shown in the table; the live ring holds more, but a page of them answers "what just ran". */
const RECENT_CALL_LIMIT = 25;

/**
 * A cost with its provenance made visible: a figure a price table produced is
 * never allowed to read as one the provider billed.
 */
const CostValue = ({ provenance, value }: { readonly provenance: CostProvenance; readonly value: number }): ReactElement => {
    const t = useT();

    if (provenance === "none") {
        return <span className="text-muted-foreground">—</span>;
    }

    return (
        <span className="inline-flex items-center gap-2">
            <span className="tabular-nums">{provenance === "provider" ? formatUsd(value) : `~${formatUsd(value)}`}</span>
            {provenance === "estimated" ? (
                <Badge title={t("Derived from a price table, not reported by the provider.")} variant="warning">
                    {t("Estimated")}
                </Badge>
            ) : null}
            {provenance === "mixed" ? (
                <Badge title={t("Includes cost derived from a price table, not reported by the provider.")} variant="warning">
                    {t("Partly estimated")}
                </Badge>
            ) : null}
        </span>
    );
};

interface BreakdownTableProps {
    readonly keyLabel: string;
    readonly rows: ReadonlyArray<UsageRow>;
    readonly testId: string;
    readonly title: string;
}

/** Spend per function path or per model, most expensive first. */
const BreakdownTable = ({ keyLabel, rows, testId, title }: BreakdownTableProps): ReactElement => {
    const t = useT();

    return (
        <Card className="gap-0 py-0" data-testid={testId}>
            <CardHeader className="px-4 py-3">
                <CardTitle>{title}</CardTitle>
            </CardHeader>
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>{keyLabel}</TableHead>
                        <TableHead className="text-end">{t("Calls")}</TableHead>
                        <TableHead className="text-end">{t("Input tokens")}</TableHead>
                        <TableHead className="text-end">{t("Output tokens")}</TableHead>
                        <TableHead className="text-end">{t("Cost")}</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((row) => (
                        <TableRow data-testid={`${testId}-row`} key={row.key}>
                            <TableCell className="max-w-[280px] truncate font-mono" title={row.key}>
                                {row.key}
                            </TableCell>
                            <TableCell className="text-end tabular-nums">{formatTokens(row.calls)}</TableCell>
                            <TableCell className="text-end tabular-nums">{formatTokens(row.inputTokens)}</TableCell>
                            <TableCell className="text-end tabular-nums">{formatTokens(row.outputTokens)}</TableCell>
                            <TableCell className="text-end">
                                <CostValue provenance={costProvenance(row)} value={totalCost(row)} />
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </Card>
    );
};

interface RecentCallsProps {
    readonly calls: ReadonlyArray<AiCall>;
    readonly onOpenTrace: (traceId: string) => void;
}

/** The newest individual model calls from the live ring, each linking to its trace. */
const RecentCalls = ({ calls, onOpenTrace }: RecentCallsProps): ReactElement => {
    const t = useT();

    return (
        <Card className="gap-0 py-0" data-testid="ai-calls">
            <CardHeader className="px-4 py-3">
                <CardTitle>{t("Recent calls")}</CardTitle>
            </CardHeader>
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>{t("When")}</TableHead>
                        <TableHead>{t("Function")}</TableHead>
                        <TableHead>{t("Model")}</TableHead>
                        <TableHead className="text-end">{t("Input tokens")}</TableHead>
                        <TableHead className="text-end">{t("Output tokens")}</TableHead>
                        <TableHead className="text-end">{t("Cost")}</TableHead>
                        <TableHead>{t("Trace")}</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {calls.slice(0, RECENT_CALL_LIMIT).map((call) => (
                        <TableRow data-testid="ai-call" key={`${call.traceId}:${call.startTs.toString()}:${call.model}`}>
                            <TableCell className="font-mono text-muted-foreground">{formatTimestamp(call.startTs)}</TableCell>
                            <TableCell className="font-mono">
                                <span className="inline-flex items-center gap-2">
                                    {call.functionPath}
                                    {call.streaming ? <Badge variant="outline">{t("stream")}</Badge> : null}
                                    {call.ok ? null : <Badge variant="destructive">{t("failed")}</Badge>}
                                </span>
                            </TableCell>
                            <TableCell className="max-w-[240px] truncate font-mono" title={call.model}>
                                {call.model}
                            </TableCell>
                            <TableCell className="text-end tabular-nums">{call.inputTokens === undefined ? "—" : formatTokens(call.inputTokens)}</TableCell>
                            <TableCell className="text-end tabular-nums">{call.outputTokens === undefined ? "—" : formatTokens(call.outputTokens)}</TableCell>
                            <TableCell className="text-end">
                                <CostValue provenance={call.cost === undefined ? "none" : (call.costSource ?? "estimated")} value={call.cost ?? 0} />
                            </TableCell>
                            <TableCell>
                                <button
                                    className="font-mono text-muted-foreground underline-offset-2 hover:underline"
                                    onClick={() => {
                                        onOpenTrace(call.traceId);
                                    }}
                                    title={t("Open the trace {trace}", { trace: call.traceId })}
                                    type="button"
                                >
                                    {call.traceId.slice(0, 8)}
                                </button>
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </Card>
    );
};

/** Headline tiles: total spend (with its trend and source split) and the token and call totals. */
const TotalsRow = ({ totals, trend }: { readonly totals: UsageTotals; readonly trend: ReadonlyArray<number> }): ReactElement => {
    const t = useT();
    const provenance = costProvenance(totals);

    return (
        <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="ai-totals">
            <StatCard
                chart={trend.length >= 2 ? <Sparkline ariaLabel={t("Cost per minute")} className="h-7 w-24" series={trend} testId="ai-trend" /> : undefined}
                footer={
                    provenance === "none" ? (
                        t("No cost reported")
                    ) : (
                        <span data-testid="ai-cost-split">
                            {t("{provider} provider-reported · {estimated} estimated", {
                                estimated: formatUsd(totals.estimatedCost),
                                provider: formatUsd(totals.providerCost),
                            })}
                        </span>
                    )
                }
                label={t("Total cost")}
                testId="ai-total-cost"
                value={<CostValue provenance={provenance} value={totalCost(totals)} />}
            />
            <StatCard label={t("Input tokens")} testId="ai-input-tokens" value={formatTokens(totals.inputTokens)} />
            <StatCard label={t("Output tokens")} testId="ai-output-tokens" value={formatTokens(totals.outputTokens)} />
            <StatCard label={t("Calls")} testId="ai-calls-total" value={formatTokens(totals.calls)} />
        </dl>
    );
};

interface AiUsagePanelProps {
    readonly initialShardKey?: string;
}

/**
 * The AI usage page: what `ctx.ai.model(...)` calls have cost this deployment,
 * per function and per model.
 *
 * Two reads, like Evals. `getMetricHistory` carries the durable per-minute
 * `gen_ai.usage.*` counters behind every total and the trend; `getTraces`
 * carries the individual `ai.generate` / `ai.stream` spans, each clickable
 * through to its trace. When no history exists yet the totals fall back to the
 * live ring, and the page says those numbers reset on hibernation.
 */
const AiUsagePanel = ({ initialShardKey }: AiUsagePanelProps): ReactElement => {
    const t = useT();
    const { queryShardKey, setShardKey, shardKey } = useShardKey(initialShardKey);
    const openTrace = useOpenTrace(queryShardKey);

    const { data, error } = useAdminQuery<TracesResult>(ADMIN_FUNCTIONS.getTraces, {}, { live: true, shardKey: queryShardKey });
    // The history read's own failure is ignored: a worker predating the RPC just
    // has no durable totals, and the live ring still fills the page.
    const { data: history } = useAdminQuery<MetricHistoryResult>(ADMIN_FUNCTIONS.getMetricHistory, {}, { live: true, shardKey: queryShardKey });

    const usage = buildAiUsage(history, tracesOf(data));
    const trend = usage.trend.map((point) => point.providerCost + point.estimatedCost);

    return (
        <section className="flex flex-col gap-4" data-testid="ai-panel">
            <ShardInput onChange={setShardKey} testId="ai-shard-input" value={shardKey} />

            {error === null ? null : <ErrorAlert error={error} testId="ai-error" />}

            {usage.source === "none" ? (
                <EmptyState
                    description={t("Spend shows up here once an action calls ctx.ai.model(...) — tokens and cost per function and per model.")}
                    testId="ai-empty"
                    title={t("No AI usage recorded")}
                />
            ) : (
                <>
                    {usage.source === "live" ? (
                        <p className="text-xs text-muted-foreground" data-testid="ai-live-only">
                            {t("No durable history yet — these totals come from the live trace ring and reset when the shard hibernates.")}
                        </p>
                    ) : (
                        <p className="text-xs text-muted-foreground" data-testid="ai-window">
                            {t("Totals cover the retained metric history (up to the last 24 hours).")}
                        </p>
                    )}

                    <TotalsRow totals={usage.totals} trend={trend} />

                    <div className="grid gap-3 xl:grid-cols-2">
                        <BreakdownTable keyLabel={t("Function")} rows={usage.byFunction} testId="ai-by-function" title={t("By function")} />
                        <BreakdownTable keyLabel={t("Model")} rows={usage.byModel} testId="ai-by-model" title={t("By model")} />
                    </div>

                    {usage.calls.length === 0 ? (
                        <Card>
                            <CardContent className="p-4 text-xs text-muted-foreground" data-testid="ai-no-calls">
                                {t("No recent calls in the live trace ring — it empties when the shard hibernates.")}
                            </CardContent>
                        </Card>
                    ) : (
                        <RecentCalls calls={usage.calls} onOpenTrace={openTrace} />
                    )}
                </>
            )}
        </section>
    );
};

export default AiUsagePanel;
