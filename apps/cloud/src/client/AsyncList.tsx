import type { ReactElement, ReactNode } from "react";

import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

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
        return (
            <div className="flex flex-col gap-2">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-2/3" />
            </div>
        );
    }

    if (rows.length === 0) {
        return (
            <Empty className="border-0 py-8">
                <EmptyHeader>
                    <EmptyDescription>{empty}</EmptyDescription>
                </EmptyHeader>
            </Empty>
        );
    }

    return <>{render(rows)}</>;
};
