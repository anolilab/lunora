import { useCirrus } from "@cirrus/react";
import { type ChangeEvent, type ReactElement, useCallback, useEffect, useMemo, useState } from "react";

import { ADMIN_FUNCTIONS, type LogEntry, type LogLevel, type LogsResult } from "./admin.js";
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
    const [search, setSearch] = useState<string>("");
    const [levelFilter, setLevelFilter] = useState<string>("all");

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

    // Distinct levels present in the fetched buffer, in a stable severity order,
    // so the dropdown only offers levels that can actually match something.
    const levels = useMemo<LogLevel[]>(() => {
        const present = new Set(entries.map((entry) => entry.level));

        return (["debug", "info", "warn", "error"] as const).filter((level) => present.has(level));
    }, [entries]);

    // Client-side search (message substring, case-insensitive) AND level filter,
    // derived from the already-fetched entries — never triggers a refetch.
    const filtered = useMemo<LogEntry[]>(() => {
        const needle = search.trim().toLowerCase();

        return entries.filter((entry) => {
            if (levelFilter !== "all" && entry.level !== levelFilter) {
                return false;
            }

            return needle === "" || entry.message.toLowerCase().includes(needle);
        });
    }, [entries, search, levelFilter]);

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
                <input
                    aria-label="Search messages"
                    data-testid="lg-search"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => {
                        setSearch(event.target.value);
                    }}
                    placeholder="search message"
                    value={search}
                />
                <select
                    aria-label="Level filter"
                    data-testid="lg-level-filter"
                    onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                        setLevelFilter(event.target.value);
                    }}
                    value={levelFilter}
                >
                    <option value="all">all</option>
                    {levels.map((level) => (
                        <option key={level} value={level}>
                            {level}
                        </option>
                    ))}
                </select>
            </div>

            {error !== null && (
                <p data-testid="lg-error" role="alert">
                    {error}
                </p>
            )}

            {error === null && filtered.length === 0 && <p data-testid="lg-empty">No logs.</p>}

            {filtered.length > 0 && (
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
                        {filtered.map((entry, index) => (
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
