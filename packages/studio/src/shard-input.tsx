import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useId, useState } from "react";

import { Input } from "./components/ui/input.js";
import { useT } from "./i18n-context.js";
import { loadRecentShards } from "./shard-history.js";

export interface ShardInputProps {
    readonly onChange: (value: string) => void;
    /** `data-testid` for the input (panels keep their existing id, e.g. `mt-shard-input`). */
    readonly testId: string;
    readonly value: string;
}

/**
 * Shard-key text field shared by every shard-scoped panel. Backed by a
 * `&lt;datalist>` of recently-used shard keys (see {@link loadRecentShards}) so an
 * operator can pick a shard they've visited instead of retyping it — the closest
 * to a shard picker possible without server-side shard enumeration, which
 * Durable Objects don't support. Panels remain responsible for recording a shard
 * as used (via `recordShard`) when they actually query it.
 */
export const ShardInput = ({ onChange, testId, value }: ShardInputProps): ReactElement => {
    const t = useT();
    const listId = useId();
    // Snapshot once on mount; the menu only needs to be fresh on (re)mount.
    const [recents] = useState<ReadonlyArray<string>>(() => loadRecentShards());

    const onInputChange = useCallback(
        (event: ChangeEvent<HTMLInputElement>): void => {
            onChange(event.target.value);
        },
        [onChange],
    );

    return (
        <>
            <Input
                aria-label={t("Shard key")}
                className="h-8 w-48"
                data-testid={testId}
                list={recents.length > 0 ? listId : undefined}
                onChange={onInputChange}
                placeholder={t("shard key (optional)")}
                value={value}
            />
            {recents.length > 0 && (
                <datalist data-testid={`${testId}-recents`} id={listId}>
                    {recents.map((shard) => (
                        <option aria-label={shard} key={shard} value={shard} />
                    ))}
                </datalist>
            )}
        </>
    );
};
