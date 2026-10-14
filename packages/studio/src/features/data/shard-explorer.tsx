import type { ReactElement } from "react";
import { useRef, useState } from "react";

import { useT } from "../../i18n/i18n-context";
import type { TableInfo } from "../../lib/admin";
import { fireAndForget } from "../../lib/internal";
import { loadRecentShards } from "../../lib/shard-history";

/**
 * The maximum number of rows shown in the shard summary table. Bounded so the
 * popover never renders an unbounded list when a shard has many tables.
 */
const MAX_SUMMARY_TABLES = 50;

/**
 * Props for the {@link ShardExplorer} component.
 *
 * All data-fetching is delegated to the caller via `onFetchTables` so the
 * component is purely presentational and independently testable.
 */
interface ShardExplorerProps {
    /**
     * Fetch the table list for `shardKey`. Called when the operator picks a shard
     * from the history list. Resolves with a (possibly empty) array of
     * `{ name, rowCount }` entries, or rejects/returns `undefined` on error.
     */
    readonly onFetchTables: (shardKey: string) => Promise<ReadonlyArray<TableInfo> | undefined>;
    /** Called when the operator picks a shard — the parent should switch to it. */
    readonly onSelect: (shardKey: string) => void;
}

/** Props for the shard list item button. */
interface ShardButtonProps {
    readonly active: boolean;
    readonly onPick: (shard: string) => void;
    readonly shard: string;
}

/** A single recent-shard button that notifies the parent when clicked. */
const ShardButton = ({ active, onPick, shard }: ShardButtonProps): ReactElement => {
    const handleClick = (): void => {
        onPick(shard);
    };

    return (
        <button
            className={`w-full rounded px-2 py-0.5 text-left text-xs transition-colors hover:bg-accent ${active ? "bg-accent font-medium" : ""}`}
            data-testid={`shard-explorer-item-${shard}`}
            onClick={handleClick}
            type="button"
        >
            {shard}
        </button>
    );
};

/**
 * A collapsible "recent shards" picker beside the shard-key input. Shows the
 * `sessionStorage`-persisted shard-visit history as clickable buttons; selecting
 * one calls `onSelect` (to switch the data browser) and fires `onFetchTables`
 * to show a live table/row-count summary below the list.
 *
 * Cloudflare Durable Objects are not enumerable server-side, so the list is
 * bounded by what the operator has actually visited. The summary caps at
 * {@link MAX_SUMMARY_TABLES} tables so the popover stays concise.
 */
const ShardExplorer = ({ onFetchTables, onSelect }: ShardExplorerProps): ReactElement | null => {
    const t = useT();
    // Snapshot once on mount so the list stays stable during a session.
    const [recents] = useState<ReadonlyArray<string>>(() => loadRecentShards());

    const [open, setOpen] = useState<boolean>(false);
    const [activeShard, setActiveShard] = useState<string | undefined>(undefined);
    const [tables, setTables] = useState<ReadonlyArray<TableInfo> | undefined>(undefined);
    const [loading, setLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | undefined>(undefined);

    // Monotonically-increasing request counter used to discard stale responses.
    // When the operator clicks shard A then B in quick succession, the fetch for A
    // may resolve after B's; incrementing the counter on each pick and comparing
    // inside the async closure ensures only the latest response wins.
    const requestIdRef = useRef<number>(0);

    const toggleOpen = (): void => {
        setOpen((current) => !current);
    };

    const pickShardAsync = async (shardKey: string): Promise<void> => {
        onSelect(shardKey);
        setActiveShard(shardKey);
        setTables(undefined);
        setError(undefined);
        setLoading(true);

        requestIdRef.current += 1;
        const myRequestId = requestIdRef.current;

        try {
            const result = await onFetchTables(shardKey);

            // Discard if a newer pick superseded this one while it was in flight.
            if (requestIdRef.current === myRequestId) {
                setTables(result?.slice(0, MAX_SUMMARY_TABLES));
            }
        } catch (error_) {
            if (requestIdRef.current === myRequestId) {
                setError((error_ as Error).message);
            }
        }

        if (requestIdRef.current === myRequestId) {
            setLoading(false);
        }
    };

    const pickShard = (shardKey: string): void => {
        fireAndForget(pickShardAsync(shardKey));
    };

    // No history — render nothing (the ShardInput's datalist already covers the
    // empty case; surfacing a "no history" panel would add noise).
    if (recents.length === 0) {
        return null;
    }

    return (
        <div data-testid="shard-explorer">
            <button
                aria-controls="shard-explorer-panel"
                aria-expanded={open}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                data-testid="shard-explorer-toggle"
                onClick={toggleOpen}
                type="button"
            >
                {t("Shards seen")}
                <span aria-hidden="true" className={`ml-0.5 transition-transform ${open ? "rotate-180" : ""}`}>
                    ▾
                </span>
            </button>

            {open && (
                <div
                    className="mt-1 flex flex-col gap-1 rounded-md border border-border bg-popover p-2"
                    data-testid="shard-explorer-panel"
                    id="shard-explorer-panel"
                >
                    <p className="text-xs text-muted-foreground" data-testid="shard-explorer-hint">
                        {t("Recently visited shards — click to switch")}
                    </p>
                    <ul className="flex flex-col gap-0.5" data-testid="shard-explorer-list">
                        {recents.map((shard) => (
                            <li key={shard}>
                                <ShardButton active={activeShard === shard} onPick={pickShard} shard={shard} />
                            </li>
                        ))}
                    </ul>

                    {activeShard !== undefined && (
                        <div className="mt-1 border-t border-border pt-1" data-testid="shard-explorer-summary">
                            <p className="mb-1 text-xs font-medium text-foreground" data-testid="shard-explorer-summary-title">
                                {t("{shard} tables", { shard: activeShard })}
                            </p>

                            {loading && (
                                <p className="text-xs text-muted-foreground" data-testid="shard-explorer-loading">
                                    {t("Loading…")}
                                </p>
                            )}

                            {error !== undefined && (
                                <p className="text-xs text-destructive" data-testid="shard-explorer-error" role="alert">
                                    {error}
                                </p>
                            )}

                            {!loading && error === undefined && tables?.length === 0 && (
                                <p className="text-xs text-muted-foreground" data-testid="shard-explorer-empty">
                                    {t("No tables in this shard.")}
                                </p>
                            )}

                            {!loading && error === undefined && tables !== undefined && tables.length > 0 && (
                                <ul className="flex flex-col gap-0.5" data-testid="shard-explorer-tables">
                                    {tables.map((tableInfo) => (
                                        <li className="flex items-center justify-between text-xs" key={tableInfo.name}>
                                            <span data-testid={`shard-explorer-table-${tableInfo.name}`}>{tableInfo.name}</span>
                                            <span className="text-muted-foreground" data-testid={`shard-explorer-rowcount-${tableInfo.name}`}>
                                                {tableInfo.rowCount}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export { MAX_SUMMARY_TABLES, ShardExplorer };
export type { ShardExplorerProps };
