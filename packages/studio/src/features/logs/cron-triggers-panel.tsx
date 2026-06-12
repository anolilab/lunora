import type { CronJobInfo } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget } from "../../lib/internal";

interface CronTriggersPanelProps {
    /**
     * Load the code-defined cron triggers. Defaults to `client.getCronJobs`,
     * which hits the worker's admin-gated `/_cirrus/admin/cron-jobs` endpoint —
     * so the panel works out of the box under `&lt;CirrusProvider>`, provided the
     * worker is built with a `cronJobs` map and `adminToken`. Override it to
     * source triggers from elsewhere (e.g. tests).
     */
    readonly loadCronJobs?: () => Promise<CronJobInfo[]>;
}

/**
 * Read-only view of the **static cron triggers** — the `cronJobs()` map compiled
 * into the worker. Unlike the dynamic `runAfter` / `runAt` schedule, these are
 * fixed for the deployment: Cloudflare exposes no runtime cron introspection, so
 * the injected map is the only source of truth and nothing here is editable. One
 * row per scheduled invocation: its cron expression, the function it runs, and
 * any bound shard / args.
 */

export const CronTriggersPanel = ({ loadCronJobs }: CronTriggersPanelProps = {}): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [jobs, setJobs] = useState<CronJobInfo[] | null>(null);
    const [error, setError] = useState<null | string>(null);

    useEffect(() => {
        const token = { cancelled: false };

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const records = await (loadCronJobs ?? (() => client.getCronJobs()))();

                    if (!token.cancelled) {
                        setJobs(records);
                        setError(null);
                    }
                } catch (error_) {
                    if (!token.cancelled) {
                        setJobs(null);
                        setError(errorMessage(error_));
                    }
                }
            })(),
        );

        return () => {
            token.cancelled = true;
        };
    }, [client, loadCronJobs]);

    return (
        <div className="flex flex-col gap-3" data-testid="cirrus-cron-triggers">
            {error !== null && (
                <p className="text-sm text-destructive" data-testid="cron-error" role="alert">
                    {error}
                </p>
            )}

            {jobs !== null && jobs.length === 0 && (
                <EmptyState
                    description={t("Triggers declared with the cronJobs() builder appear here.")}
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
                    testId="cron-empty"
                    title={t("No cron triggers.")}
                />
            )}

            {jobs !== null && jobs.length > 0 && (
                <div className="rounded-md border border-border">
                    <Table data-testid="cron-table">
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("name")}</TableHead>
                                <TableHead>{t("schedule")}</TableHead>
                                <TableHead>{t("function")}</TableHead>
                                <TableHead>{t("shard")}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {jobs.map((job) => (
                                <TableRow data-testid={`cron-row-${job.name}`} key={`${job.cron}:${job.name}`}>
                                    <TableCell>{job.name}</TableCell>
                                    <TableCell className="font-mono text-xs tabular-nums">{job.cron}</TableCell>
                                    <TableCell className="font-mono text-xs">{job.functionPath}</TableCell>
                                    <TableCell>{job.shardKey ?? ""}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}
        </div>
    );
};

export type { CronTriggersPanelProps };
