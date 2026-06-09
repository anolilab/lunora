import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ADMIN_FUNCTIONS } from "../src/admin";
import { SqlEditorPanel } from "../src/sql-editor-panel";
import type { MockClientHooks } from "./mock-client";
import { createMockClient } from "./mock-client";

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <CirrusProvider client={mock.asClient}>
        <SqlEditorPanel />
    </CirrusProvider>
);

describe("sqlEditorPanel", () => {
    afterEach(() => {
        localStorage.clear();
    });

    it("runs a query and renders the result rows + count", async () => {
        expect.assertions(2);

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.runSql) {
                    return { columns: ["name"], rowCount: 2, rows: [{ name: "messages" }, { name: "users" }], truncated: false };
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        render(renderPanel(mock));

        fireEvent.click(screen.getByTestId("sql-run"));

        const rows = await screen.findByTestId("sql-rows");

        expect(rows.textContent).toContain("messages");
        expect(screen.getByTestId("sql-count").textContent).toContain("2 rows");
    });

    it("surfaces a server rejection (e.g. a write) inline", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: () => {
                throw new Error("the SQL editor is read-only — only SELECT / WITH / EXPLAIN queries are allowed");
            },
        });

        render(renderPanel(mock));

        fireEvent.click(screen.getByTestId("sql-run"));

        const error = await screen.findByTestId("sql-error");

        expect(error.textContent).toContain("read-only");
    });

    it("creates a saved query in the PRIVATE list from New query", async () => {
        expect.assertions(2);

        const mock = createMockClient({
            query: () => {
                return { columns: [], rowCount: 0, rows: [], truncated: false };
            },
        });

        render(renderPanel(mock));

        // Empty to start, then New query adds an entry to the PRIVATE list.
        expect(screen.getByTestId("sql-private-empty")).toBeDefined();

        fireEvent.click(screen.getByTestId("sql-new"));

        const list = await screen.findByTestId("sql-private");

        expect(list.textContent).toContain("Untitled query");
    });

    it("charts a numeric result and exposes an export menu", async () => {
        expect.assertions(3);

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.runSql) {
                    return {
                        columns: ["author", "count"],
                        rowCount: 2,
                        rows: [
                            { author: "ada", count: 5 },
                            { author: "grace", count: 3 },
                        ],
                        truncated: false,
                    };
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        render(renderPanel(mock));

        fireEvent.click(screen.getByTestId("sql-run"));
        await screen.findByTestId("sql-rows");

        // A result with a numeric column surfaces the Export menu.
        expect(screen.getByTestId("grid-export")).toBeDefined();

        // The Chart tab plots one bar per row (numeric `count` against `author`).
        fireEvent.click(screen.getByTestId("sql-tab-chart"));

        const chart = await screen.findByTestId("sql-chart");

        expect(within(chart).getAllByTestId("sql-chart-bar")).toHaveLength(2);
        expect(chart.textContent).toContain("ada");
    });
});
