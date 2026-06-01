import { useCirrus } from "@cirrus/react";
import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import type { MigrationDirection, MigrationRunResult, MigrationStatusRow } from "./admin.js";
import { ADMIN_FUNCTIONS } from "./admin.js";
import { ConfirmButton } from "./confirm-button.js";
import { adminRef, callOptions, errorMessage, formatTimestamp } from "./internal.js";
import { LiveToggle } from "./live-toggle.js";
import { recordShard } from "./shard-history.js";
import { ShardInput } from "./shard-input.js";
import { useLiveAdmin } from "./use-live-admin.js";
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
export function MigrationsPanel({ initialShardKey }: MigrationsPanelProps): ReactElement {
    const client = useCirrus();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
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
                setRows(result.migrations);
            } catch (error) {
                setRows(null);
                setStatusError(errorMessage(error));
            }
        },
        [client],
    );

    useEffect(() => {
        void refresh(initialShardKey ?? "");
    }, [refresh, initialShardKey]);

    // Live channel: while toggled on, each server push refreshes the run-state
    // table so an in-progress migration's processed/changed counts update live.
    useLiveAdmin(
        ADMIN_FUNCTIONS.migrationStatus,
        {},
        shardKey,
        (result) => {
            setStatusError(null);
            setLiveError(null);
            setRows((result as { migrations: MigrationStatusRow[] }).migrations);
        },
        live,
        setLiveError,
    );

    const run = useCallback(async (): Promise<void> => {
        const id = migrationId.trim();

        if (id === "") {
            setRunError("Enter a migration id");
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
    }, [client, direction, dryRun, migrationId, refresh, shardKey]);

    return (
        <div data-testid="cirrus-migrations">
            <div>
                <ShardInput onChange={setShardKey} testId="mg-shard-input" value={shardKey} />
                <button
                    data-testid="mg-refresh"
                    onClick={() => {
                        void refresh(shardKey);
                    }}
                    type="button"
                >
                    Refresh
                </button>
                <LiveToggle live={live} liveError={liveError} onToggle={toggle} prefix="mg" />
            </div>

            {statusError !== null && (
                <p data-testid="mg-status-error" role="alert">
                    {statusError}
                </p>
            )}

            {rows !== null && rows.length === 0 && <p data-testid="mg-empty">No migrations have run on this shard.</p>}

            {rows !== null && rows.length > 0 && (
                <table data-testid="mg-table">
                    <thead>
                        <tr>
                            <th>id</th>
                            <th>direction</th>
                            <th>status</th>
                            <th>processed</th>
                            <th>changed</th>
                            <th>updated</th>
                            <th>error</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row) => (
                            <tr data-testid={`mg-row-${row.id}`} key={row.id}>
                                <td>{row.id}</td>
                                <td>{row.direction}</td>
                                <td>{row.status}</td>
                                <td>{row.processed}</td>
                                <td>{row.changed}</td>
                                <td>{formatTimestamp(row.updatedAt)}</td>
                                <td>{row.error ?? ""}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            <fieldset>
                <legend>Run migration</legend>
                <input
                    aria-label="Migration id"
                    data-testid="mg-id-input"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => {
                        setMigrationId(event.target.value);
                    }}
                    placeholder="migration id"
                    value={migrationId}
                />
                <select
                    aria-label="Direction"
                    data-testid="mg-direction"
                    onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                        setDirection(event.target.value === "down" ? "down" : "up");
                    }}
                    value={direction}
                >
                    <option value="up">up</option>
                    <option value="down">down</option>
                </select>
                <label htmlFor="mg-dry-run">
                    <input
                        checked={dryRun}
                        data-testid="mg-dry-run"
                        id="mg-dry-run"
                        onChange={(event: ChangeEvent<HTMLInputElement>) => {
                            setDryRun(event.target.checked);
                        }}
                        type="checkbox"
                    />
                    Dry run
                </label>
                {dryRun ? (
                    <button
                        data-testid="mg-run"
                        disabled={running}
                        onClick={() => {
                            void run();
                        }}
                        type="button"
                    >
                        {running ? "Running…" : "Run"}
                    </button>
                ) : (
                    // A real (non-dry-run) migration mutates rows — guard it.
                    <ConfirmButton
                        confirmLabel={running ? "Running…" : "Run migration?"}
                        disabled={running}
                        onConfirm={() => {
                            void run();
                        }}
                        testId="mg-run"
                    >
                        Run
                    </ConfirmButton>
                )}
            </fieldset>

            {runError !== null && (
                <pre data-testid="mg-run-error" role="alert">
                    {runError}
                </pre>
            )}

            {runResult !== null && (
                <p data-testid="mg-run-result">
                    {runResult.dryRun ? "Dry run: " : ""}
                    {runResult.status} — processed {runResult.processed}, changed {runResult.changed}
                </p>
            )}
        </div>
    );
}

export type { MigrationsPanelProps };
