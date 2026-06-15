import type { MouseEvent, ReactElement } from "react";
import { useCallback } from "react";

import { useT } from "../../i18n/i18n-context";
import type { FacetState } from "./hooks/use-data-browser";

/** Render a facet value for display, distinguishing the empty string and NULL from a real value. */
const formatValue = (value: unknown): string => {
    if (value === null || value === undefined) {
        return "∅";
    }

    if (value === "") {
        return "(empty)";
    }

    if (typeof value === "object") {
        return JSON.stringify(value);
    }

    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- non-object primitives (string/number/boolean/bigint) stringify meaningfully; objects are handled above
    return String(value);
};

/**
 * One faceted column's value rows: a click-to-filter button per distinct value
 * (label + count), the loading/error states, and the truncated note. Split out so
 * each value button gets a stable `onClick` (no fresh closure per render in the
 * parent's JSX). The data-browser model owns the toggle/filter handlers.
 */
const FacetSection = ({
    column,
    onFacetFilter,
    state,
}: {
    column: string;
    onFacetFilter: (column: string, value: unknown) => void;
    state: FacetState;
}): ReactElement => {
    const t = useT();

    const onValueClick = useCallback(
        (event: MouseEvent<HTMLButtonElement>): void => {
            const index = Number(event.currentTarget.dataset["index"]);
            const entry = state.result?.values[index];

            if (entry !== undefined) {
                onFacetFilter(column, entry.value);
            }
        },
        [column, onFacetFilter, state.result],
    );

    return (
        <section className="flex flex-col gap-1" data-testid={`db-facet-${column}`}>
            <span className="font-medium text-foreground">{column}</span>

            {state.loading && state.result === null && <span className="text-muted-foreground">{t("Loading…")}</span>}

            {state.error !== null && (
                <span className="text-destructive" role="alert">
                    {state.error}
                </span>
            )}

            {(state.result?.values ?? []).map((entry, index) => (
                <button
                    className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    data-index={index}
                    data-testid={`db-facet-value-${column}`}
                    key={formatValue(entry.value)}
                    onClick={onValueClick}
                    type="button"
                >
                    <span className="truncate">{formatValue(entry.value)}</span>
                    <span className="shrink-0 tabular-nums text-foreground/70">{entry.count}</span>
                </button>
            ))}

            {state.result?.truncated === true && (
                <span className="text-muted-foreground" data-testid={`db-facet-truncated-${column}`}>
                    {t("Showing the {n} most common values.", { n: state.result.values.length })}
                </span>
            )}
        </section>
    );
};

/**
 * The Datasette-style facet sidebar. The operator toggles a column on (opt-in,
 * since faceting a wide column is costly) and sees its distinct values with their
 * counts over the **active view** (the same filters/search the grid is showing).
 * Clicking a value adds an `eq` filter for that column/value, narrowing the view.
 * Capped to the server's top-N; a truncated note appears when more values existed.
 *
 * Pure markup — all state (`facets`, the toggle, the value-click handler) is owned
 * by the data-browser model. Hidden entirely when there are no columns to facet.
 */
const DataFacets = ({
    columns,
    facets,
    onFacetFilter,
    onToggleFacet,
}: {
    columns: ReadonlyArray<string>;
    facets: Record<string, FacetState>;
    onFacetFilter: (column: string, value: unknown) => void;
    onToggleFacet: (column: string) => void;
}): null | ReactElement => {
    const t = useT();

    const toggle = useCallback(
        (event: MouseEvent<HTMLButtonElement>): void => {
            const { column } = event.currentTarget.dataset;

            if (column !== undefined) {
                onToggleFacet(column);
            }
        },
        [onToggleFacet],
    );

    if (columns.length === 0) {
        return null;
    }

    return (
        <aside className="flex w-56 shrink-0 flex-col gap-3 overflow-auto border-l border-border p-3 text-xs" data-testid="db-facets">
            <div className="flex flex-col gap-1.5">
                <span className="font-medium text-foreground">{t("Facets")}</span>
                <div className="flex flex-wrap gap-1">
                    {columns.map((column) => (
                        <button
                            aria-pressed={column in facets}
                            className="rounded border border-border px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                            data-column={column}
                            data-testid={`db-facet-toggle-${column}`}
                            key={column}
                            onClick={toggle}
                            type="button"
                        >
                            {column}
                        </button>
                    ))}
                </div>
            </div>

            {Object.entries(facets).map(([column, state]) => (
                <FacetSection column={column} key={column} onFacetFilter={onFacetFilter} state={state} />
            ))}
        </aside>
    );
};

export default DataFacets;
