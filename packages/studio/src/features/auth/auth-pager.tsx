import type { ReactElement } from "react";
import { useState } from "react";

import GridPagination from "../data/grid-pagination";

interface AuthPagerProps {
    /** Rows shown on the current page. */
    readonly count: number;
    readonly offset: number;
    readonly onOffsetChange: (offset: number) => void;
    readonly pageSize: number;
    /** Scopes the pager's `data-testid`s (`{prefix}-next`, `{prefix}-page-info`, …). */
    readonly prefix: string;
    /** Whole-list total the auth admin endpoint reports alongside each page; nothing renders until it has loaded. */
    readonly total: number | undefined;
}

/**
 * Pager for an offset-paged auth admin list: "x–y of N" plus Previous/Next. The auth
 * endpoints all return `{ rows, total }`, so every list can say how much exists
 * and reach past its first page instead of silently capping.
 */
const AuthPager = ({ count, offset, onOffsetChange, pageSize, prefix, total }: AuthPagerProps): ReactElement | null => {
    if (total === undefined) {
        return null;
    }

    // A delete elsewhere can shrink `total` below the page on screen; Previous
    // then lands on the last page that still has rows rather than an empty one.
    const lastPageOffset = Math.max(0, Math.floor((total - 1) / pageSize) * pageSize);

    return (
        <GridPagination
            hasNext={offset + count < total}
            hasPrevious={offset > 0}
            onNext={() => {
                onOffsetChange(offset + pageSize);
            }}
            onPrevious={() => {
                onOffsetChange(Math.max(0, Math.min(offset - pageSize, lastPageOffset)));
            }}
            prefix={prefix}
            rangeEnd={count === 0 ? 0 : offset + count}
            rangeStart={count === 0 ? 0 : offset + 1}
            total={total}
        />
    );
};

/**
 * A page offset that belongs to `owner` (an organization id, say): an owner
 * change resets the stored offset during render (React's adjust-state-on-prop
 * pattern, no effect), so every newly selected owner — including one picked
 * before — opens on its first page.
 */
const useOwnedOffset = (owner: string): [number, (offset: number) => void] => {
    const [page, setPage] = useState({ offset: 0, owner });

    if (page.owner !== owner) {
        setPage({ offset: 0, owner });
    }

    return [
        page.owner === owner ? page.offset : 0,
        (offset: number): void => {
            setPage({ offset, owner });
        },
    ];
};

export { AuthPager, useOwnedOffset };
