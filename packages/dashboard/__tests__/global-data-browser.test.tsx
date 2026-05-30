import type { GlobalTablePage } from "@cirrus/client";
import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, test } from "vitest";

import { GlobalDataBrowser } from "../src/global-data-browser.js";
import { createMockClient, type MockClientHooks } from "./mock-client.js";

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
    test("lists global tables with row counts on mount", async () => {
        render(renderBrowser(createBrowserClient()));

        await waitFor(() => {
            expect(screen.getByTestId("gdb-table-list")).toBeDefined();
        });

        expect(screen.getByTestId("gdb-table-organizations").textContent).toBe("organizations (2)");
        expect(screen.getByTestId("gdb-table-plans").textContent).toBe("plans (5)");
    });

    test("pages through a selected table's rows", async () => {
        render(renderBrowser(createBrowserClient()));

        await waitFor(() => {
            expect(screen.getByTestId("gdb-table-organizations")).toBeDefined();
        });

        fireEvent.click(screen.getByTestId("gdb-table-organizations"));

        await waitFor(() => {
            expect(screen.getByTestId("gdb-page")).toBeDefined();
        });

        expect(screen.getAllByTestId("gdb-row")).toHaveLength(2);
        expect(screen.getByTestId("gdb-page-info").textContent).toBe("1-2 of 2");
    });

    test("shows an empty state when there are no global tables", async () => {
        render(renderBrowser(createMockClient({ listGlobalTables: () => [] })));

        await waitFor(() => {
            expect(screen.getByTestId("gdb-empty")).toBeDefined();
        });
    });

    test("surfaces a table-listing error", async () => {
        const mock = createMockClient();

        mock.listGlobalTables.mockRejectedValueOnce(new Error("GLOBALS_NOT_CONFIGURED"));

        render(renderBrowser(mock));

        await waitFor(() => {
            expect(screen.getByTestId("gdb-tables-error").textContent).toBe("GLOBALS_NOT_CONFIGURED");
        });
    });
});
