import type { ChangeEvent, MouseEvent, ReactElement } from "react";
import { useState } from "react";

import { useT } from "../../i18n/i18n-context";
import type { FilterClause, FilterOperator } from "../../lib/admin";

/** A filter row as edited in the UI — the value is always a string until coerced for the wire. */
interface EditableFilter {
    column: string;

    /**
     * The exact wire value this row carries, when the row did NOT come from the
     * operator typing into the box: a facet-value click, or hydration from a URL
     * / saved query. Present as a one-element tuple so `null` — itself a
     * meaningful filter value — is distinguishable from "no literal".
     *
     * `value` still holds that value's display text (the box has to show
     * something), but {@link toFilterClauses} sends the literal instead of
     * re-deriving a value from the text. Re-deriving is what made a facet
     * disagree with the rows it summarises: a TEXT column faceted as `12345 (2)`
     * round-tripped through {@link coerceFilterValue} as the NUMBER `12345`, and
     * the server compares it against `json_extract(__doc__, …)`, which has no
     * type affinity — so `12345 = '12345'` is false and the grid came back
     * empty under a sidebar still reading "2". A NULL group fared the same way,
     * flattening to `""`.
     *
     * Cleared the moment the operator edits the column or the value, because
     * from then on the text IS the source of truth and must be coerced like any
     * typed value (`age > 18` has to compare numerically).
     */
    literal?: [unknown];

    operator: FilterOperator;

    /**
     * Dot-separated field names nested under `column`, as typed (`city`,
     * `geo.city`). Absent or empty addresses the column itself. {@link toFilterClauses}
     * splits it into the wire `path`, dropping empty segments.
     */
    path?: string;

    /**
     * The exact wire `path` this row carries when it was hydrated or suggested
     * rather than typed. The server accepts a field name that itself holds a dot
     * (`["a.b"]`), which the dotted {@link EditableFilter.path} text cannot tell
     * from two segments, so splitting that text back would address a different
     * field. Cleared when the operator edits the path box, since the text is then
     * the source of truth.
     */
    pathSegments?: string[];
    value: string;
}

/** Symbolic operators offered in the dropdown, in a sensible order. `has` is labelled through `t()` at render time. */
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
 * The wire value for a `has` row. `has` tests membership of a JSON element, and a
 * JSON boolean element is only found by a boolean, so `true` and `false` become
 * booleans here; any other text takes the same coercion as every operator. `eq`
 * and `ne` never reach this: `true` there stays text, as it always has.
 *
 * A value in double quotes is the text between them, never coerced: the match is
 * typed, so `10` finds the number and `"10"` finds the string (`"true"` the text).
 */
const coerceHasValue = (value: string): boolean | number | string => {
    const trimmed = value.trim();
    const quoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : undefined;

    return quoted ?? (trimmed === "true" || trimmed === "false" ? trimmed === "true" : coerceFilterValue(value));
};

/** The wire value of a typed row: `has` has its own boolean-aware coercion, every other operator the numeric one. */
const coerceRowValue = (filter: EditableFilter): boolean | number | string =>
    filter.operator === "has" ? coerceHasValue(filter.value) : coerceFilterValue(filter.value);

/** A typed row whose value is blank under an operator that needs one — see {@link toFilterClauses}. */
const isVacuous = (filter: EditableFilter): boolean => {
    if (filter.operator === "contains") {
        return filter.value === "";
    }

    return filter.operator !== "eq" && filter.operator !== "ne" && filter.literal === undefined && filter.value.trim() === "";
};

/**
 * The wire `path` for a row: the segments it carries verbatim, else its typed text
 * split on dots, or `undefined` when nothing names a field. Empty segments (`geo.`
 * while typing, `a..b`) are dropped, because the server refuses one outright.
 */
const wirePath = (filter: EditableFilter): string[] | undefined => {
    if (filter.pathSegments !== undefined) {
        return filter.pathSegments;
    }

    const segments = (filter.path ?? "")
        .split(".")
        .map((segment) => segment.trim())
        .filter((segment) => segment !== "");

    return segments.length === 0 ? undefined : segments;
};

/**
 * Convert the UI's string-valued filter rows into wire {@link FilterClause}s:
 * drops rows with no column, and coerces a canonical numeric string to a number for
 * every comparison operator (so `age > 18` compares numerically, not lexically, and
 * an `eq` on a numeric column still matches — see {@link coerceFilterValue} for why a
 * numeric-looking but non-canonical string like a zip code stays text). `contains`
 * always stays a string.
 *
 * A row carrying a {@link EditableFilter.literal} skips coercion entirely and
 * sends that value verbatim: it was produced by a facet or a saved view, not
 * typed, so its type is already known and guessing one from its text can only
 * lose. `contains` is the exception — it is a substring test over text, so it
 * takes the text either way.
 *
 * A row with nothing to test against is dropped too: a `contains ""` matches
 * every row, and an empty range bound (`age > ""`) compares a column against the
 * empty string rather than narrowing it. Such a row is only ever a half-edited
 * one, and sending it would put "Delete N matching" over the whole table. An
 * empty `eq` / `ne` stays — "is (not) the empty string" is a real test, and
 * `eq ""` is what a freshly added row starts as.
 */
