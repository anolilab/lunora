import type { ReactElement, ReactNode } from "react";

interface AsyncListProps<T> {
    /** Message shown when the query has resolved to an empty list. */
    empty: string;
    /** Renders the non-empty rows. */
    render: (rows: ReadonlyArray<T>) => ReactNode;
    /** `undefined` while the live query is loading, then the rows. */
    rows: ReadonlyArray<T> | undefined;
}

/**
 * Renders the three states of a live list query — loading, empty, populated —
 * without a nested ternary at every call site. Shared by the dashboard sections.
 */
export const AsyncList = <T,>({ empty, render, rows }: AsyncListProps<T>): ReactElement => {
    if (rows === undefined) {
        return <p className="muted">Loading…</p>;
    }

    if (rows.length === 0) {
        return <p className="muted">{empty}</p>;
    }

    return <>{render(rows)}</>;
};
