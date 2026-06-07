import { useCirrus } from "@cirrus/react";
import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import type { MigrationDirection, MigrationRunResult, MigrationStatusRow } from "./admin.js";
import { ADMIN_FUNCTIONS } from "./admin.js";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Label } from "./components/ui/label.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table.js";
import { ConfirmButton } from "./confirm-button.js";
import { useT } from "./i18n-context.js";
import { adminRef, callOptions, errorMessage, fireAndForget, formatTimestamp } from "./internal.js";
import { LiveToggle } from "./live-toggle.js";
import { recordShard } from "./shard-history.js";
import { ShardInput } from "./shard-input.js";
import useLiveAdmin from "./use-live-admin.js";
import { useLiveToggle } from "./use-live-toggle.js";

interface MigrationsPanelProps {
    /** Shard key the panel targets. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const MIGRATION_STATUS = adminRef(ADMIN_FUNCTIONS.migrationStatus);
const RUN_MIGRATION = adminRef(ADMIN_FUNCTIONS.runMigration);

/**
 * Inspect and drive data migrations on a single shard.
 *
 * Reads the persisted run-state via the `__cirrus_admin__:migrationStatus` RPC
 * and lets an operator kick off a migration by id (`__cirrus_admin__:runMigration`)
 * with a direction, an optional batch cap and a dry-run toggle. Both calls
 * travel over the ordinary {@link useCirrus} client transport and are gated by
 * the server's `CIRRUS_ADMIN_TOKEN` — this component issues no credentials of
 * its own.
 */
export const MigrationsPanel = ({ initialShardKey }: MigrationsPanelProps): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    // The shard a successful one-shot last targeted. The live channel keys on
    // this committed value (not the live `shardKey` input) so editing the shard
    // box without refreshing doesn't resubscribe to a half-typed shard on every
    // keystroke — mirroring DataBrowser's `loaded.shard`.
    const [committedShard, setCommittedShard] = useState<null | string>(null);
    const [rows, setRows] = useState<MigrationStatusRow[] | null>(null);
    const [statusError, setStatusError] = useState<null | string>(null);
    const { live, liveError, setLiveError, toggle } = useLiveToggle();

    const [migrationId, setMigrationId] = useState<string>("");
    const [direction, setDirection] = useState<MigrationDirection>("up");
    const [dryRun, setDryRun] = useState<boolean>(true);
    const [running, setRunning] = useState<boolean>(false);
    const [runResult, setRunResult] = useState<MigrationRunResult | null>(null);
    const [runError, setRunError] = useState<null | string>(null);

    const refresh = useCallback(
        async (shard: string): Promise<void> => {
            setStatusError(null);

            try {
                const result = (await client.query(MIGRATION_STATUS, {}, callOptions(shard))) as { migrations: MigrationStatusRow[] };

                recordShard(shard);
                setCommittedShard(shard);
                setRows(result.migrations);
            } catch (error) {
                setRows(null);
                setStatusError(errorMessage(error));
            }
        },
        [client],
    );

    useEffect(() => {
        fireAndForget(refresh(initialShardKey ?? ""));
    }, [refresh, initialShardKey]);

    // Live channel: while toggled on, each server push refreshes the run-state
    // table so an in-progress migration's processed/changed counts update live.
    useLiveAdmin(
        ADMIN_FUNCTIONS.migrationStatus,
        {},
        committedShard ?? "",
        (result) => {
            setStatusError(null);
            setLiveError(undefined);
            setRows((result as { migrations: MigrationStatusRow[] }).migrations);
        },
        live && committedShard !== null,
        setLiveError,
    );

    const run = useCallback(async (): Promise<void> => {
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
            await refresh(shardKey);
        } catch (error) {
            setRunResult(null);
            setRunError(errorMessage(error));
        } finally {
            setRunning(false);
        }
    }, [client, direction, dryRun, migrationId, refresh, shardKey, t]);

    const refreshCurrent = useCallback((): void => {
        fireAndForget(refresh(shardKey));
    }, [refresh, shardKey]);

    const runMigration = useCallback((): void => {
        fireAndForget(run());
    }, [run]);

    const onIdChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setMigrationId(event.target.value);
    }, []);

    const onDirectionChange = useCallback((event: ChangeEvent<HTMLSelectElement>): void => {
        setDirection(event.target.value === "down" ? "down" : "up");
    }, []);

    const onDryRunChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setDryRun(event.target.checked);
    }, []);

    return (
        <div className="flex flex-col gap-3" data-testid="cirrus-migrations">
            <div className="flex flex-wrap items-center gap-2">
                <ShardInput onChange={setShardKey} testId="mg-shard-input" value={shardKey} />
                <Button data-testid="mg-refresh" onClick={refreshCurrent} size="sm" type="button" variant="outline">
                    {t("Refresh")}
                </Button>
                <LiveToggle live={live} liveError={liveError} onToggle={toggle} prefix="mg" />
            </div>

            {statusError !== null && (
                <p className="text-sm text-destructive" data-testid="mg-status-error" role="alert">
                    {statusError}
                </p>
            )}

            {rows !== null && rows.length === 0 && (
                <p className="text-sm text-muted-foreground" data-testid="mg-empty">
                    {t("No migrations have run on this shard.")}
                </p>
            )}

            {rows !== null && rows.length > 0 && (
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
            )}

            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
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
                        className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
                        <Button data-testid="mg-run" disabled={running} onClick={runMigration} size="sm" type="button">
                            {running ? t("Running…") : t("Run")}
                        </Button>
                    ) : (
                        // A real (non-dry-run) migration mutates rows — guard it.
                        <ConfirmButton confirmLabel={running ? t("Running…") : t("Run migration?")} disabled={running} onConfirm={runMigration} testId="mg-run">
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
