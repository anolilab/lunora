import type { ReactElement, ReactNode } from "react";
import { useEffect, useRef } from "react";

import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

import { captureEvent } from "./analytics";
import { useScreen } from "./tabs";

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
    const screen = useScreen();
    const count = rows?.length;
    const reported = useRef(false);

    // What the operator actually found when they opened this screen.
    //
    // Every list in the studio resolves through here, so one effect answers the
    // question no per-screen instrumentation answers well: which screens are
    // dead ends. A tab with a high view count and `rows: 0` on most of those
    // views is a page whose empty state is doing the real work — and the empty
    // copy is usually still the placeholder nobody revisited.
    //
    // Once per mount, via the ref: `count` changes whenever a live query pushes
    // a row, and re-reporting then would measure how busy a tenant is instead
    // of what the operator arrived to.
    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- not an event: this measures an impression, that the operator SAW this list resolve. There is no handler to move it to, and the rule's advice — lift it to the parent — is the fourteen-file edit this component exists to avoid.
        if (count === undefined || reported.current) {
            return;
        }

        reported.current = true;

        // `empty` is the static copy for this list — it is what distinguishes
        // the two lists on a screen that has two, and it carries no tenant data.
        captureEvent("studio_list_resolved", { list: empty, rows: count, screen });
    }, [count, empty, screen]);

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
