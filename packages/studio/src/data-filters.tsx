import type { ChangeEvent, MouseEvent, ReactElement } from "react";
import { useCallback } from "react";

import type { FilterClause, FilterOperator } from "./admin";

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
 * Convert the UI's string-valued filter rows into wire {@link FilterClause}s:
 * drops rows with no column, and coerces a numeric string to a number for the
 * comparison operators (so `age > 18` compares numerically, not lexically).
 * `contains` always stays a string.
 */
const toFilterClauses = (filters: ReadonlyArray<EditableFilter>): FilterClause[] =>
    filters
        .filter((filter) => filter.column !== "")
        .map((filter) => {
            const numeric = filter.operator !== "contains" && filter.value.trim() !== "" && !Number.isNaN(Number(filter.value));

            return { column: filter.column, operator: filter.operator, value: numeric ? Number(filter.value) : filter.value };
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
    onFiltersChange,
    onSearchChange,
    search,
}: {
    columns: ReadonlyArray<string>;
    filters: ReadonlyArray<EditableFilter>;
    onFiltersChange: (filters: EditableFilter[]) => void;
    onSearchChange: (event: ChangeEvent<HTMLInputElement>) => void;
    search: string;
}): ReactElement => {
    const addFilter = useCallback((): void => {
        onFiltersChange([...filters, { column: columns[0] ?? "", operator: "eq", value: "" }]);
    }, [columns, filters, onFiltersChange]);

    const removeFilter = useCallback(
        (event: MouseEvent<HTMLButtonElement>): void => {
            const index = Number(event.currentTarget.dataset.index);

            onFiltersChange(filters.filter((_, position) => position !== index));
        },
        [filters, onFiltersChange],
    );

    const changeColumn = useCallback(
        (event: ChangeEvent<HTMLSelectElement>): void => {
            const index = Number(event.currentTarget.dataset.index);
            const next = event.currentTarget.value;

            onFiltersChange(filters.map((filter, position) => (position === index ? { ...filter, column: next } : filter)));
        },
        [filters, onFiltersChange],
    );

    const changeOperator = useCallback(
        (event: ChangeEvent<HTMLSelectElement>): void => {
            const index = Number(event.currentTarget.dataset.index);
            const next = event.currentTarget.value as FilterOperator;

            onFiltersChange(filters.map((filter, position) => (position === index ? { ...filter, operator: next } : filter)));
        },
        [filters, onFiltersChange],
    );

    const changeValue = useCallback(
        (event: ChangeEvent<HTMLInputElement>): void => {
            const index = Number(event.currentTarget.dataset.index);
            const next = event.currentTarget.value;

            onFiltersChange(filters.map((filter, position) => (position === index ? { ...filter, value: next } : filter)));
        },
        [filters, onFiltersChange],
    );

    return (
        <div className="flex flex-col gap-1.5" data-testid="db-filters">
            <div className="flex flex-wrap items-center gap-1.5">
                <input aria-label="Search rows" data-testid="db-filter" onChange={onSearchChange} placeholder="search table…" value={search} />
                <button data-testid="db-add-filter" onClick={addFilter} type="button">
                    Add filter
                </button>
            </div>

            {filters.map((filter, index) => (
                // eslint-disable-next-line react-x/no-array-index-key -- filter rows are positional; their index IS their identity (no domain id)
                <div className="flex flex-wrap items-center gap-1.5" data-testid="db-filter-row" key={index}>
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
export { DataFilters, toFilterClauses };
