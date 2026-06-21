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
    it("drops rows with no column", () => {
        expect.assertions(1);

        const filters: EditableFilter[] = [
            { column: "", operator: "eq", value: "x" },
            { column: "status", operator: "eq", value: "active" },
        ];

        expect(toFilterClauses(filters)).toStrictEqual([{ column: "status", operator: "eq", value: "active" }]);
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
