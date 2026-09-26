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

    return (
        <GridPagination
            hasNext={offset + count < total}
            hasPrevious={offset > 0}
            onNext={() => {
                onOffsetChange(offset + pageSize);
            }}
            onPrevious={() => {
                onOffsetChange(Math.max(0, offset - pageSize));
            }}
            prefix={prefix}
            rangeEnd={offset + count}
            rangeStart={count === 0 ? 0 : offset + 1}
            total={total}
        />
    );
};

/**
 * A page offset that belongs to `owner` (an organization id, say): when the
 * owner changes, the offset reads as 0 again without an effect, so a new owner
 * never opens on the previous one's page.
 */
const useOwnedOffset = (owner: string): [number, (offset: number) => void] => {
    const [page, setPage] = useState({ offset: 0, owner });

    return [
        page.owner === owner ? page.offset : 0,
        (offset: number): void => {
            setPage({ offset, owner });
        },
    ];
};

export { AuthPager, useOwnedOffset };
