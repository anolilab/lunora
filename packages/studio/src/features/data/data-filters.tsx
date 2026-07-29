import type { ChangeEvent, MouseEvent, ReactElement } from "react";
import { useState } from "react";

import type { FilterClause, FilterOperator } from "../../lib/admin";

/** A filter row as edited in the UI — the value is always a string until coerced for the wire. */
interface EditableFilter {
    column: string;
    operator: FilterOperator;
    value: string;
}

/** Operators offered in the dropdown, in a sensible order, with their display labels. */
const OPERATORS: ReadonlyArray<{ label: string; value: FilterOperator }> = [
    { label: "=", value: "eq" },
    { label: "≠", value: "ne" },
    { label: "<", value: "lt" },
    { label: "≤", value: "lte" },
    { label: ">", value: "gt" },
    { label: "≥", value: "gte" },
    { label: "contains", value: "contains" },
];

/**
 * Coerce a filter value to a number ONLY when it is a *canonical* number literal —
 * i.e. it round-trips exactly (`String(Number(v)) === v`) and is finite. This keeps
 * `age > 18` numeric while leaving numeric-LOOKING strings that are not canonical
 * literals as strings: leading-zero codes (`"00123"`), zip codes, hex (`"0x10"`),
 * exponent shorthand (`"1e3"`), and `"Infinity"` all stay text. That matters because
 * the server binds the value against a `json_extract(__doc__, …)` expression, which
 * has no SQL type affinity — a number bound against a stored TEXT value never matches
 * (`123 = "00123"` is false), so an `eq`/`ne` on such a column (or a facet-value
 * click for it) would silently return zero rows if we coerced. A genuinely-numeric
 * value (`"123"`, `"12.5"`, `"-4"`) still coerces so numeric columns compare right.
 */
const coerceFilterValue = (value: string): number | string => {
    const trimmed = value.trim();
    const asNumber = Number(trimmed);

    return trimmed !== "" && Number.isFinite(asNumber) && String(asNumber) === trimmed ? asNumber : value;
};

/**
 * Convert the UI's string-valued filter rows into wire {@link FilterClause}s:
 * drops rows with no column, and coerces a canonical numeric string to a number for
 * every comparison operator (so `age > 18` compares numerically, not lexically, and
 * an `eq` on a numeric column still matches — see {@link coerceFilterValue} for why a
 * numeric-looking but non-canonical string like a zip code stays text). `contains`
 * always stays a string.
 */
const toFilterClauses = (filters: ReadonlyArray<EditableFilter>): FilterClause[] =>
    // react-doctor-disable-next-line react-doctor/js-combine-iterations -- two passes over a bounded list (chart series, log levels, nav tabs); the single-pass rewrite reads worse and measures the same at these sizes
    filters
        .filter((filter) => filter.column !== "")
        .map((filter) => {
            return {
                column: filter.column,
                operator: filter.operator,
                value: filter.operator === "contains" ? filter.value : coerceFilterValue(filter.value),
            };
        });

/**
 * The data browser's filtering controls: the substring search box plus a stack
 * of structured `column operator value` rows. All state is owned by the parent
 * (the data-browser model); this is the control markup, emitting the full
 * filter array up on every edit. Raw strings (no i18n) to match the surrounding
 * data-browser controls.
 */
