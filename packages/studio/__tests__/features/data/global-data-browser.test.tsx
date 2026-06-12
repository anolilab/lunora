import type { GlobalTablePage } from "@cirrus/client";
import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen } from "@testing-library/react";
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
        listGlobalTables: () => TABLES,
        readGlobalTablePage: (options): GlobalTablePage => {
            if (options.table !== "organizations") {
                throw new Error(`unknown global table: ${options.table}`);
            }

            const offset = options.offset ?? 0;
            const limit = options.limit ?? 50;

            return { columns: ["_id", "_creationTime", "name"], rows: ORG_ROWS.slice(offset, offset + limit), total: ORG_ROWS.length };
        },
    });

const renderBrowser = (mock: MockClientHooks): ReactElement => (
    <CirrusProvider client={mock.asClient}>
        <GlobalDataBrowser />
    </CirrusProvider>
);

describe("globalDataBrowser", () => {
    it("lists global tables with row counts on mount", async () => {
        expect.assertions(2);

        render(renderBrowser(createBrowserClient()));

        await screen.findByTestId("gdb-table-list");

        // The sidebar renders the table name and its row-count badge separately.
        expect(screen.getByTestId("gdb-table-organizations").textContent).toBe("organizations2");
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
