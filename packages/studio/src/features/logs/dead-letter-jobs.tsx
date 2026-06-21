import type { ScheduleRecord } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { ConfirmButton } from "../../components/confirm-button";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget, formatTimestamp } from "../../lib/internal";

interface DeadLetterJobsProps {
    /** Load the dead-letter records. Defaults to `client.listDeadJobs`. Override to source from elsewhere. */
    readonly loadJobs?: () => Promise<ScheduleRecord[]>;
    /** Permanently drop a dead-letter record by id. Defaults to `client.removeDeadJob`. */
    readonly removeJob?: (id: string) => Promise<{ removed: boolean }>;
    /** Resurrect a dead-letter record by id. Defaults to `client.retryDeadJob`. */
    readonly retryJob?: (id: string) => Promise<{ retried: boolean }>;
}

const formatScheduledFor = (value: number): string => (Number.isFinite(value) ? formatTimestamp(value, "—") : "—");

/**
 * The scheduler's dead-letter queue: jobs that exhausted their retry budget and
 * were parked instead of silently dropped. They never appear in the live
 * Scheduled-jobs view (their header is gone), so this is the only surface that
 * exposes — and recovers — a permanently-failed job.
 *
 * Unlike the live jobs view there is no WebSocket push for dead records (they
 * change only on the infrequent retry-exhaustion event), so this polls on the
 * shared auto-refresh interval and refetches after each operator action.
 *
 * Works out of the box under `&lt;LunoraProvider>` via the client's dead-letter
 * admin methods; pass the props to override the transport (e.g. a read-only
 * view supplies only `loadJobs`).
 */
export const DeadLetterJobs = ({ loadJobs, removeJob, retryJob }: DeadLetterJobsProps = {}): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [jobs, setJobs] = useState<ScheduleRecord[] | null>(null);
    const [error, setError] = useState<null | string>(null);

    const load = loadJobs ?? (() => client.listDeadJobs());
    // Actions are available when this view sources jobs from the client (then the
    // client can act too) or when the host supplies explicit handlers. A custom
    // `loadJobs` without handlers stays read-only.
    const clientOwned = loadJobs === undefined;
    const retryImpl = retryJob ?? (clientOwned ? (id: string) => client.retryDeadJob(id) : undefined);
    const removeImpl = removeJob ?? (clientOwned ? (id: string) => client.removeDeadJob(id) : undefined);

    const refresh = async (): Promise<void> => {
        setError(null);

        try {
            const records = await load();

            // Most-attempted first — the jobs that fought hardest before dying are the ones worth triaging.
            setJobs(records.toSorted((a, b) => (b.attempts ?? 0) - (a.attempts ?? 0)));
        } catch (error_) {
            setJobs(null);
            setError(errorMessage(error_));
        }
    };

    useEffect(() => {
        fireAndForget(refresh());
        // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
    }, []);

    useAutoRefresh(() => {
        fireAndForget(refresh());
    }, true);

    const act = async (operation: Promise<unknown>): Promise<void> => {
        setError(null);

        try {
            await operation;
            await refresh();
        } catch (error_) {
            setError(errorMessage(error_));
        }
    };

    const hasActions = retryImpl !== undefined || removeImpl !== undefined;

    return (
        <div className="flex flex-col gap-3" data-testid="lunora-dead-letter">
            {error !== null && (
                <p className="text-sm text-destructive" data-testid="dlq-error" role="alert">
                    {error}
                </p>
            )}

            {jobs !== null && jobs.length === 0 && (
                <EmptyState
                    description={t("Jobs that exhaust their retry budget are parked here instead of being dropped.")}
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
                            <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                        </svg>
                    }
                    testId="dlq-empty"
                    title={t("No dead-letter jobs.")}
                />
            )}

            {jobs !== null && jobs.length > 0 && (
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table data-testid="dlq-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("function")}</TableHead>
                                    <TableHead>{t("attempts")}</TableHead>
                                    <TableHead>{t("last tried")}</TableHead>
                                    <TableHead>{t("pool")}</TableHead>
                                    <TableHead>{t("shard")}</TableHead>
                                    <TableHead>{t("id")}</TableHead>
                                    {hasActions && <TableHead aria-label={t("Actions")} />}
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {jobs.map((job) => (
                                    <TableRow data-testid={`dlq-row-${job.id}`} key={job.id}>
                                        <TableCell className="font-mono text-xs">{job.functionPath}</TableCell>
                                        <TableCell className="tabular-nums">{job.attempts ?? 0}</TableCell>
                                        <TableCell className="text-muted-foreground tabular-nums">{formatScheduledFor(job.scheduledFor)}</TableCell>
                                        <TableCell className="font-mono text-xs">{job.pool ?? ""}</TableCell>
                                        <TableCell>{job.shardKey ?? ""}</TableCell>
                                        <TableCell className="font-mono text-xs">{job.id}</TableCell>
                                        {hasActions && (
                                            <TableCell className="text-right">
                                                <div className="flex justify-end gap-1.5">
                                                    {retryImpl !== undefined && (
                                                        <Button
                                                            data-testid={`dlq-retry-${job.id}`}
                                                            onClick={() => {
                                                                fireAndForget(act(retryImpl(job.id)));
                                                            }}
                                                            size="sm"
                                                            type="button"
                                                            variant="outline"
                                                        >
                                                            {t("Retry")}
                                                        </Button>
                                                    )}
                                                    {removeImpl !== undefined && (
                                                        <ConfirmButton
                                                            confirmLabel={t("Drop job?")}
                                                            onConfirm={() => {
                                                                fireAndForget(act(removeImpl(job.id)));
                                                            }}
                                                            testId={`dlq-remove-${job.id}`}
                                                        >
                                                            {t("Drop")}
                                                        </ConfirmButton>
                                                    )}
                                                </div>
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

export type { DeadLetterJobsProps };
