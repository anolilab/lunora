import { useLunora } from "@lunora/react";
import type { ChangeEvent, ReactElement } from "react";
import { useEffect, useState } from "react";

import { ConfirmButton } from "../../components/confirm-button";
import ErrorAlert from "../../components/error-alert";
import { LiveError } from "../../components/live-status";
import { ShardInput } from "../../components/shard-input";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useShardKey } from "../../hooks/use-shard-key";
import { useT } from "../../i18n/i18n-context";
import type { MigrationDirection, MigrationRunResult, MigrationStatusRow } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget, formatTimestamp } from "../../lib/internal";
import { recordShard } from "../../lib/shard-history";

interface MigrationsPanelProps {
    /** Shard key the panel targets. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const RUN_MIGRATION = adminRef(ADMIN_FUNCTIONS.runMigration);

/**
 * Inspect and drive data migrations on a single shard.
 *
 * Reads the persisted run-state via the `__lunora_admin__:migrationStatus` RPC
 * and lets an operator kick off a migration by id (`__lunora_admin__:runMigration`)
 * with a direction, an optional batch cap and a dry-run toggle. Both calls
 * travel over the ordinary {@link useLunora} client transport and are gated by
 * the server's `LUNORA_ADMIN_TOKEN` — this component issues no credentials of
 * its own.
 */
export const MigrationsPanel = ({ initialShardKey }: MigrationsPanelProps): ReactElement => {
    const client = useLunora();
    const t = useT();

    const { queryShardKey, setShardKey, shardKey } = useShardKey(initialShardKey);

    const [migrationId, setMigrationId] = useState<string>("");
    const [direction, setDirection] = useState<MigrationDirection>("up");
    const [dryRun, setDryRun] = useState<boolean>(true);
    const [running, setRunning] = useState<boolean>(false);
    const [runResult, setRunResult] = useState<MigrationRunResult | null>(null);
    const [runError, setRunError] = useState<null | string>(null);

    // The status query (and its post-run `refetch`) is keyed by `queryShardKey`,
    // while a run targets the live `shardKey`. Until the debounce catches up the two
    // can disagree, so running would hit one shard while the table refreshes another.
    // Gate the run on the displayed shard being settled.
    const shardSettled = shardKey.trim() === queryShardKey;

    // One-shot read + always-on live subscription for the committed shard. Each
    // server push refreshes the run-state table so an in-progress migration's
    // processed/changed counts update live; `liveError` holds a rejection message
    // (e.g. missing admin token) so the panel can say why it stopped updating.
    const statusQuery = useAdminQuery<{ migrations: MigrationStatusRow[] }>(
        ADMIN_FUNCTIONS.migrationStatus,
        {},
        {
            live: true,
            shardKey: queryShardKey,
        },
    );

    const rows = statusQuery.data?.migrations ?? null;
    const statusError = statusQuery.error;
    const { errorSource: statusErrorSource, liveError } = statusQuery;

    // Record the browsed shard into recent-shards history once its status resolves.
    useEffect(() => {
        if (statusQuery.data !== undefined) {
            recordShard(queryShardKey);
        }
    }, [statusQuery.data, queryShardKey]);

    const run = async (): Promise<void> => {
        const id = migrationId.trim();

        if (id === "") {
            setRunError(t("Enter a migration id"));
            setRunResult(null);

            return;
        }

        setRunning(true);
        setRunError(null);

        try {
            const result = (await client.query(RUN_MIGRATION, { direction, dryRun, id }, callOptions(shardKey))) as MigrationRunResult;

            setRunResult(result);
            // Reload the run-state table so the new processed/changed counts show; a
            // reload failure surfaces via `statusError` (the query's own error) and
            // can't mask the (successful) run result.
            statusQuery.refetch();
        } catch (error) {
            setRunResult(null);
            setRunError(errorMessage(error));
        }

        setRunning(false);
    };

    const runMigration = (): void => {
        fireAndForget(run());
    };

    const onIdChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setMigrationId(event.target.value);
    };

    const onDirectionChange = (event: ChangeEvent<HTMLSelectElement>): void => {
        setDirection(event.target.value === "down" ? "down" : "up");
    };

