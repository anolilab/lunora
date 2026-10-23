import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { EditableFilter } from "../../../src/features/data/data-filters";
import { DataFilters, toFilterClauses } from "../../../src/features/data/data-filters";

// Hoisted to module scope so they're stable identities across renders (react-perf).
const COLUMNS: ReadonlyArray<string> = ["__id__", "status", "age"];
const NO_FILTERS: ReadonlyArray<EditableFilter> = [];
const STATUS_FILTER: ReadonlyArray<EditableFilter> = [{ column: "status", operator: "eq", value: "active" }];

/** A typed no-op mock handler, satisfying the mock-type-parameter lint. */
const noop = (): ((...args: unknown[]) => void) => vi.fn<(...args: unknown[]) => void>();

describe("toFilterClauses", () => {
    it('drops clauses with no value to test against, but keeps an `eq ""` / `ne ""`', () => {
        expect.assertions(1);

        // An empty `contains` matches every row, and an empty range bound compares a
        // column against "" — neither narrows anything the operator meant to narrow.
        // An empty `eq` / `ne` is a real test (the column is, or is not, the empty
        // string), and `eq ""` is what a freshly added row starts as.
        const filters: EditableFilter[] = [
            { column: "status", operator: "contains", value: "" },
            { column: "age", operator: "gt", value: "" },
            { column: "age", operator: "lte", value: "  " },
            { column: "status", operator: "eq", value: "" },
            { column: "status", operator: "ne", value: "" },
            { column: "status", operator: "contains", value: " " },
        ];

        expect(toFilterClauses(filters)).toStrictEqual([
            { column: "status", operator: "eq", value: "" },
            { column: "status", operator: "ne", value: "" },
            { column: "status", operator: "contains", value: " " },
        ]);
    });

    it("drops rows with no column", () => {
        expect.assertions(1);

        const filters: EditableFilter[] = [
            { column: "", operator: "eq", value: "x" },
            { column: "status", operator: "eq", value: "active" },
        ];

        expect(toFilterClauses(filters)).toStrictEqual([{ column: "status", operator: "eq", value: "active" }]);
    });

    // A facet's own value, not a value re-derived from the text shown in the
    // box. The sidebar summarised a TEXT column as `12345 (2)`; coercing its
    // display text back sent the NUMBER 12345, which the server compares
    // against `json_extract(__doc__, ...)` — no type affinity, so `12345 =
    // '12345'` is false and the click produced an empty grid under a count of 2.
    it("sends a pinned literal verbatim instead of re-coercing its text", () => {
        expect.assertions(2);

        expect(toFilterClauses([{ column: "zip", literal: ["12345"], operator: "eq", value: "12345" }])).toStrictEqual([
            { column: "zip", operator: "eq", value: "12345" },
        ]);

        // The NULL group flattened to the empty string, which matches nothing.
        expect(toFilterClauses([{ column: "status", literal: [null], operator: "eq", value: "" }])).toStrictEqual([
            { column: "status", operator: "eq", value: null },
        ]);
    });

    it("coerces again once the operator edits the value", () => {
        expect.assertions(1);

        const onFiltersChange = noop();
        const pinned: ReadonlyArray<EditableFilter> = [{ column: "age", literal: ["18"], operator: "gt", value: "18" }];

        render(<DataFilters columns={COLUMNS} filters={pinned} onFiltersChange={onFiltersChange} onSearchChange={noop()} search="" />);

        fireEvent.change(within(screen.getByTestId("db-filter-row")).getByTestId("db-filter-value"), { target: { value: "21" } });

        // No `literal` survives the edit: from here the text IS the value, so
        // `age > 21` has to compare numerically again.
        expect(onFiltersChange).toHaveBeenLastCalledWith([{ column: "age", operator: "gt", value: "21" }]);
    });

    it("coerces a numeric string to a number for comparison operators", () => {
        expect.assertions(1);

        expect(toFilterClauses([{ column: "age", operator: "gt", value: "18" }])).toStrictEqual([{ column: "age", operator: "gt", value: 18 }]);
    });

    it("keeps the value a string for `contains`, even when numeric", () => {
        expect.assertions(1);

        expect(toFilterClauses([{ column: "code", operator: "contains", value: "100" }])).toStrictEqual([
            { column: "code", operator: "contains", value: "100" },
        ]);
    });

    it("coerces a canonical numeric string to a number for `eq`, so numeric columns match", () => {
        expect.assertions(1);

        expect(toFilterClauses([{ column: "age", operator: "eq", value: "42" }])).toStrictEqual([{ column: "age", operator: "eq", value: 42 }]);
    });

    it("keeps a leading-zero code (e.g. a zip) a string for `eq`, so a TEXT column still matches", () => {
        expect.assertions(1);

        // `Number("00123")` is 123, which would never match the stored TEXT "00123"
        // once bound against the affinity-less `json_extract` expression server-side.
        expect(toFilterClauses([{ column: "zip", operator: "eq", value: "00123" }])).toStrictEqual([{ column: "zip", operator: "eq", value: "00123" }]);
    });

    it("does not coerce surprising numeric forms (hex, exponent shorthand, Infinity) for `ne`", () => {
        expect.assertions(1);

        expect(
            toFilterClauses([
                { column: "a", operator: "ne", value: "0x10" },
                { column: "b", operator: "ne", value: "1e3" },
                { column: "c", operator: "ne", value: "Infinity" },
            ]),
        ).toStrictEqual([
            { column: "a", operator: "ne", value: "0x10" },
            { column: "b", operator: "ne", value: "1e3" },
            { column: "c", operator: "ne", value: "Infinity" },
        ]);
    });
});

