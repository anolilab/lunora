import type { ReactElement } from "react";

// Bundler-inlined, zero-dep `key=value` field renderer shared with the runtime
// sinks and the other observability panels (see CLAUDE.md `shared/` rules).
import { formatLogFields } from "../../../../../shared/log-fields";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useT } from "../../i18n/i18n-context";
import type { MetricHistoryPoint, MetricHistoryResult, MetricKind, MetricSeries, MetricSeriesResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { formatMetricValue, metricHeadline, pointValue, seriesMatchKey } from "./instrument-format";
import { Sparkline } from "./sparkline";

interface InstrumentsTableProps {
    /**
     * Open the trace with this id — the exemplar drill-down. Supplied by the
     * router-aware parent; omitted in isolation (tests, no router), where the
     * exemplar renders as a plain, non-navigating id instead.
     */
    readonly onOpenTrace?: (traceId: string) => void;
    /** Shard key the series are read from — already debounced by the parent. */
    readonly shardKey: string;
}

/** Coerce a (possibly partial or pre-feature) `getMetricSeries` payload into its `series` array. */
const seriesOf = (result: MetricSeriesResult | undefined): MetricSeries[] => (Array.isArray(result?.series) ? result.series : []);

/** Index a `getMetricHistory` payload by series identity, so each live row can find its trend in O(1). */
const historyByKey = (result: MetricHistoryResult | undefined): Map<string, MetricHistoryPoint[]> => {
    const map = new Map<string, MetricHistoryPoint[]>();

    if (!Array.isArray(result?.series)) {
        return map;
    }

    for (const entry of result.series) {
        map.set(seriesMatchKey(entry.kind, entry.name, entry.attributes), entry.points);
    }

    return map;
};

/** The variant + label a kind badge renders with; `default` (accent) reserved for gauges to stand out. */
const KIND_VARIANT: Record<MetricKind, "default" | "outline" | "secondary"> = {
    counter: "secondary",
    gauge: "default",
    histogram: "outline",
};

interface TraceExemplarProps {
    /** Series name, for the cell's test id. */
    readonly name: string;
    /** Router-aware drill-down; omitted (tests/no router) → the id renders non-navigating. */
    readonly onOpenTrace?: (traceId: string) => void;
    /** The series' exemplar trace id, if it has one. */
    readonly traceId?: string;
}

/**
 * One Instruments row's Trace cell: a series' exemplar trace id, shortened. It
 * links to the Traces panel when a drill-down handler is supplied, and renders as
 * plain text otherwise (and a dash when the series has no exemplar). Pulled out of
 * the row so `traceId` narrows once — the shared branches drop the cast and the
 * `.slice(0, 8)` shortening lives in one place.
 */
const TraceExemplar = ({ name, onOpenTrace, traceId }: TraceExemplarProps): ReactElement => {
    const t = useT();

    if (traceId === undefined) {
        return <span className="text-muted-foreground">—</span>;
    }

    const short = traceId.slice(0, 8);

    if (onOpenTrace === undefined) {
        return (
            <span className="text-muted-foreground" data-testid={`mt-instrument-trace-${name}`} title={traceId}>
                {short}
            </span>
        );
    }

    return (
        <button
            className="text-primary underline-offset-4 hover:underline"
            data-testid={`mt-instrument-trace-${name}`}
            onClick={() => {
                onOpenTrace(traceId);
            }}
            title={t("Open the exemplar trace {trace}", { trace: traceId })}
            type="button"
        >
            {short}
        </button>
    );
};

/**
 * The Instruments section of the Metrics page: the aggregated `ctx.metrics.*`
 * series for one shard — the third observability signal alongside logs and
 * traces. Reads the gated `__lunora_admin__:getMetricSeries` RPC live over the
 * same admin WebSocket the shard-health metrics use, so a fresh measurement folds
 * in without a manual refresh.
 *
 * Where a counter's headline is its running total, a gauge's is its current
 * reading, and a histogram's is its mean (with the sample count and min/max range
 * beside it). The live fold is in-memory and resets on hibernation; a **Trend**
 * sparkline beside each series is drawn from `getMetricHistory` — durable
 * per-minute rollups persisted in the shard's SQLite that survive hibernation.
 * Each series also carries an **exemplar**: a trace id of a measurement that
 * produced it, so the Trace cell links a metric straight to a trace.
 *
 * Renders nothing until a series exists, so the Metrics page stays uncluttered
 * for an app that records no custom metrics.
 */
export const InstrumentsTable = ({ onOpenTrace, shardKey }: InstrumentsTableProps): ReactElement | null => {
    const t = useT();

    const { data, error } = useAdminQuery<MetricSeriesResult>(ADMIN_FUNCTIONS.getMetricSeries, {}, { live: true, shardKey });
    // Durable trend, read alongside the live snapshot. Its own error is ignored:
    // a pre-feature worker or an empty history simply yields no sparkline, never a
    // broken Instruments section.
    const { data: history } = useAdminQuery<MetricHistoryResult>(ADMIN_FUNCTIONS.getMetricHistory, {}, { live: true, shardKey });

    const series = seriesOf(data);

    // On an RPC failure (a stale admin token, a permission error) render a one-line
    // muted notice rather than vanishing — a hidden section is indistinguishable
    // from "no custom metrics", so the user has no idea the read failed.
    if (error !== null) {
        return (
            <section className="flex flex-col gap-2" data-testid="mt-instruments">
                <h3 className="text-sm font-semibold text-foreground">{t("Instruments")}</h3>
                <span className="text-xs text-muted-foreground" data-testid="mt-instruments-error" role="status">
                    {t("Instruments unavailable: {error}", { error })}
                </span>
            </section>
        );
    }

    // Silent when there's genuinely nothing to show: an uninstrumented app shouldn't
    // see an empty table bolted onto its shard-health overview.
    if (series.length === 0) {
        return null;
    }

    const trends = historyByKey(history);

    const kindLabel = (kind: MetricKind): string => {
        if (kind === "counter") {
            return t("Counter");
        }

        if (kind === "gauge") {
            return t("Gauge");
        }

        return t("Histogram");
    };

    return (
        <section className="flex flex-col gap-2" data-testid="mt-instruments">
            <h3 className="text-sm font-semibold text-foreground">{t("Instruments")}</h3>
            <Card className="overflow-hidden py-0">
                <CardContent className="px-0">
                    <Table data-testid="mt-instruments-table">
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("name")}</TableHead>
                                <TableHead>{t("kind")}</TableHead>
                                <TableHead className="text-right">{t("value")}</TableHead>
                                <TableHead className="text-right">{t("count")}</TableHead>
                                <TableHead className="text-right">{t("range")}</TableHead>
                                <TableHead>{t("trend")}</TableHead>
                                <TableHead>{t("trace")}</TableHead>
                                <TableHead>{t("dimensions")}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {series.map((s) => {
                                const dimensions = formatLogFields(s.attributes);
                                // One key per (name, kind, attributes) identity, canonical so it
                                // matches the durable history regardless of attribute order; also
                                // the stable React key across live re-pushes.
                                const key = seriesMatchKey(s.kind, s.name, s.attributes);
                                const points = trends.get(key) ?? [];
                                const trend = points.map((point) => pointValue(s.kind, point));

                                return (
                                    <TableRow data-testid={`mt-instrument-${s.name}`} key={key}>
                                        <TableCell className="font-mono text-xs" title={s.functionPath}>
                                            {s.name}
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant={KIND_VARIANT[s.kind]}>{kindLabel(s.kind)}</Badge>
                                        </TableCell>
                                        <TableCell className="text-right font-mono tabular-nums" data-testid={`mt-instrument-value-${s.name}`}>
                                            {formatMetricValue(metricHeadline(s))}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums text-muted-foreground">{s.count.toLocaleString()}</TableCell>
                                        <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                                            {/* A degenerate range (a counter always +1, a pinned gauge) carries no
                                                information, so collapse min===max to a dash rather than "1–1" noise. */}
                                            {s.min === s.max ? "—" : `${formatMetricValue(s.min)}–${formatMetricValue(s.max)}`}
                                        </TableCell>
                                        <TableCell>
                                            {/* Sparkline needs ≥2 points; a fresh series with one bucket shows a dash. */}
                                            {trend.length >= 2 ? (
                                                <Sparkline
                                                    ariaLabel={t("{name} trend", { name: s.name })}
                                                    className="h-6 w-24 text-foreground"
                                                    series={trend}
                                                    testId={`mt-instrument-trend-${s.name}`}
                                                />
                                            ) : (
                                                <span className="text-xs text-muted-foreground">—</span>
                                            )}
                                        </TableCell>
                                        <TableCell className="font-mono text-xs">
                                            <TraceExemplar name={s.name} onOpenTrace={onOpenTrace} traceId={s.exemplarTraceId} />
                                        </TableCell>
                                        <TableCell className="max-w-64 truncate font-mono text-xs text-muted-foreground" title={dimensions}>
                                            {dimensions === "" ? "—" : dimensions}
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </section>
    );
};

export type { InstrumentsTableProps };
