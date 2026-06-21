import type { ScheduleRecord } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";

import { ConfirmButton } from "../../components/confirm-button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget, formatTimestamp } from "../../lib/internal";

interface ScheduledJobsProps {
    /**
     * Cancel a pending job by id. Defaults to `client.cancelScheduledJob` when
     * {@link ScheduledJobsProps.loadJobs} is also left to the client. When a
     * custom `loadJobs` is supplied without a `cancelJob`, the cancel control is
     * hidden — useful for a read-only view.
     */
    readonly cancelJob?: (id: string) => Promise<{ cancelled: boolean }>;

    /**
     * Load the pending scheduled jobs. Defaults to `client.listScheduledJobs`,
     * which hits the worker's admin-gated `/_lunora/admin/scheduled` endpoint —
     * so the panel works out of the box under `&lt;LunoraProvider>`, provided the
     * worker is built with a `schedulerDO` namespace and `adminToken`. Override
     * it to source jobs from elsewhere.
     */
    readonly loadJobs?: () => Promise<ScheduleRecord[]>;
}

/** A scheduled timestamp is always a finite epoch-ms; guard non-finite to an em dash. */
const formatScheduledFor = (value: number): string => (Number.isFinite(value) ? formatTimestamp(value, "—") : "—");

/**
 * View — and cancel — the functions queued via `runAfter` / `runAt` on the
 * scheduler. Cron *triggers* are static wrangler config and don't appear here;
 * this lists the dynamic, in-flight schedule only.
 *
 * Works out of the box under `&lt;LunoraProvider>` via the client's scheduler
 * admin methods; pass {@link ScheduledJobsProps.loadJobs} /
 * {@link ScheduledJobsProps.cancelJob} to override the transport.
 */
export const ScheduledJobs = ({ cancelJob, loadJobs }: ScheduledJobsProps = {}): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [jobs, setJobs] = useState<ScheduleRecord[] | null>(null);
    const [error, setError] = useState<null | string>(null);

    const load = loadJobs ?? (() => client.listScheduledJobs());

    // Cancelling is available when the host supplies a canceller, or when the
    // panel is sourcing jobs from the client (then the client can cancel too).
    // A custom `loadJobs` without a `cancelJob` stays read-only.
    const cancelImpl = useMemo<((id: string) => Promise<{ cancelled: boolean }>) | undefined>(() => {
        if (cancelJob !== undefined) {
            return cancelJob;
        }

        return loadJobs === undefined ? (id: string) => client.cancelScheduledJob(id) : undefined;
    }, [cancelJob, client, loadJobs]);

    const refresh = async (): Promise<void> => {
        setError(null);

        try {
            const records = await load();

            // Soonest-due first so the next thing to fire is at the top.
            setJobs(records.toSorted((a, b) => a.scheduledFor - b.scheduledFor));
        } catch (error_) {
            setJobs(null);
            setError(errorMessage(error_));
        }
    };

    useEffect(() => {
        fireAndForget(refresh());
        // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
    }, []);

    // Live updates, always on. When the panel sources jobs from the client (no
    // custom `loadJobs`), it subscribes to the SchedulerDO's WebSocket — the
    // server pushes the full list on every schedule/cancel/alarm-fire, so jobs
    // appear and vanish the instant they change. With a custom `loadJobs` the host
    // owns the transport, so we fall back to interval polling.
    const livePush = loadJobs === undefined;

    useEffect(() => {
        if (!livePush) {
            return undefined;
        }

        return client.subscribeScheduledJobs((records) => {
            setError(null);
            setJobs(records.toSorted((a, b) => a.scheduledFor - b.scheduledFor));
        });
    }, [livePush, client]);

    // Polling fallback for the custom-loader case (no WS to subscribe to).
    useAutoRefresh(() => {
        fireAndForget(refresh());
    }, !livePush);

    const cancel = async (id: string): Promise<void> => {
        if (cancelImpl === undefined) {
            return;
        }

        setError(null);

        try {
            await cancelImpl(id);

            // When the live WS subscription is active, the server pushes the
            // updated list on cancel — so skip the redundant HTTP refetch.
            if (!livePush) {
                await refresh();
            }
        } catch (error_) {
            setError(errorMessage(error_));
        }
    };

    return (
        <div className="flex flex-col gap-3" data-testid="lunora-scheduled-jobs">
            {error !== null && (
                <p className="text-sm text-destructive" data-testid="sj-error" role="alert">
                    {error}
                </p>
            )}

            {jobs !== null && jobs.length === 0 && (
                <EmptyState
                    description={t("Jobs queued with runAfter / runAt will appear here.")}
                    icon={
                        <svg
                            aria-hidden="true"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.6}
                            viewBox="0 0 24 24"
                        >
                            <circle cx="12" cy="12" r="9" />
                            <path d="M12 7.5V12l4 2" />
                        </svg>
                    }
                    testId="sj-empty"
                    title={t("No scheduled jobs.")}
                />
            )}

            {jobs !== null && jobs.length > 0 && (
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table data-testid="sj-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("function")}</TableHead>
                                    <TableHead>{t("scheduled for")}</TableHead>
                                    <TableHead>{t("pool")}</TableHead>
                                    <TableHead>{t("attempts")}</TableHead>
                                    <TableHead>{t("shard")}</TableHead>
                                    <TableHead>{t("id")}</TableHead>
                                    {cancelImpl !== undefined && <TableHead aria-label={t("Actions")} />}
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {jobs.map((job) => (
                                    <TableRow data-testid={`sj-row-${job.id}`} key={job.id}>
                                        <TableCell className="font-mono text-xs">{job.functionPath}</TableCell>
                                        <TableCell className="text-muted-foreground tabular-nums">{formatScheduledFor(job.scheduledFor)}</TableCell>
                                        <TableCell className="font-mono text-xs">{job.pool ?? ""}</TableCell>
                                        <TableCell className="tabular-nums">{job.attempts ?? 0}</TableCell>
                                        <TableCell>{job.shardKey ?? ""}</TableCell>
                                        <TableCell className="font-mono text-xs">{job.id}</TableCell>
                                        {cancelImpl !== undefined && (
                                            <TableCell className="text-right">
                                                <ConfirmButton
                                                    confirmLabel={t("Cancel job?")}
                                                    onConfirm={() => {
                                                        fireAndForget(cancel(job.id));
                                                    }}
                                                    testId={`sj-cancel-${job.id}`}
                                                >
                                                    {t("Cancel")}
                                                </ConfirmButton>
                                            </TableCell>
                                        )}
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

export type { ScheduledJobsProps };