    const onDryRunChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setDryRun(event.target.checked);
    };

    return (
        <div className="flex flex-col gap-3 pt-4" data-testid="lunora-migrations">
            <div className="flex flex-wrap items-center gap-2">
                <ShardInput onChange={setShardKey} testId="mg-shard-input" value={shardKey} />
                <LiveError message={liveError} prefix="mg" />
            </div>

            {statusError !== null && <ErrorAlert error={statusErrorSource} testId="mg-status-error" />}

            {rows !== null && rows.length === 0 && (
                <EmptyState
                    description={t("Data migrations you run against this shard will be tracked here.")}
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
                            <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.6L4 16m0 4v-4h4" />
                        </svg>
                    }
                    testId="mg-empty"
                    title={t("No migrations have run on this shard.")}
                />
            )}

            {rows !== null && rows.length > 0 && (
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table data-testid="mg-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("id")}</TableHead>
                                    <TableHead>{t("direction")}</TableHead>
                                    <TableHead>{t("status")}</TableHead>
                                    <TableHead>{t("processed")}</TableHead>
                                    <TableHead>{t("changed")}</TableHead>
                                    <TableHead>{t("updated")}</TableHead>
                                    <TableHead>{t("error")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.map((row) => (
                                    <TableRow data-testid={`mg-row-${row.id}`} key={row.id}>
                                        <TableCell>{row.id}</TableCell>
                                        <TableCell>{row.direction}</TableCell>
                                        <TableCell>
                                            <Badge variant="secondary">{row.status}</Badge>
                                        </TableCell>
                                        <TableCell>{row.processed}</TableCell>
                                        <TableCell>{row.changed}</TableCell>
                                        <TableCell>{formatTimestamp(row.updatedAt)}</TableCell>
                                        <TableCell>{row.error ?? ""}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}

            <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-xs">
                <Label>{t("Run migration")}</Label>
                <div className="flex flex-wrap items-center gap-2">
                    <Input
                        aria-label={t("Migration id")}
                        className="w-auto"
                        data-testid="mg-id-input"
                        onChange={onIdChange}
                        placeholder={t("migration id")}
                        value={migrationId}
                    />
                    <select
                        aria-label={t("Direction")}
                        // Mirrors `Input`'s tokens (h-8, px-2.5, text-xs) rather
                        // than hand-rolling its own: this select had drifted to
                        // h-9/text-sm, so one row held three different control
                        // heights. There is no Select primitive to import yet —
                        // when there is, this should use it.
                        className="flex h-8 rounded-md border border-input bg-transparent px-2.5 py-1 text-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
                        data-testid="mg-direction"
                        onChange={onDirectionChange}
                        value={direction}
                    >
                        <option value="up">{t("up")}</option>
                        <option value="down">{t("down")}</option>
                    </select>
                    <Label className="flex items-center gap-1.5" htmlFor="mg-dry-run">
                        <input
                            checked={dryRun}
                            className="size-4 accent-primary"
                            data-testid="mg-dry-run"
                            id="mg-dry-run"
                            onChange={onDryRunChange}
                            type="checkbox"
                        />
                        {t("Dry run")}
                    </Label>
                    {dryRun ? (
                        <Button data-testid="mg-run" disabled={running || !shardSettled} onClick={runMigration} type="button">
                            {running ? t("Running…") : t("Run")}
                        </Button>
                    ) : (
                        // A real (non-dry-run) migration mutates rows — guard it.
                        <ConfirmButton
                            confirmLabel={running ? t("Running…") : t("Run migration?")}
                            disabled={running || !shardSettled}
                            onConfirm={runMigration}
                            testId="mg-run"
                        >
                            {t("Run")}
                        </ConfirmButton>
                    )}
                </div>
            </div>

            {runError !== null && (
                <pre className="text-sm text-destructive whitespace-pre-wrap" data-testid="mg-run-error" role="alert">
                    {runError}
                </pre>
            )}

            {runResult !== null && (
                <p className="text-sm text-muted-foreground" data-testid="mg-run-result">
                    {runResult.dryRun ? t("Dry run: ") : ""}
                    {t("{status} — processed", { status: runResult.status })}
                    {runResult.processed}
                    {t(", changed")}
                    {runResult.changed}
                </p>
            )}
        </div>
    );
};

export type { MigrationsPanelProps };
