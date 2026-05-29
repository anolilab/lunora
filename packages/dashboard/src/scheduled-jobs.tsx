import { type ReactElement, useCallback, useEffect, useState } from "react";

import { errorMessage } from "./internal.js";

/**
 * One pending scheduled function, mirroring `@cirrus/scheduler`'s
 * `ScheduleRecord`. Duplicated structurally so the dashboard never imports the
 * scheduler runtime into the browser bundle.
 */
export interface ScheduleRecord {
    args: Record<string, unknown>;
    enqueuedAt: number;
    functionPath: string;
    id: string;
    scheduledFor: number;
    shardKey?: string;
}

export interface ScheduledJobsProps {
    /**
     * Cancel a pending job by id. When omitted, the cancel control is hidden —
     * useful for a read-only view. Wire this to the `SchedulerDO`'s
     * `POST /cancel` endpoint behind your admin gate.
     */
    readonly cancelJob?: (id: string) => Promise<{ cancelled: boolean }>;
    /**
     * Load the pending scheduled jobs. Wire this to the `SchedulerDO`'s
     * `GET /list` endpoint (which returns `{ records: ScheduleRecord[] }`)
     * behind your admin gate. The scheduler is a distinct Durable Object from
     * the shards, so unlike the other panels it isn't reachable over the
     * `useCirrus` admin-RPC path — the host supplies the transport.
     */
    readonly loadJobs: () => Promise<ScheduleRecord[]>;
}

const formatTimestamp = (value: number): string => {
    return Number.isFinite(value) ? new Date(value).toLocaleString() : "—";
};

/**
 * View — and optionally cancel — the functions queued via `runAfter` / `runAt`
 * on the scheduler. Cron *triggers* are static wrangler config and don't appear
 * here; this lists the dynamic, in-flight schedule only.
 *
 * Transport-agnostic by design: pass {@link ScheduledJobsProps.loadJobs} (and
 * optionally {@link ScheduledJobsProps.cancelJob}) bound to your admin-gated
 * `SchedulerDO` endpoints.
 */
export function ScheduledJobs({ cancelJob, loadJobs }: ScheduledJobsProps): ReactElement {
    const [jobs, setJobs] = useState<ScheduleRecord[] | null>(null);
    const [error, setError] = useState<null | string>(null);
    const [busy, setBusy] = useState<boolean>(false);

    const refresh = useCallback(async (): Promise<void> => {
        setError(null);
        setBusy(true);

        try {
            const records = await loadJobs();

            // Soonest-due first so the next thing to fire is at the top.
            setJobs([...records].sort((a, b) => a.scheduledFor - b.scheduledFor));
        } catch (error_) {
            setJobs(null);
            setError(errorMessage(error_));
        } finally {
            setBusy(false);
        }
    }, [loadJobs]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const cancel = useCallback(
        async (id: string): Promise<void> => {
            if (cancelJob === undefined) {
                return;
            }

            setError(null);

            try {
                await cancelJob(id);
                await refresh();
            } catch (error_) {
                setError(errorMessage(error_));
            }
        },
        [cancelJob, refresh],
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
                            {cancelJob !== undefined && <th />}
                        </tr>
                    </thead>
                    <tbody>
                        {jobs.map((job) => (
                            <tr data-testid={`sj-row-${job.id}`} key={job.id}>
                                <td>{job.functionPath}</td>
                                <td>{formatTimestamp(job.scheduledFor)}</td>
                                <td>{job.shardKey ?? ""}</td>
                                <td>{job.id}</td>
                                {cancelJob !== undefined && (
                                    <td>
                                        <button
                                            data-testid={`sj-cancel-${job.id}`}
                                            onClick={() => {
                                                void cancel(job.id);
                                            }}
                                            type="button"
                                        >
                                            Cancel
                                        </button>
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