describe("toFilterClauses — nested paths and array membership", () => {
    it("splits a typed nested path, omits the path for a blank box, coerces has values, and drops a blank has row", () => {
        expect.assertions(1);

        expect(
            toFilterClauses([
                { column: "address", operator: "eq", path: "geo.city", value: "Berlin" },
                { column: "address", operator: "eq", path: "  ", value: "Berlin" },
                { column: "tags", operator: "has", value: "10" },
                { column: "tags", operator: "has", value: "" },
            ]),
        ).toStrictEqual([
            { column: "address", operator: "eq", path: ["geo", "city"], value: "Berlin" },
            { column: "address", operator: "eq", value: "Berlin" },
            { column: "tags", operator: "has", value: 10 },
        ]);
    });
});

describe("toFilterClauses — typed booleans", () => {
    it("sends has true and has false as JSON booleans, so they match a boolean element", () => {
        expect.assertions(1);

        expect(
            toFilterClauses([
                { column: "flags", operator: "has", value: "true" },
                { column: "flags", operator: "has", value: " false " },
            ]),
        ).toStrictEqual([
            { column: "flags", operator: "has", value: true },
            { column: "flags", operator: "has", value: false },
        ]);
    });

    it("leaves an eq on the text true as text, so the boolean fix does not change equality", () => {
        expect.assertions(1);

        expect(toFilterClauses([{ column: "flag", operator: "eq", value: "true" }])).toStrictEqual([{ column: "flag", operator: "eq", value: "true" }]);
    });
});

describe("dataFilters — nested path and has", () => {
    it("offers has and reports an edited path on the row it belongs to", () => {
        expect.assertions(3);

        const onFiltersChange = noop();

        render(
            <DataFilters
                columns={COLUMNS}
                filters={[{ column: "address", operator: "eq", path: "", value: "Berlin" }]}
                onFiltersChange={onFiltersChange}
                onSearchChange={noop()}
                search=""
            />,
        );

        const row = screen.getByTestId("db-filter-row");

        expect(within(row).getByRole("option", { name: "has" }).textContent).toBe("has");

        fireEvent.change(within(row).getByTestId("db-filter-path"), { target: { value: "city" } });

        expect(onFiltersChange).toHaveBeenLastCalledWith([{ column: "address", operator: "eq", path: "city", value: "Berlin" }]);

        fireEvent.change(within(row).getByTestId("db-filter-operator"), { target: { value: "has" } });

        expect(onFiltersChange).toHaveBeenLastCalledWith([{ column: "address", operator: "has", path: "", value: "Berlin" }]);
    });

    it("keeps a row's path when the value is edited", () => {
        expect.assertions(1);

        const onFiltersChange = noop();

        render(
            <DataFilters
                columns={COLUMNS}
                filters={[{ column: "address", operator: "eq", path: "city", value: "Berlin" }]}
                onFiltersChange={onFiltersChange}
                onSearchChange={noop()}
                search=""
            />,
        );

        fireEvent.change(within(screen.getByTestId("db-filter-row")).getByTestId("db-filter-value"), { target: { value: "Paris" } });

        expect(onFiltersChange).toHaveBeenLastCalledWith([{ column: "address", operator: "eq", path: "city", value: "Paris" }]);
    });
});

describe("dataFilters", () => {
    it("renders the search box and forwards changes", () => {
        expect.assertions(1);

        const onSearchChange = noop();

        render(<DataFilters columns={COLUMNS} filters={NO_FILTERS} onFiltersChange={noop()} onSearchChange={onSearchChange} search="" />);

        fireEvent.change(screen.getByTestId("db-filter"), { target: { value: "hello" } });

        expect(onSearchChange).toHaveBeenCalledTimes(1);
    });

    it("appends a default clause on Add filter, seeded with the first column", () => {
        expect.assertions(1);

        const onFiltersChange = noop();

        render(<DataFilters columns={COLUMNS} filters={NO_FILTERS} onFiltersChange={onFiltersChange} onSearchChange={noop()} search="" />);

        fireEvent.click(screen.getByTestId("db-add-filter"));

        expect(onFiltersChange).toHaveBeenCalledWith([{ column: "__id__", operator: "eq", value: "" }]);
    });

    it("edits a clause's operator and value, and removes a row", () => {
        expect.assertions(3);

        const onFiltersChange = noop();

        render(<DataFilters columns={COLUMNS} filters={STATUS_FILTER} onFiltersChange={onFiltersChange} onSearchChange={noop()} search="" />);

        const row = screen.getByTestId("db-filter-row");

        fireEvent.change(within(row).getByTestId("db-filter-operator"), { target: { value: "ne" } });

        expect(onFiltersChange).toHaveBeenLastCalledWith([{ column: "status", operator: "ne", value: "active" }]);

        fireEvent.change(within(row).getByTestId("db-filter-value"), { target: { value: "banned" } });

        expect(onFiltersChange).toHaveBeenLastCalledWith([{ column: "status", operator: "eq", value: "banned" }]);

        fireEvent.click(within(row).getByTestId("db-filter-remove"));

        expect(onFiltersChange).toHaveBeenLastCalledWith([]);
    });
});
