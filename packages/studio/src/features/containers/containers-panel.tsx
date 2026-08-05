import type { ReactElement } from "react";

import { LiveError } from "../../components/live-status";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useT } from "../../i18n/i18n-context";
import type { LogEntry } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import type { ContainerLifecycleState } from "./fold-container-instances";
import { foldContainerInstances } from "./fold-container-instances";

/** shadcn Badge variant per lifecycle state — running reads calm, error alarming. */
type StateVariant = "destructive" | "info" | "outline" | "secondary" | "success";

const STATE_VARIANT: Record<ContainerLifecycleState, StateVariant> = {
    error: "destructive",
    running: "success",
    sleeping: "info",
    stopped: "outline",
    unknown: "secondary",
};

/**
 * Coerce a (possibly partial or malformed) `getLogs` result into its `entries`
 * array — a truncated payload, or a worker predating the field, yields `[]`
 * rather than seeding the fold with `undefined`.
 */
const entriesOf = (result: unknown): LogEntry[] => {
    const { entries } = (result ?? {}) as { entries?: unknown };

    return Array.isArray(entries) ? (entries as LogEntry[]) : [];
};

/**
 * The Containers observability page — a read-only view of the deployment's live
 * Cloudflare Containers, folded from the lifecycle events `@lunora/container`
 * pushes into the root shard's log buffer (the same stream the Logs panel
 * reads). Per container it shows the current lifecycle state (running / sleeping
 * / stopped / error), the last transition, and any detail (a stop reason / error
 * message).
 *
 * Data-source note: the lifecycle envelope carries `name` + the per-instance
 * Durable Object id + transition + detail (and a process `exitCode` on a stop) —
 * `@lunora/do` folds the Container DO's push to `functionPath:
 * "container:<name>"` and carries the instance id through, so this is a
 * per-instance view. The envelope has no ports/health, so those aren't surfaced
 * (they live in static `defineContainer` config, not the runtime stream). It
 * streams live over the same admin WS the Logs panel uses.
 */
const ContainersPanel = (): ReactElement => {
    const t = useT();

    // Container lifecycle events are pushed to the ROOT shard's buffer
    // (`reportContainerLifecycle` addresses `__root__`), so this reads the root
    // shard (empty key) deployment-wide — no shard selector needed. Live so a
    // start/stop/sleep/error updates the state without a manual refresh.
    const { data, error, liveError } = useAdminQuery<{ entries?: unknown }>(ADMIN_FUNCTIONS.getLogs, {}, { live: true, shardKey: "" });

    const loaded = data !== undefined;
    const rows = foldContainerInstances(entriesOf(data));

    return (
        <div className="flex flex-col gap-6" data-testid="lunora-containers-panel">
            {error !== null && (
                <p className="text-sm text-destructive" data-testid="containers-error" role="alert">
                    {error}
                </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm text-muted-foreground">
                    {t(
                        "Cloudflare Containers are observed from their lifecycle log stream. This shows the current state per instance — ports and health checks aren't carried in that stream.",
                    )}
                </p>
                <LiveError message={liveError} prefix="containers" />
            </div>

            {loaded && rows.length === 0 ? (
                <EmptyState
                    description={t(
                        "No container lifecycle activity yet. Instances declared with defineContainer show up here once they start, sleep, stop, or error.",
                    )}
                    testId="containers-empty"
                    title={t("No container activity")}
                />
            ) : (
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table data-testid="containers-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("Container")}</TableHead>
                                    <TableHead>{t("Instance")}</TableHead>
                                    <TableHead>{t("State")}</TableHead>
                                    <TableHead>{t("Last event")}</TableHead>
                                    <TableHead>{t("Detail")}</TableHead>
                                    <TableHead>{t("Exit")}</TableHead>
                                    <TableHead>{t("When")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.map((row) => (
                                    <TableRow
                                        data-testid={`containers-row-${row.name}${row.instance === undefined ? "" : `-${row.instance}`}`}
                                        key={`${row.name}/${row.instance ?? ""}`}
                                    >
                                        <TableCell className="font-mono text-xs">{row.name}</TableCell>
                                        <TableCell className="max-w-40 truncate font-mono text-xs text-muted-foreground" title={row.instance}>
                                            {row.instance ?? "—"}
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant={STATE_VARIANT[row.state]}>{row.state}</Badge>
                                        </TableCell>
                                        <TableCell className="font-mono text-xs text-muted-foreground">{row.event}</TableCell>
                                        <TableCell className="max-w-64 truncate text-xs text-muted-foreground" title={row.detail}>
                                            {row.detail ?? "—"}
                                        </TableCell>
                                        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">{row.exitCode ?? "—"}</TableCell>
                                        {/* react-doctor-disable-next-line react-doctor/no-locale-format-in-render -- the studio is a client-only SPA with no SSR pass, so there is no server locale to mismatch against */}
                                        <TableCell className="text-xs tabular-nums text-muted-foreground">{new Date(row.timestamp).toLocaleString()}</TableCell>
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

export default ContainersPanel;
