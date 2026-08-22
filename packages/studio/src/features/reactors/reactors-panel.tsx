import type { ReactElement } from "react";

import ErrorAlert from "../../components/error-alert";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useT } from "../../i18n/i18n-context";
import type { ReactorMetadata, ReactorsResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";

interface ReactorsPanelProps {
    /** Shard whose reactors are listed. Empty string → the root shard. */
    readonly initialShardKey?: string;
}

/** Badge styling per lifecycle state. `idle` is muted, not alarming — it is usually a wiring question, not a fault. */
const STATE_VARIANT: Record<ReactorMetadata["state"], "default" | "destructive" | "secondary"> = {
    active: "default",
    failing: "destructive",
    idle: "secondary",
};

/** Render an epoch-ms instant as a locale time, or an em dash when the reactor has never dispatched. */
const formatLastRan = (lastRanAt: number | undefined): string => (lastRanAt === undefined ? "—" : new Date(lastRanAt).toLocaleString());

/**
 * Ratio of suppressed dispatches to total ones, as a percentage — the number
 * that tells an operator whether a reactor is watching more than it needs to.
 *
 * A suppressed dispatch means `select` re-ran and the digest matched, so the
 * handler did not fire: real work was done to learn that nothing changed. A high
 * ratio is not an error, but it is the signal that the read wants narrowing or an
 * index. `undefined` when the reactor has never been dispatched, so the column
 * shows an em dash rather than a meaningless `0%`.
 */
const suppressionRate = (reactor: ReactorMetadata): number | undefined => {
    const total = reactor.runs + reactor.suppressed;

    return total === 0 ? undefined : Math.round((reactor.suppressed / total) * 100);
};

/**
 * The Reactors inspector — every `onQueryChange` reactor declared in
 * `lunora/`, with what it has actually done on this shard.
 *
 * Reactors are the one reactive surface with no client on the other end: they
 * fire on a write flush, in the background, with nothing to watch them. That is
 * exactly why they need a panel — a reactor that never fires and a reactor that
 * fires and does nothing look identical from the outside, and so does one that
 * throws on every flush. The three states here separate those cases.
 *
 * The counters are read from `__reactor_state`, so they survive hibernation,
 * unlike the shard's in-memory metrics. A reactor's steady state is an idle
 * shard, so counters that reset on eviction would almost always read zero.
 */
const ReactorsPanel = ({ initialShardKey = "" }: ReactorsPanelProps): ReactElement => {
    const t = useT();

    const { data, error, errorSource, liveError } = useAdminQuery<ReactorsResult>(ADMIN_FUNCTIONS.listReactors, {}, { live: true, shardKey: initialShardKey });

    const loaded = data !== undefined;
    const reactors = Array.isArray(data?.reactors) ? data.reactors : [];

    let body: ReactElement;

    if (loaded && reactors.length === 0) {
        body = (
            <EmptyState
                description={t(
                    "No reactor is declared in this deployment. Export an onQueryChange(select, handler) from lunora/ to run server-side logic when a query's result changes.",
                )}
                testId="reactors-empty"
                title={t("No reactors declared")}
            />
        );
    } else {
        body = (
            <Card className="overflow-hidden py-0">
                <CardContent className="px-0">
                    <Table data-testid="reactors-table">
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("Reactor")}</TableHead>
                                <TableHead>{t("State")}</TableHead>
                                <TableHead>{t("Ran")}</TableHead>
                                <TableHead>{t("Suppressed")}</TableHead>
                                <TableHead>{t("Errors")}</TableHead>
                                <TableHead>{t("Watches")}</TableHead>
                                <TableHead>{t("Last dispatch")}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {reactors.map((reactor) => {
                                const rate = suppressionRate(reactor);

                                return (
                                    <TableRow data-testid={`reactors-row-${reactor.path}`} key={reactor.path}>
                                        <TableCell className="font-mono text-xs">{reactor.path}</TableCell>
                                        <TableCell>
                                            <Badge data-testid={`reactors-state-${reactor.path}`} variant={STATE_VARIANT[reactor.state]}>
                                                {reactor.state}
                                            </Badge>
                                        </TableCell>
                                        <TableCell className="font-mono text-xs">{reactor.runs}</TableCell>
                                        <TableCell className="font-mono text-xs text-muted-foreground">
                                            {reactor.suppressed}
                                            {rate === undefined ? "" : ` (${String(rate)}%)`}
                                        </TableCell>
                                        <TableCell className="font-mono text-xs">
                                            {reactor.errors === 0 ? (
                                                <span className="text-muted-foreground">0</span>
                                            ) : (
                                                <span className="text-destructive">{reactor.errors}</span>
                                            )}
                                        </TableCell>
                                        <TableCell className="font-mono text-xs text-muted-foreground">
                                            {reactor.tables === undefined || reactor.tables.length === 0 ? "—" : reactor.tables.join(", ")}
                                        </TableCell>
                                        <TableCell className="font-mono text-xs text-muted-foreground">{formatLastRan(reactor.lastRanAt)}</TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        );
    }

    const failing = reactors.filter((reactor) => reactor.state === "failing");

    return (
        <div className="flex flex-col gap-6" data-testid="lunora-reactors-panel">
            {error !== null && <ErrorAlert error={errorSource} testId="reactors-error" />}

            <p className="text-sm text-muted-foreground">
                {t(
                    "A reactor runs after a write flush, but only when the result of the query it watches actually changed — a trigger fires on a row write, a reactor fires on a result changing. Suppressed dispatches are the ones where the read re-ran and nothing had moved.",
                )}
            </p>

            {failing.length > 0 && (
                <div className="flex flex-col gap-2" data-testid="reactors-failing">
                    {failing.map((reactor) => (
                        <p className="text-xs text-destructive" key={reactor.path} role="alert">
                            {/* The message matters more than the count: a failing reactor's
                                baseline is deliberately frozen, so it is retried on every
                                flush rather than skipped — it will keep throwing until fixed. */}
                            <span className="font-mono">{reactor.path}</span>
                            {": "}
                            {reactor.lastError ?? t("last dispatch failed")}
                        </p>
                    ))}
                </div>
            )}

            {liveError !== undefined && (
                <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="reactors-live-error" role="alert">
                    {t("Live updates unavailable; showing the last reading.")}
                </p>
            )}

            {body}
        </div>
    );
};

export default ReactorsPanel;
