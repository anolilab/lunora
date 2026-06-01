import { type ChangeEvent, type ReactElement, useId, useMemo } from "react";

import { loadRecentShards } from "./shard-history.js";

export interface ShardInputProps {
    readonly onChange: (value: string) => void;
    /** `data-testid` for the input (panels keep their existing id, e.g. `mt-shard-input`). */
    readonly testId: string;
    readonly value: string;
}

/**
 * Shard-key text field shared by every shard-scoped panel. Backed by a
 * `<datalist>` of recently-used shard keys (see {@link loadRecentShards}) so an
 * operator can pick a shard they've visited instead of retyping it — the closest
 * to a shard picker possible without server-side shard enumeration, which
 * Durable Objects don't support. Panels remain responsible for recording a shard
 * as used (via `recordShard`) when they actually query it.
 */
export function ShardInput({ onChange, testId, value }: ShardInputProps): ReactElement {
    const listId = useId();
    // Snapshot once per render; the menu only needs to be fresh on (re)mount and
    // when the panel re-renders after recording a shard.
    const recents = useMemo(() => loadRecentShards(), []);

    return (
        <>
            <input
                aria-label="Shard key"
                data-testid={testId}
                list={recents.length > 0 ? listId : undefined}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    onChange(event.target.value);
                }}
                placeholder="shard key (optional)"
                value={value}
            />
            {recents.length > 0 && (
                <datalist data-testid={`${testId}-recents`} id={listId}>
                    {recents.map((shard) => (
                        <option key={shard} aria-label={shard} value={shard} />
                    ))}
                </datalist>
            )}
        </>
    );
}
