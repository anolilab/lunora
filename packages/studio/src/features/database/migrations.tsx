import { useCirrus } from "@cirrus/react";
import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useState } from "react";

import { ConfirmButton } from "../../components/confirm-button";
import { LiveError } from "../../components/live-status";
import { ShardInput } from "../../components/shard-input";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import useLiveAdmin from "../../hooks/use-live-admin";
import { useT } from "../../i18n/i18n-context";
import type { MigrationDirection, MigrationRunResult, MigrationStatusRow } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget, formatTimestamp } from "../../lib/internal";
import { recordShard } from "../../lib/shard-history";
import useLiveShardSeed from "../data/hooks/use-live-shard-seed";

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
    const [rows, setRows] = useState<MigrationStatusRow[] | null>(null);
    const [statusError, setStatusError] = useState<null | string>(null);
    // Always-on live channel; this only holds a rejection message (e.g. missing
    // admin token) so the panel can say why it stopped updating.
    const [liveError, setLiveError] = useState<string | undefined>(undefined);

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
                setRows(result.migrations);
            } catch (error) {
                setRows(null);
                setStatusError(errorMessage(error));

                // Rethrow so the shard-seed hook doesn't commit a shard that failed.
                throw error;
            }
        },
        [client],
    );

    // Debounced shard seed + commit-on-success; the live channel keys on the
    // committed shard (replaces the old Refresh button).
    const committedShard = useLiveShardSeed(shardKey, refresh);

    // Live channel: always on once the seed commits a shard; each server push
    // refreshes the run-state table so an in-progress migration's
    // processed/changed counts update live.
    useLiveAdmin(
        ADMIN_FUNCTIONS.migrationStatus,
        {},
        committedShard ?? "",
        (result) => {
            setStatusError(null);
            setLiveError(undefined);
            setRows((result as { migrations: MigrationStatusRow[] }).migrations);
        },
        committedShard !== undefined,
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
            // A post-run status reload failure shows via `statusError`; don't let it
            // mask the (successful) run result by falling into the catch below.
            await refresh(shardKey).catch(() => {});
        } catch (error) {
            setRunResult(null);
            setRunError(errorMessage(error));
        } finally {
            setRunning(false);
        }
    }, [client, direction, dryRun, migrationId, refresh, shardKey, t]);

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
                <LiveError message={liveError} prefix="mg" />
            </div>

            {statusError !== null && (
                <p className="text-sm text-destructive" data-testid="mg-status-error" role="alert">
                    {statusError}
                </p>
            )}

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
