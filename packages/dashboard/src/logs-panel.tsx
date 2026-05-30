import { useCirrus } from "@cirrus/react";
import { type ChangeEvent, type ReactElement, useCallback, useEffect, useState } from "react";

import { ADMIN_FUNCTIONS, type LogEntry, type LogsResult } from "./admin.js";
import { adminRef, callOptions, errorMessage } from "./internal.js";

export interface LogsPanelProps {
    /** Shard key the panel reports on. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const GET_LOGS = adminRef(ADMIN_FUNCTIONS.getLogs);

/**
 * Recent RPC errors for a single shard instance, newest first. Reads via the
 * `__cirrus_admin__:getLogs` RPC over the {@link useCirrus} client; gated by the
 * server's `CIRRUS_ADMIN_TOKEN`.
 *
 * This is intentionally NOT a general application log: `ShardDO` only captures
 * RPC dispatch failures (path + error message), not user `console.*` output,
 * and the buffer is in-memory so it resets when the DO hibernates or restarts.
 * Treat it as a "what's been failing on this instance lately" feed.
 */
export function LogsPanel({ initialShardKey }: LogsPanelProps): ReactElement {
    const client = useCirrus();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [entries, setEntries] = useState<LogEntry[]>([]);
    const [error, setError] = useState<null | string>(null);

    const refresh = useCallback(
        async (shard: string): Promise<void> => {
            setError(null);

            try {
                const result = (await client.query(GET_LOGS, {}, callOptions(shard))) as LogsResult;

                setEntries(result.entries);
            } catch (error_) {
                setEntries([]);
                setError(errorMessage(error_));
            }
        },
        [client],
    );

    useEffect(() => {
        void refresh(initialShardKey ?? "");
    }, [refresh, initialShardKey]);

    return (
        <div data-testid="cirrus-logs">
            <div>
                <input
                    aria-label="Shard key"
                    data-testid="lg-shard-input"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => {
                        setShardKey(event.target.value);
                    }}
                    placeholder="shard key (optional)"
                    value={shardKey}
                />
                <button
                    data-testid="lg-refresh"
                    onClick={() => {
                        void refresh(shardKey);
                    }}
                    type="button"
                >
                    Refresh
                </button>
            </div>

            {error !== null && (
                <p data-testid="lg-error" role="alert">
                    {error}
                </p>
            )}

            {error === null && entries.length === 0 && <p data-testid="lg-empty">No logs.</p>}

            {entries.length > 0 && (
                <table data-testid="lg-table">
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>Level</th>
                            <th>Function</th>
                            <th>Message</th>
                        </tr>
                    </thead>
                    <tbody>
                        {entries.map((entry, index) => (
                            <tr data-testid="lg-row" key={`${String(entry.timestamp)}-${String(index)}`}>
                                <td>{new Date(entry.timestamp).toLocaleString()}</td>
                                <td>{entry.level}</td>
                                <td>{entry.functionPath ?? "—"}</td>
                                <td>{entry.message}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}
