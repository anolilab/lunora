import type { ScheduledJobView } from "@lunora/client";
import type { ReactElement } from "react";

import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useClientQuery } from "../../hooks/use-admin-query";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import useStudioClient from "../../hooks/use-studio-client";
import { useT } from "../../i18n/i18n-context";
import { formatTimestamp } from "../../lib/internal";

interface JobHistoryProps {
    /** Load the finished jobs, newest first. Defaults to `client.listScheduledHistory`. */
    readonly loadJobs?: () => Promise<ScheduledJobView[]>;
}

const STATE_VARIANT = { canceled: "secondary", failed: "destructive", pending: "outline", running: "info", succeeded: "success" } as const;

/**
 * How recent scheduled jobs ended. Without it a job that ran vanishes from the
 * Scheduled-jobs view exactly as a cancelled one does, so "did it run?" had no
 * answer anywhere. Polls on the shared auto-refresh interval: finished jobs only
 * accumulate, and the live socket pushes the pending list alone.
 */
export const JobHistory = ({ loadJobs }: JobHistoryProps = {}): ReactElement => {
    const client = useStudioClient();
    const t = useT();
    const jobsQuery = useClientQuery(["lunora-job-history", loadJobs ? "custom" : "default"], async () =>
        (loadJobs ?? (() => client.listScheduledHistory()))(),
    );
    const jobs = jobsQuery.data;
    const stateLabel = { canceled: t("canceled"), failed: t("failed"), pending: t("pending"), running: t("running"), succeeded: t("succeeded") };

    useAutoRefresh(() => jobsQuery.poll(), true);

    return (
        <div className="flex flex-col gap-3" data-testid="lunora-job-history">
            {jobsQuery.error !== null && (
                <p className="text-sm text-destructive" data-testid="job-history-error" role="alert">
                    {jobsQuery.error}
                </p>
            )}

            {jobs?.length === 0 && (
                <EmptyState
                    description={t("Jobs that succeed, fail or are cancelled stay here for seven days.")}
                    testId="job-history-empty"
                    title={t("No finished jobs.")}
                />
            )}

            {jobs !== undefined && jobs.length > 0 && (
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table data-testid="job-history-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("function")}</TableHead>
                                    <TableHead>{t("state")}</TableHead>
                                    <TableHead>{t("finished")}</TableHead>
                                    <TableHead>{t("error")}</TableHead>
                                    <TableHead>{t("id")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {jobs.map((job) => (
                                    <TableRow data-testid={`job-history-row-${job.id}`} key={job.id}>
                                        <TableCell className="font-mono text-xs">{job.workflow ?? job.functionPath}</TableCell>
                                        <TableCell>
                                            <Badge data-testid={`job-history-state-${job.id}`} variant={STATE_VARIANT[job.state]}>
                                                {stateLabel[job.state]}
                                            </Badge>
                                        </TableCell>
                                        <TableCell className="text-muted-foreground tabular-nums">
                                            {job.completedAt === undefined ? "—" : formatTimestamp(job.completedAt, "—")}
                                        </TableCell>
                                        <TableCell className="text-xs text-destructive">{job.error ?? ""}</TableCell>
                                        <TableCell className="font-mono text-xs">{job.id}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}
        </div>
    );
};

export type { JobHistoryProps };
