import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { SqlConsoleResult } from "../src/admin";
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

    const oneRowResult = (): SqlConsoleResult => {
        return { columns: ["name"], rowCount: 1, rows: [{ name: "messages" }], truncated: false };
    };
    const editorValue = (): string => screen.getByTestId<HTMLTextAreaElement>("sql-input").value;

    it("records a successfully-run query in the history and loads it back", async () => {
        expect.assertions(3);

        const mock = createMockClient({ query: oneRowResult });

        render(renderPanel(mock));

        // The editor starts on the first template; run it.
        fireEvent.click(screen.getByTestId("sql-run"));

        const historyList = await screen.findByTestId("sql-history");
        const items = within(historyList).getAllByTestId("sql-history-item");

        expect(items).toHaveLength(1);

        // Type a new draft, then load the past run back via its history entry.
        fireEvent.change(screen.getByTestId("sql-input"), { target: { value: "SELECT 1" } });

        expect(editorValue()).toBe("SELECT 1");

        fireEvent.click(items[0] as HTMLElement);

        expect(editorValue()).toContain("sqlite_master");
    });

    it("does not double-record identical consecutive runs", async () => {
        expect.assertions(1);

        const mock = createMockClient({ query: oneRowResult });

        render(renderPanel(mock));

        // Run the same (unchanged) draft twice.
        fireEvent.click(screen.getByTestId("sql-run"));
        await screen.findByTestId("sql-history");
        fireEvent.click(screen.getByTestId("sql-run"));
        await screen.findByTestId("sql-rows");

        expect(within(screen.getByTestId("sql-history")).getAllByTestId("sql-history-item")).toHaveLength(1);
    });

    it("clears the history", async () => {
        expect.assertions(2);

        const mock = createMockClient({ query: oneRowResult });

        render(renderPanel(mock));

        fireEvent.click(screen.getByTestId("sql-run"));
        await screen.findByTestId("sql-history");

        fireEvent.click(screen.getByTestId("sql-history-clear"));

        expect(screen.queryByTestId("sql-history")).toBeNull();
        expect(localStorage.getItem("cirrus-studio-sql-history")).toBe("[]");
    });

    it("formats the current draft in place", () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: (): SqlConsoleResult => {
                return { columns: [], rowCount: 0, rows: [], truncated: false };
            },
        });

        render(renderPanel(mock));

        fireEvent.change(screen.getByTestId("sql-input"), { target: { value: "select a from t where b = 1" } });
        fireEvent.click(screen.getByTestId("sql-format"));

        expect(editorValue()).toBe("SELECT a\nFROM t\nWHERE b = 1");
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
