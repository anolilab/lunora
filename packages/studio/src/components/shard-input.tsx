import type { ChangeEvent, ReactElement } from "react";
import { useId, useState } from "react";

import { useT } from "../i18n/i18n-context";
import { loadRecentShards } from "../lib/shard-history";
import { Input } from "./ui/input";

export interface ShardInputProps {
    /** DOM `id` for the input, so an external label's `htmlFor` can target it. Optional. */
    readonly id?: string;
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
export const ShardInput = ({ id, onChange, testId, value }: ShardInputProps): ReactElement => {
    const t = useT();
    const listId = useId();
    // Snapshot once on mount; the menu only needs to be fresh on (re)mount.
    const [recents] = useState<ReadonlyArray<string>>(() => loadRecentShards());

    const onInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
        onChange(event.target.value);
    };

    return (
        <>
            <Input
                aria-label={t("Shard key")}
                className="h-8 w-48"
                data-testid={testId}
                id={id}
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
