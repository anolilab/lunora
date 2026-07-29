import type { CronJobInfo } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { ConfirmButton } from "../../components/confirm-button";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useClientQuery } from "../../hooks/use-admin-query";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget } from "../../lib/internal";

interface CronTriggersPanelProps {
    /**
     * Load the code-defined cron triggers. Defaults to `client.getCronJobs`,
     * which hits the worker's admin-gated `/_lunora/admin/cron-jobs` endpoint —
     * so the panel works out of the box under `&lt;LunoraProvider>`, provided the
     * worker is built with a `cronJobs` map and `adminToken`. Override it to
     * source triggers from elsewhere (e.g. tests).
     */
    readonly loadCronJobs?: () => Promise<CronJobInfo[]>;

    /**
     * Manually fire one cron job by name. Defaults to `client.runCronJob`, which
     * hits the admin-gated `POST /_lunora/admin/cron-jobs/run` endpoint (the same
     * dispatch the scheduled trigger runs). When a custom {@link CronTriggersPanelProps.loadCronJobs}
     * is supplied without a `runCronJob`, the "Run now" control is hidden — useful
     * for a read-only view.
     */
    readonly runCronJob?: (name: string) => Promise<{ name: string; ran: boolean }>;
}

/** Per-row run state for the "Run now" control. */
type RunState = { kind: "error"; message: string } | { kind: "idle" } | { kind: "ok" } | { kind: "running" };

const IDLE: RunState = { kind: "idle" };

/**
 * Read-only view of the **static cron triggers** — the `cronJobs()` map compiled
 * into the worker — with a per-row **Run now** action. Unlike the dynamic
 * `runAfter` / `runAt` schedule, the triggers themselves are fixed for the
 * deployment (Cloudflare exposes no runtime cron introspection, so the injected
 * map is the only source of truth and nothing here is editable). One row per
 * scheduled invocation: its cron expression, its target (a function dispatch or
 * a durable workflow start), any bound shard / args, and a button to fire it on
 * demand.
 */

const cronRunner = (
    client: ReturnType<typeof useLunora>,
    loadCronJobs: CronTriggersPanelProps["loadCronJobs"],
    runCronJob: CronTriggersPanelProps["runCronJob"],
): ((name: string) => Promise<{ name: string; ran: boolean }>) | undefined => {
    if (runCronJob !== undefined) {
        return runCronJob;
    }

    return loadCronJobs === undefined ? (name: string) => client.runCronJob(name) : undefined;
};

/** How to run a trigger, or `undefined` when the panel is read-only: the host's runner wins; otherwise the client can run what it also lists. A custom loader without a runner stays read-only. */
export const CronTriggersPanel = ({ loadCronJobs, runCronJob }: CronTriggersPanelProps = {}): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [runStates, setRunStates] = useState<Record<string, RunState>>({});

    // The cron-jobs map is HTTP-only (no admin-RPC path), so it's a
    // `useClientQuery` over the supplied loader (or `client.getCronJobs`). The key
    // carries the loader source so a custom `loadCronJobs` override never shares the
    // default `client.getCronJobs()` cache entry under one `QueryClient`.
    const jobsQuery = useClientQuery(["lunora-cron-jobs", loadCronJobs ? "custom" : "default"], () => (loadCronJobs ?? (() => client.getCronJobs()))());
    const { data: jobs, error } = jobsQuery;

    // Running is available when the host supplies a runner, or when the panel is
    // sourcing triggers from the client (then the client can run them too). A
    // custom `loadCronJobs` without a `runCronJob` stays read-only.
    const runImpl = cronRunner(client, loadCronJobs, runCronJob);

    const run = async (name: string): Promise<void> => {
        if (runImpl === undefined) {
            return;
        }

        setRunStates((previous) => {
            return { ...previous, [name]: { kind: "running" } };
        });

        try {
            await runImpl(name);

            setRunStates((previous) => {
                return { ...previous, [name]: { kind: "ok" } };
            });

            // Re-read the triggers after a manual run so any state the run touched
            // is reflected (the list itself is static, but this matches the
            // post-action refetch model used across the scheduler panels).
            jobsQuery.refetch();
        } catch (error_) {
            setRunStates((previous) => {
                return { ...previous, [name]: { kind: "error", message: errorMessage(error_) } };
            });
        }
    };

    return (
        <div className="flex flex-col gap-3" data-testid="lunora-cron-triggers">
            {error !== null && (
                <p className="text-sm text-destructive" data-testid="cron-error" role="alert">
                    {error}
                </p>
            )}

            {jobs?.length === 0 && (
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

            {jobs !== undefined && jobs.length > 0 && (
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table data-testid="cron-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("name")}</TableHead>
                                    <TableHead>{t("schedule")}</TableHead>
                                    <TableHead>{t("target")}</TableHead>
                                    <TableHead>{t("shard")}</TableHead>
                                    {runImpl !== undefined && <TableHead aria-label={t("Actions")} />}
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {jobs.map((job) => {
                                    const state = runStates[job.name] ?? IDLE;

                                    return (
                                        <TableRow data-testid={`cron-row-${job.name}`} key={`${job.cron}:${job.name}`}>
                                            <TableCell>{job.name}</TableCell>
                                            <TableCell className="font-mono text-xs tabular-nums">{job.cron}</TableCell>
                                            <TableCell>
                                                <span className="flex items-center gap-2">
                                                    {job.workflow === undefined ? (
                                                        <Badge variant="outline">{t("function")}</Badge>
                                                    ) : (
                                                        <Badge variant="secondary">{t("workflow")}</Badge>
                                                    )}
                                                    <span className="font-mono text-xs">{job.workflow ?? job.functionPath}</span>
                                                </span>
                                            </TableCell>
                                            <TableCell>{job.shardKey ?? ""}</TableCell>
                                            {runImpl !== undefined && (
                                                <TableCell className="text-right">
                                                    <span className="flex items-center justify-end gap-2">
                                                        {state.kind === "ok" && (
                                                            <span className="text-xs text-muted-foreground" data-testid={`cron-ran-${job.name}`}>
                                                                {t("ran")}
                                                            </span>
                                                        )}
                                                        {state.kind === "error" && (
                                                            <span className="text-xs text-destructive" data-testid={`cron-run-error-${job.name}`} role="alert">
                                                                {state.message}
                                                            </span>
                                                        )}
                                                        <ConfirmButton
                                                            confirmLabel={t("Run now?")}
                                                            disabled={state.kind === "running"}
                                                            onConfirm={() => {
                                                                fireAndForget(run(job.name));
                                                            }}
                                                            testId={`cron-run-${job.name}`}
                                                        >
                                                            {state.kind === "running" ? t("Running…") : t("Run now")}
                                                        </ConfirmButton>
                                                    </span>
                                                </TableCell>
                                            )}
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}
        </div>
    );
};

export type { CronTriggersPanelProps };
