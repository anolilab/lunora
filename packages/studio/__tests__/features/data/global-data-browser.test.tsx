import type { GlobalTablePage } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { GlobalDataBrowser } from "../../../src/features/data/global-data-browser";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const TABLES = [
    { name: "organizations", rowCount: 2 },
    { name: "plans", rowCount: 5 },
];

const ORG_ROWS = [
    { _creationTime: 1, _id: "o1", name: "Acme" },
    { _creationTime: 2, _id: "o2", name: "Globex" },
];

const createBrowserClient = (): MockClientHooks =>
    createMockClient({
        facetGlobalColumn: (options) => {
            if (options.column !== "name") {
                return { truncated: false, values: [] };
            }

            return {
                truncated: false,
                values: [
                    { count: 1, value: "Acme" },
                    { count: 1, value: "Globex" },
                ],
            };
        },
        listGlobalTables: () => TABLES,
        readGlobalTablePage: (options): GlobalTablePage => {
            if (options.table !== "organizations") {
                throw new Error(`unknown global table: ${options.table}`);
            }

            const offset = options.offset ?? 0;
            const limit = options.limit ?? 50;
            const filter = options.filters?.find((clause) => clause.column === "name");
            const rows = filter === undefined ? ORG_ROWS : ORG_ROWS.filter((row) => row.name === filter.value);

            return { columns: ["_id", "_creationTime", "name"], rows: rows.slice(offset, offset + limit), total: rows.length };
        },
    });

const renderBrowser = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <GlobalDataBrowser />
    </LunoraProvider>
);

describe("globalDataBrowser", () => {
    it("lists global tables with row counts on mount", async () => {
        expect.assertions(2);

        render(renderBrowser(createBrowserClient()));

        // The sidebar renders the table name and its row-count badge separately.
        // (findBy: the list only populates once the async `listGlobalTables` resolves.)
        const organizationsRow = await screen.findByTestId("gdb-table-organizations");

        expect(organizationsRow.textContent).toBe("organizations2");
        expect(screen.getByTestId("gdb-table-plans").textContent).toBe("plans5");
    });

    it("pages through a selected table's rows", async () => {
        expect.assertions(2);

        render(renderBrowser(createBrowserClient()));

        fireEvent.click(await screen.findByTestId("gdb-table-organizations"));

        await screen.findByTestId("gdb-page");

        expect(screen.getAllByTestId("gdb-row")).toHaveLength(2);
        expect(screen.getByTestId("gdb-page-info").textContent).toBe("1-2 of 2");
    });

    it("facets a column, then drills the page down on a value click", async () => {
        expect.hasAssertions();

        const mock = createBrowserClient();

        render(renderBrowser(mock));

        fireEvent.click(await screen.findByTestId("gdb-table-organizations"));

        await screen.findByTestId("gdb-page");

        // Toggle the `name` facet on; its distinct values load over the active view.
        fireEvent.click(screen.getByTestId("db-facet-toggle-name"));

        const values = await screen.findAllByTestId("db-facet-value-name");

        expect(values).toHaveLength(2);

        // Click the "Acme" facet value — it becomes an eq drill-down filter.
        fireEvent.click(values[0] as HTMLElement);

        const chip = await screen.findByTestId("gdb-filter-chip");

        expect(chip.textContent).toContain("name");
        expect(chip.textContent).toContain("Acme");

        // The grid narrows to the matching row (the re-read is async), and the read
        // carried the eq clause.
        await waitFor(() => {
            expect(screen.getAllByTestId("gdb-row")).toHaveLength(1);
        });

        expect(mock.facetGlobalColumn).toHaveBeenCalledWith(expect.objectContaining({ column: "name", table: "organizations" }));
        expect(mock.readGlobalTablePage).toHaveBeenCalledWith(
            expect.objectContaining({ filters: [{ column: "name", value: "Acme" }], table: "organizations" }),
        );
    });

    it("removes a drill-down filter via its chip ✕", async () => {
        expect.hasAssertions();

        render(renderBrowser(createBrowserClient()));

        fireEvent.click(await screen.findByTestId("gdb-table-organizations"));
        await screen.findByTestId("gdb-page");

        fireEvent.click(screen.getByTestId("db-facet-toggle-name"));
        const values = await screen.findAllByTestId("db-facet-value-name");
        fireEvent.click(values[0] as HTMLElement);

        await screen.findByTestId("gdb-filter-chip");

        // Clearing the chip restores the full page (the re-read is async).
        fireEvent.click(screen.getByTestId("gdb-filter-remove"));

        await waitFor(() => {
            expect(screen.getAllByTestId("gdb-row")).toHaveLength(2);
        });

        expect(screen.queryByTestId("gdb-filter-chip")).toBeNull();
    });

    it("shows an empty state when there are no global tables", async () => {
        expect.assertions(1);

        render(renderBrowser(createMockClient({ listGlobalTables: () => [] })));

        const empty = await screen.findByTestId("gdb-empty");

        expect(empty).toBeDefined();
    });

    it("surfaces a table-listing error", async () => {
        expect.assertions(1);

        const mock = createMockClient();

        mock.listGlobalTables.mockRejectedValueOnce(new Error("GLOBALS_NOT_CONFIGURED"));

        render(renderBrowser(mock));

        const error = await screen.findByTestId("gdb-tables-error");

        expect(error.textContent).toBe("GLOBALS_NOT_CONFIGURED");
    });
});
