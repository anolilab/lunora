import type { ReactElement } from "react";

// Bundler-inlined, zero-dep `key=value` field renderer shared with the runtime
// sinks and the other observability panels (see CLAUDE.md `shared/` rules).
import { formatLogFields } from "../../../../../shared/log-fields";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useT } from "../../i18n/i18n-context";
import type { MetricKind, MetricSeries, MetricSeriesResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { formatMetricValue, metricHeadline } from "./instrument-format";

interface InstrumentsTableProps {
    /** Shard key the series are read from — already debounced by the parent. */
    readonly shardKey: string;
}

/** Coerce a (possibly partial or pre-feature) `getMetricSeries` payload into its `series` array. */
const seriesOf = (result: MetricSeriesResult | undefined): MetricSeries[] => (Array.isArray(result?.series) ? result.series : []);

/** The variant + label a kind badge renders with; `default` (accent) reserved for gauges to stand out. */
const KIND_VARIANT: Record<MetricKind, "default" | "outline" | "secondary"> = {
    counter: "secondary",
    gauge: "default",
    histogram: "outline",
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
 * beside it). The backing fold is in-memory and per-instance, so it resets on
 * hibernation — a "recent metrics on this instance" readout, NOT a durable metric
 * store; production aggregation ships to a collector via the runtime sink.
 *
 * Renders nothing until a series exists, so the Metrics page stays uncluttered
 * for an app that records no custom metrics.
 */
export const InstrumentsTable = ({ shardKey }: InstrumentsTableProps): ReactElement | null => {
    const t = useT();

    const { data, error } = useAdminQuery<MetricSeriesResult>(ADMIN_FUNCTIONS.getMetricSeries, {}, { live: true, shardKey });

    const series = seriesOf(data);

    // Silent when there's nothing to show: an uninstrumented app shouldn't see an
    // empty table or an error row bolted onto its shard-health overview. The RPC's
    // failure is already surfaced by the sibling getMetrics read on the same page.
    if (error !== null || series.length === 0) {
        return null;
    }

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
                                <TableHead>{t("dimensions")}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {series.map((s) => {
                                const dimensions = formatLogFields(s.attributes);
                                // One key per (name, kind, dimensions) identity — the same tuple
                                // the server folds on, so it's stable across live re-pushes.
                                const key = `${s.kind}:${s.name}:${dimensions}`;

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