const DataFilters = ({
    columns,
    filters,
    onAskAi,
    onFiltersChange,
    onSearchChange,
    search,
}: {
    columns: ReadonlyArray<string>;
    filters: ReadonlyArray<EditableFilter>;
    /** Ask the model for structured clauses. Omitted when no AI binding is available. */
    onAskAi?: (prompt: string) => void;
    onFiltersChange: (filters: EditableFilter[]) => void;
    onSearchChange: (event: ChangeEvent<HTMLInputElement>) => void;
    search: string;
}): ReactElement => {
    const [aiPrompt, setAiPrompt] = useState("");

    const addFilter = (): void => {
        onFiltersChange([...filters, { column: columns[0] ?? "", operator: "eq", value: "" }]);
    };

    const removeFilter = (event: MouseEvent<HTMLButtonElement>): void => {
        const index = Number(event.currentTarget.dataset.index);

        onFiltersChange(filters.filter((_, position) => position !== index));
    };

    const changeColumn = (event: ChangeEvent<HTMLSelectElement>): void => {
        const index = Number(event.currentTarget.dataset.index);
        const next = event.currentTarget.value;

        onFiltersChange(filters.map((filter, position) => (position === index ? { ...filter, column: next } : filter)));
    };

    const changeOperator = (event: ChangeEvent<HTMLSelectElement>): void => {
        const index = Number(event.currentTarget.dataset.index);
        const next = event.currentTarget.value as FilterOperator;

        onFiltersChange(filters.map((filter, position) => (position === index ? { ...filter, operator: next } : filter)));
    };

    const changeValue = (event: ChangeEvent<HTMLInputElement>): void => {
        const index = Number(event.currentTarget.dataset.index);
        const next = event.currentTarget.value;

        onFiltersChange(filters.map((filter, position) => (position === index ? { ...filter, value: next } : filter)));
    };

    return (
        <div className="flex flex-col gap-1.5" data-testid="db-filters">
            <div className="flex flex-wrap items-center gap-1.5">
                <input aria-label="Search rows" data-testid="db-filter" onChange={onSearchChange} placeholder="search table…" value={search} />
                <button data-testid="db-add-filter" onClick={addFilter} type="button">
                    Add filter
                </button>
                {/* Natural-language filtering. Hidden when the app has no AI
                    binding — an affordance that can never work is worse than
                    none. The model returns STRUCTURED clauses, so they land in
                    these same rows for the operator to see and edit before the
                    query runs. */}
                {onAskAi !== undefined && (
                    <>
                        <input
                            aria-label="Describe a filter"
                            data-testid="db-ai-prompt"
                            onChange={(event) => {
                                setAiPrompt(event.target.value);
                            }}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && aiPrompt.trim() !== "") {
                                    event.preventDefault();
                                    onAskAi(aiPrompt.trim());
                                }
                            }}
                            placeholder="describe a filter…"
                            value={aiPrompt}
                        />
                        <button
                            data-testid="db-ai-filter"
                            disabled={aiPrompt.trim() === ""}
                            onClick={() => {
                                onAskAi(aiPrompt.trim());
                            }}
                            type="button"
                        >
                            Suggest
                        </button>
                    </>
                )}
            </div>

            {filters.map((filter, index) => (
                <div
                    className="flex flex-wrap items-center gap-1.5"
                    data-testid="db-filter-row"
                    /* eslint-disable react-x/no-array-index-key -- filter rows are positional; their index IS their identity (no domain id) */
                    // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- filter rows are positional; their index IS their identity (no domain id)
                    key={index}
                    /* eslint-enable react-x/no-array-index-key */
                >
                    <select aria-label="Filter column" data-index={index} data-testid="db-filter-column" onChange={changeColumn} value={filter.column}>
                        {columns.map((column) => (
                            <option key={column} value={column}>
                                {column}
                            </option>
                        ))}
                    </select>
                    <select aria-label="Filter operator" data-index={index} data-testid="db-filter-operator" onChange={changeOperator} value={filter.operator}>
                        {OPERATORS.map((operator) => (
                            <option key={operator.value} value={operator.value}>
                                {operator.label}
                            </option>
                        ))}
                    </select>
                    <input
                        aria-label="Filter value"
                        data-index={index}
                        data-testid="db-filter-value"
                        onChange={changeValue}
                        placeholder="value"
                        value={filter.value}
                    />
                    <button aria-label="Remove filter" data-index={index} data-testid="db-filter-remove" onClick={removeFilter} type="button">
                        ✕
                    </button>
                </div>
            ))}
        </div>
    );
};

export type { EditableFilter };
// react-doctor-disable-next-line react-doctor/only-export-components -- the studio ships one feature per file — panel plus the helpers and types it owns — and this rule wants each of those split in two purely so Fast Refresh keeps component state during dev; a package-wide file split is not worth an HMR-only gain
export { DataFilters, toFilterClauses };
