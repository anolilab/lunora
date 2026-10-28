import type { CronRunInFlight, CronRunRecord, CronRunsResult } from "@lunora/client";
import type { ReactElement } from "react";

import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useT } from "../../i18n/i18n-context";
import { formatTimestamp } from "../../lib/internal";

const STATUS_VARIANT = { failed: "destructive", skipped: "warning", succeeded: "success" } as const;

// ponytail: one page of the newest runs across every job; a per-job drill-down is the upgrade once one job's history needs paging.
const RECENT_LIMIT = 25;

const formatDuration = (ms: number): string => (ms < 1000 ? `${String(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** The latest-run cell for one cron job: in flight, its last outcome, or never run. */
export const CronLastRun = ({ inFlight, last }: { inFlight?: CronRunInFlight; last?: CronRunRecord }): ReactElement => {
    const t = useT();

    if (inFlight !== undefined) {
        return (
            <span className="flex items-center gap-2">
                <Badge variant="info">{t("running")}</Badge>
                <span className="text-xs text-muted-foreground tabular-nums">{formatTimestamp(inFlight.startedAt, "—")}</span>
                {inFlight.skipped > 0 && <span className="text-xs text-muted-foreground">{t("{count} ticks skipped", { count: inFlight.skipped })}</span>}
            </span>
        );
    }

    if (last === undefined) {
        return <span className="text-xs text-muted-foreground">{t("never")}</span>;
    }

    const label = { failed: t("failed"), skipped: t("skipped"), succeeded: t("succeeded") };

    return (
        <span className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANT[last.status]}>{label[last.status]}</Badge>
            <span className="text-xs text-muted-foreground tabular-nums">{formatTimestamp(last.startedAt, "—")}</span>
        </span>
    );
};

/**
 * The newest cron fires across every job: when each started, how long it ran,
 * how it ended, and how many ticks it caused to be skipped. A skipped tick is a
 * row of its own, so an overlap is visible as it happens rather than inferred
 * from a gap.
 */
export const CronRunHistory = ({ runs }: { runs: CronRunsResult["runs"] }): ReactElement | undefined => {
    const t = useT();

    if (runs.length === 0) {
        return undefined;
    }

    const recent = runs.toSorted((a, b) => b.startedAt - a.startedAt).slice(0, RECENT_LIMIT);
    const label = { failed: t("failed"), skipped: t("skipped"), succeeded: t("succeeded") };

    return (
        <div className="flex flex-col gap-2" data-testid="cron-run-history">
            <h3 className="text-sm font-medium">{t("Recent runs")}</h3>
            <Card className="overflow-hidden py-0">
                <CardContent className="px-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("name")}</TableHead>
                                <TableHead>{t("status")}</TableHead>
                                <TableHead>{t("started")}</TableHead>
                                <TableHead>{t("duration")}</TableHead>
                                <TableHead>{t("skipped")}</TableHead>
                                <TableHead>{t("error")}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {recent.map((run) => (
                                <TableRow data-testid={`cron-run-row-${run.runId}`} key={run.runId}>
                                    <TableCell>{run.name}</TableCell>
                                    <TableCell>
                                        <Badge variant={STATUS_VARIANT[run.status]}>{label[run.status]}</Badge>
                                    </TableCell>
                                    <TableCell className="text-muted-foreground tabular-nums">{formatTimestamp(run.startedAt, "—")}</TableCell>
                                    <TableCell className="tabular-nums">{run.status === "skipped" ? "" : formatDuration(run.durationMs)}</TableCell>
                                    <TableCell className="tabular-nums">{run.skipped > 0 ? run.skipped : ""}</TableCell>
                                    <TableCell className="text-xs text-destructive">{run.error ?? ""}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
};
