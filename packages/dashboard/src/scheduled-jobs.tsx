import type { ScheduleRecord } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";

import { ConfirmButton } from "./confirm-button.js";
import { errorMessage, formatTimestamp } from "./internal.js";
import { useAutoRefresh } from "./use-auto-refresh.js";

export type { ScheduleRecord } from "@cirrus/client";

export interface ScheduledJobsProps {
    /**
     * Cancel a pending job by id. Defaults to `client.cancelScheduledJob` when
     * {@link ScheduledJobsProps.loadJobs} is also left to the client. When a
     * custom `loadJobs` is supplied without a `cancelJob`, the cancel control is
     * hidden — useful for a read-only view.
     */
    readonly cancelJob?: (id: string) => Promise<{ cancelled: boolean }>;
    /**
     * Load the pending scheduled jobs. Defaults to `client.listScheduledJobs`,
     * which hits the worker's admin-gated `/_cirrus/admin/scheduled` endpoint —
     * so the panel works out of the box under `<CirrusProvider>`, provided the
     * worker is built with a `schedulerDO` namespace and `adminToken`. Override
     * it to source jobs from elsewhere.
     */
    readonly loadJobs?: () => Promise<ScheduleRecord[]>;
}

/** A scheduled timestamp is always a finite epoch-ms; guard non-finite to an em dash. */
const formatScheduledFor = (value: number): string => {
    return Number.isFinite(value) ? formatTimestamp(value, "—") : "—";
};

/**
 * View — and cancel — the functions queued via `runAfter` / `runAt` on the
 * scheduler. Cron *triggers* are static wrangler config and don't appear here;
 * this lists the dynamic, in-flight schedule only.
 *
 * Works out of the box under `<CirrusProvider>` via the client's scheduler
 * admin methods; pass {@link ScheduledJobsProps.loadJobs} /
 * {@link ScheduledJobsProps.cancelJob} to override the transport.
 */
export function ScheduledJobs({ cancelJob, loadJobs }: ScheduledJobsProps = {}): ReactElement {
    const client = useCirrus();

    const [jobs, setJobs] = useState<ScheduleRecord[] | null>(null);
    const [error, setError] = useState<null | string>(null);
    const [busy, setBusy] = useState<boolean>(false);
    const [auto, setAuto] = useState<boolean>(false);

    const load = useMemo(() => loadJobs ?? (() => client.listScheduledJobs()), [client, loadJobs]);

    // Cancelling is available when the host supplies a canceller, or when the
    // panel is sourcing jobs from the client (then the client can cancel too).
    // A custom `loadJobs` without a `cancelJob` stays read-only.
    const cancelImpl = useMemo<((id: string) => Promise<{ cancelled: boolean }>) | undefined>(() => {
        if (cancelJob !== undefined) {
            return cancelJob;
        }

        return loadJobs === undefined ? (id: string) => client.cancelScheduledJob(id) : undefined;
    }, [cancelJob, client, loadJobs]);

    const refresh = useCallback(async (): Promise<void> => {
        setError(null);
        setBusy(true);

        try {
            const records = await load();

            // Soonest-due first so the next thing to fire is at the top.
            setJobs([...records].sort((a, b) => a.scheduledFor - b.scheduledFor));
        } catch (error_) {
            setJobs(null);
            setError(errorMessage(error_));
        } finally {
            setBusy(false);
        }
    }, [load]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // Auto-refresh: the scheduler fires on wall-clock time, so polling lets the
    // operator watch jobs count down and disappear as their alarms fire. The
    // SchedulerDO is HTTP-only (no subscription channel), so this is the honest
    // "live" — not a WS push.
    useAutoRefresh(() => {
        void refresh();
    }, auto);

    const cancel = useCallback(
        async (id: string): Promise<void> => {
            if (cancelImpl === undefined) {
                return;
            }

            setError(null);

            try {
                await cancelImpl(id);
                await refresh();
            } catch (error_) {
                setError(errorMessage(error_));
            }
        },
        [cancelImpl, refresh],
    );

    return (
        <div data-testid="cirrus-scheduled-jobs">
            <button
                data-testid="sj-refresh"
                disabled={busy}
                onClick={() => {
                    void refresh();
                }}
                type="button"
            >
                Refresh
            </button>
            <button
                aria-pressed={auto}
                data-testid="sj-auto"
                onClick={() => {
                    setAuto((on) => !on);
                }}
                type="button"
            >
                {auto ? "Auto: on" : "Auto: off"}
            </button>

            {error !== null && (
                <p data-testid="sj-error" role="alert">
                    {error}
                </p>
            )}

            {jobs !== null && jobs.length === 0 && <p data-testid="sj-empty">No scheduled jobs.</p>}

            {jobs !== null && jobs.length > 0 && (
                <table data-testid="sj-table">
                    <thead>
                        <tr>
                            <th>function</th>
                            <th>scheduled for</th>
                            <th>shard</th>
                            <th>id</th>
                            {cancelImpl !== undefined && <th aria-label="Actions" />}
                        </tr>
                    </thead>
                    <tbody>
                        {jobs.map((job) => (
                            <tr data-testid={`sj-row-${job.id}`} key={job.id}>
                                <td>{job.functionPath}</td>
                                <td>{formatScheduledFor(job.scheduledFor)}</td>
                                <td>{job.shardKey ?? ""}</td>
                                <td>{job.id}</td>
                                {cancelImpl !== undefined && (
                                    <td>
                                        <ConfirmButton
                                            confirmLabel="Cancel job?"
                                            onConfirm={() => {
                                                void cancel(job.id);
                                            }}
                                            testId={`sj-cancel-${job.id}`}
                                        >
                                            Cancel
                                        </ConfirmButton>
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}