const toFilterClauses = (filters: ReadonlyArray<EditableFilter>): FilterClause[] =>
    // react-doctor-disable-next-line react-doctor/js-combine-iterations -- two passes over the operator's own filter rows — a handful, edited by hand
    filters
        .filter((filter) => filter.column !== "" && !isVacuous(filter))
        .map((filter) => {
            const path = wirePath(filter);
            const pathField = path === undefined ? {} : { path };

            if (filter.operator === "contains") {
                return { column: filter.column, operator: filter.operator, ...pathField, value: filter.value };
            }

            return {
                column: filter.column,
                operator: filter.operator,
                ...pathField,
                value: filter.literal === undefined ? coerceRowValue(filter) : filter.literal[0],
            };
        });

/**
 * Apply a column or value edit to a filter row, dropping any pinned literal: the
 * operator has touched the row, so its text is the source of truth again. Rebuilt
 * field by field rather than spread-and-delete, so a field added to `EditableFilter`
 * later has to be considered here rather than silently surviving an edit.
 */
const typedFilter = (filter: EditableFilter, patch: Partial<EditableFilter>): EditableFilter => {
    return { column: filter.column, operator: filter.operator, path: filter.path, pathSegments: filter.pathSegments, value: filter.value, ...patch };
};

/**
 * The data browser's filtering controls: the substring search box plus a stack
 * of structured `column operator value` rows. All state is owned by the parent
 * (the data-browser model); this is the control markup, emitting the full
 * filter array up on every edit. Raw strings (no i18n) to match the surrounding
 * data-browser controls.
 *
 * ## Why these rows are NOT run through the mask preview
 *
 * Every other read surface in the shard browser honours the "Mask sensitive
 * columns" toggle — grid cells, the transposed and JSON views, the row-detail
 * drawer, all three exports, the facet sidebar — and the `.global()` browser
 * masks its drill-down chips too. This bar deliberately does not, and the
 * question has been raised twice, so here is the enumeration it rests on.
 *
 * Two of the ways a value reaches these rows are DATA-DERIVED — the operator did
 * not type it — and those are the ones that could have leaked.
 *
 * A FACET-VALUE CLICK (`facetFilter` in `use-data-browser`) is closed at the
 * source: `DataFacets` withholds both the toggle and any open section for a
 * mask-covered column while the preview is on, so this can only reach a covered
 * column after the operator switched the preview OFF — a deliberate reveal of the
 * same value, from the same screen.
 *
 * HYDRATION FROM THE URL or a saved query (`initialFilters` → `toEditableFilters`)
 * is the shared-link case, and the one that looks like the `.global()` drill-down
 * chips — but it is not, because of the invariant below.
 *
 * (The AI "describe a filter" affordance sends column names and the prompt, never
 * a row, so it cannot lift a stored secret into a clause. That is enforced by
 * `@lunora/do`'s `sql-assistant.test.ts` — "sends the caller's columns and prompt
 * and nothing else" — rather than asserted here, because a claim about another
 * package that nothing checks is how a comment goes stale.)
 *
 * The invariant that makes both harmless: **a filter clause rendered here is
 * always simultaneously rendered verbatim in the address bar.** `useDataBrowser`
 * mirrors the loaded view through `onViewChange`, and `table-editor.tsx` writes
 * it straight into `?filters=<json>` on every change. So masking a row would
 * blank a value that is legible, unmasked, three inches above the input — while
 * making the filter impossible to edit. It would cost usability and buy nothing.
 *
 * That is exactly what separates this bar from the `.global()` browser's
 * drill-down chips, which ARE masked: those are read-only (nothing to edit),
 * they are fed ONLY by a facet click, and `global-data-browser` keeps them in
 * local state that never reaches the URL — so masking them genuinely removes a
 * value from the screen.
 *
 * **If either half of that stops being true — a filter row that is not mirrored
 * to `?filters=`, or a read-only filter display — revisit this.** Both halves are
 * pinned by `__tests__/features/data/data-browser-mask.test.tsx`'s
 * "dataBrowser masking — filters" block.
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
    const t = useT();

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

        onFiltersChange(filters.map((filter, position) => (position === index ? typedFilter(filter, { column: next }) : filter)));
    };

    const changeOperator = (event: ChangeEvent<HTMLSelectElement>): void => {
        const index = Number(event.currentTarget.dataset.index);
        const next = event.currentTarget.value as FilterOperator;

        onFiltersChange(filters.map((filter, position) => (position === index ? { ...filter, operator: next } : filter)));
    };

    const changePath = (event: ChangeEvent<HTMLInputElement>): void => {
        const index = Number(event.currentTarget.dataset.index);
        const next = event.currentTarget.value;

        // Only the path was edited: the value box was not touched, so a pinned literal
        // (a facet click on the text "123") must survive rather than be re-coerced.
        onFiltersChange(filters.map((filter, position) => (position === index ? { ...filter, path: next, pathSegments: undefined } : filter)));
    };

    const changeValue = (event: ChangeEvent<HTMLInputElement>): void => {
        const index = Number(event.currentTarget.dataset.index);
        const next = event.currentTarget.value;

        onFiltersChange(filters.map((filter, position) => (position === index ? typedFilter(filter, { value: next }) : filter)));
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
                        {[...OPERATORS, { label: t("has"), value: "has" as const }].map((operator) => (
                            <option key={operator.value} value={operator.value}>
                                {operator.label}
                            </option>
                        ))}
                    </select>
                    <input
                        aria-label={t("Nested field path")}
                        data-index={index}
                        data-testid="db-filter-path"
                        onChange={changePath}
                        placeholder={t("nested path, e.g. geo.city")}
                        value={filter.path ?? ""}
                    />
                    <input
                        aria-label="Filter value"
                        data-index={index}
                        data-testid="db-filter-value"
                        onChange={changeValue}
                        placeholder={filter.operator === "has" ? t('value ("10" in quotes matches text)') : "value"}
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
