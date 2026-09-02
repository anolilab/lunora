import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { SqlEditorPanel } from "../../../src/features/sql/sql-editor-panel";
import type { SqlConsoleResult } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <SqlEditorPanel />
    </LunoraProvider>
);

/** A mock that serves an empty SQL result plus a small schema for autocomplete. */
const schemaMock = (): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return [
                    { name: "messages", rowCount: 0 },
                    { name: "users", rowCount: 0 },
                ];
            }

            if (reference === ADMIN_FUNCTIONS.readTablePage) {
                return { columns: ["id", "author", "body"], rows: [], total: 0 };
            }

            return { columns: [], rowCount: 0, rows: [], truncated: false };
        },
    });

describe("sqlEditorPanel", () => {
    afterEach(() => {
        localStorage.clear();
        sessionStorage.clear();
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

    it("runs a script as separate gated calls and never sends a joined string", async () => {
        expect.assertions(4);

        const mock = createMockClient({ query: oneRowResult });

        render(renderPanel(mock));

        fireEvent.change(screen.getByTestId("sql-input"), { target: { value: "SELECT 1; SELECT 2; SELECT 3" } });
        fireEvent.click(screen.getByTestId("sql-run"));

        const strip = await screen.findByTestId("sql-statements");

        expect(within(strip).getAllByRole("button")).toHaveLength(3);

        const sent = mock.query.mock.calls.filter((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.runSql).map((call) => (call[1] as { sql: string }).sql);

        expect(sent).toStrictEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
        // The gate is the console's enforcement point; splitting happens above it
        // and a `;`-joined string must never reach the server.
        expect(sent.some((sql) => sql.includes(";"))).toBe(false);
        // The last statement is what the panes show.
        expect(screen.getByTestId("sql-statement-2").getAttribute("aria-pressed")).toBe("true");
    });

    it("does not double-prefix EXPLAIN onto a draft that already asks for a plan", async () => {
        expect.assertions(2);

        // The read-only gate ALLOWS a leading `EXPLAIN [QUERY PLAN]`, so wrapping
        // one again sends `EXPLAIN QUERY PLAN EXPLAIN QUERY PLAN …`, which SQLite
        // refuses with `near "EXPLAIN": syntax error` — while Run executes the
        // very same draft.
        const mock = createMockClient({ query: oneRowResult });

        render(renderPanel(mock));

        fireEvent.change(screen.getByTestId("sql-input"), { target: { value: "EXPLAIN QUERY PLAN SELECT 1" } });
        fireEvent.click(screen.getByTestId("sql-tab-explain"));

        await waitFor(() => {
            expect(mock.query.mock.calls.some((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.runSql)).toBe(true);
        });

        const sent = mock.query.mock.calls.filter((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.runSql).map((call) => (call[1] as { sql: string }).sql);

        expect(sent).toStrictEqual(["EXPLAIN QUERY PLAN SELECT 1"]);
    });

    it("reports a statement the gate refuses without sending it, and still runs the rest", async () => {
        expect.assertions(3);

        const mock = createMockClient({ query: oneRowResult });

        render(renderPanel(mock));

        fireEvent.change(screen.getByTestId("sql-input"), { target: { value: "SELECT 1; DELETE FROM messages; SELECT 2" } });
        fireEvent.click(screen.getByTestId("sql-run"));

        await screen.findByTestId("sql-statements");

        const sent = mock.query.mock.calls.filter((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.runSql).map((call) => (call[1] as { sql: string }).sql);

        // The refusal is local — the write never leaves the browser — and it does
        // not abort the statements after it.
        expect(sent).toStrictEqual(["SELECT 1", "SELECT 2"]);

        fireEvent.click(screen.getByTestId("sql-statement-1"));

        expect(screen.getByTestId("sql-error").textContent).toContain("read-only");
        expect(screen.queryByTestId("sql-rows")).toBeNull();
    });

    it("purges an on-disk history left by a build that always persisted it", async () => {
        expect.assertions(2);

        // The upgrade path. Before the toggle existed the history always lived in
        // localStorage; an operator who never opts in must not be shown an empty,
        // unchecked history while last week's statements sit on disk.
        localStorage.setItem("lunora-studio-sql-history", JSON.stringify([{ at: 1, sql: "SELECT * FROM users WHERE email = 'x@y.z'" }]));

        render(renderPanel(createMockClient({ query: oneRowResult })));

        await waitFor(() => {
            expect(localStorage.getItem("lunora-studio-sql-history")).toBeNull();
        });

        expect(screen.queryByTestId("sql-history")).toBeNull();
    });

    it("clears the history", async () => {
        expect.assertions(3);

        const mock = createMockClient({ query: oneRowResult });

        render(renderPanel(mock));

        fireEvent.click(screen.getByTestId("sql-run"));
        await screen.findByTestId("sql-history");

        fireEvent.click(screen.getByTestId("sql-history-clear"));

        expect(screen.queryByTestId("sql-history")).toBeNull();
        // Both areas: clearing has to reach the on-disk copy even when the history
        // is currently session-scoped, or "Clear history" leaves the statements it
        // claims to have removed sitting in `localStorage`.
        expect(localStorage.getItem("lunora-studio-sql-history") ?? "").not.toContain("sqlite_master");
        expect(sessionStorage.getItem("lunora-studio-sql-history") ?? "").not.toContain("sqlite_master");
    });

    it("keeps the run history to the tab unless asked to remember it", async () => {
        expect.assertions(3);

        render(renderPanel(createMockClient({ query: oneRowResult })));

        fireEvent.click(screen.getByTestId("sql-run"));
        await screen.findByTestId("sql-history");

        // The default. A statement that happened to succeed is not something an
        // operator asked to keep, and before this every one of them outlived the
        // browser on whatever origin the studio was opened from.
        expect(localStorage.getItem("lunora-studio-sql-history")).toBeNull();
        expect(sessionStorage.getItem("lunora-studio-sql-history")).toContain("sqlite_master");

        fireEvent.click(screen.getByTestId("sql-history-remember"));

        await waitFor(() => {
            expect(localStorage.getItem("lunora-studio-sql-history")).toContain("sqlite_master");
        });
    });

    it("deletes the on-disk history when remembering is turned back off", async () => {
        expect.hasAssertions();

        render(renderPanel(createMockClient({ query: oneRowResult })));

        fireEvent.click(screen.getByTestId("sql-run"));
        await screen.findByTestId("sql-history");

        fireEvent.click(screen.getByTestId("sql-history-remember"));

        await waitFor(() => {
            expect(localStorage.getItem("lunora-studio-sql-history")).toContain("sqlite_master");
        });

        fireEvent.click(screen.getByTestId("sql-history-remember"));

        // A toggle that hid the history but left it on disk would be a setting
        // that lies about what it does.
        await waitFor(() => {
            expect(localStorage.getItem("lunora-studio-sql-history")).toBeNull();
        });
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

        // The Chart tab plots the numeric column (evilcharts/Recharts). Recharts
        // renders into a measured container (0-size under jsdom), so assert the
        // chart mounted (not the empty-state) rather than its bars/labels.
        fireEvent.click(screen.getByTestId("sql-tab-chart"));

        const chart = await screen.findByTestId("sql-chart");

        expect(chart).toBeDefined();
        expect(screen.queryByTestId("sql-chart-empty")).toBeNull();
    });

    const typeInEditor = (value: string): void => {
        const input = screen.getByTestId<HTMLTextAreaElement>("sql-input");

        input.focus();
        fireEvent.change(input, { target: { value } });
        input.setSelectionRange(value.length, value.length);
        fireEvent.select(input);
    };

    /** Resolve once the panel's `listTables` schema load has fired. */
    const waitForSchema = async (mock: MockClientHooks): Promise<void> => {
        await waitFor(() => {
            if (!mock.query.mock.calls.some((call) => call[0]?.__lunoraRef === ADMIN_FUNCTIONS.listTables)) {
                throw new Error("schema not loaded yet");
            }
        });
    };

    it("suggests a schema table name as the user types after FROM", async () => {
        expect.assertions(1);

        const mock = schemaMock();

        render(renderPanel(mock));

        // Wait for the table list to load before the prefix can resolve to a table.
        await waitForSchema(mock);

        typeInEditor("SELECT * FROM mess");

        const popover = await screen.findByTestId("sql-autocomplete");

        expect(within(popover).getAllByTestId("sql-autocomplete-item")[0]?.textContent).toContain("messages");
    });

    it("inserts the suggestion the operator CLICKED, not the highlighted one", async () => {
        expect.assertions(2);

        const mock = schemaMock();

        render(renderPanel(mock));

        await waitForSchema(mock);

        // A qualifier offering several columns, so the clicked row is not the
        // highlighted one — the case where committing through a scheduled `move` reads
        // the stale index and silently inserts the wrong suggestion.
        typeInEditor("SELECT messages.");

        const popover = await screen.findByTestId("sql-autocomplete");
        const items = within(popover).getAllByTestId("sql-autocomplete-item");
        const clicked = items.find((item) => item.textContent?.includes("body"));

        expect(items.indexOf(clicked as HTMLElement)).toBeGreaterThan(0);

        fireEvent.mouseDown(clicked as HTMLElement);

        const input = screen.getByTestId<HTMLTextAreaElement>("sql-input");

        await waitFor(() => {
            if (input.value === "SELECT messages.") {
                throw new Error(`not yet: ${input.value}`);
            }
        });

        expect(input.value).toBe("SELECT messages.body");
    });

    it("completes a column behind a `tbl.` qualifier into the editor", async () => {
        expect.assertions(1);

        const mock = schemaMock();

        render(renderPanel(mock));

        await waitForSchema(mock);

        // Typing a table reference pre-probes its columns; a `tbl.` qualifier then
        // offers them, and Enter accepts the highlighted one into the editor.
        typeInEditor("SELECT messages.au");

        await screen.findByTestId("sql-autocomplete");

        const input = screen.getByTestId<HTMLTextAreaElement>("sql-input");

        fireEvent.keyDown(input, { key: "Enter" });

        await waitFor(() => {
            if (input.value !== "SELECT messages.author") {
                throw new Error(`not yet: ${input.value}`);
            }
        });

        expect(input.value).toBe("SELECT messages.author");
    });

    it("opens a new editor tab and switches between tabs", () => {
        expect.assertions(3);

        render(renderPanel(schemaMock()));

        // One tab to start.
        expect(within(screen.getByTestId("sql-tab-strip")).getAllByTestId(/^sql-tab-select-/u)).toHaveLength(1);

        fireEvent.click(screen.getByTestId("sql-tab-add"));

        const tabs = within(screen.getByTestId("sql-tab-strip")).getAllByTestId(/^sql-tab-select-/u);

        expect(tabs).toHaveLength(2);

        // Each tab carries its own draft: type into the new (active) tab, switch
        // back to the first, and the editor shows the first tab's text again.
        const first = within(screen.getByTestId("sql-tab-strip")).getAllByTestId(/^sql-tab-select-/u)[0] as HTMLElement;

        fireEvent.change(screen.getByTestId("sql-input"), { target: { value: "SELECT 2" } });
        fireEvent.click(first);

        expect(screen.getByTestId<HTMLTextAreaElement>("sql-input").value).toContain("sqlite_master");
    });

    it("closes a tab and persists open tabs across a remount", () => {
        expect.assertions(2);

        const { unmount } = render(renderPanel(schemaMock()));

        fireEvent.click(screen.getByTestId("sql-tab-add"));
        fireEvent.change(screen.getByTestId("sql-input"), { target: { value: "SELECT persisted" } });

        // Two tabs now; close the first, leaving the typed one. The seed tab holds
        // unsaved template SQL, so confirm the discard prompt to actually close it.
        const firstSelect = within(screen.getByTestId("sql-tab-strip")).getAllByTestId(/^sql-tab-select-/u)[0] as HTMLElement;
        const firstId = firstSelect.dataset.testid?.replace("sql-tab-select-", "") ?? "";

        fireEvent.click(screen.getByTestId(`sql-tab-close-${firstId}`));
        fireEvent.click(screen.getByTestId(`sql-tab-close-confirm-${firstId}`));

        expect(within(screen.getByTestId("sql-tab-strip")).getAllByTestId(/^sql-tab-select-/u)).toHaveLength(1);

        // Remount: the persisted tab (and its draft) is restored from storage.
        unmount();
        render(renderPanel(schemaMock()));

        expect(screen.getByTestId<HTMLTextAreaElement>("sql-input").value).toBe("SELECT persisted");
    });

    it("renames a tab in place on double-click and persists the title", () => {
        expect.assertions(3);

        const { unmount } = render(renderPanel(schemaMock()));

        const select = within(screen.getByTestId("sql-tab-strip")).getAllByTestId(/^sql-tab-select-/u)[0] as HTMLElement;
        const id = select.dataset.testid?.replace("sql-tab-select-", "") ?? "";

        // Double-click swaps the label for an input; type a title and commit with Enter.
        fireEvent.doubleClick(select);

        const input = screen.getByTestId<HTMLInputElement>(`sql-tab-rename-${id}`);

        fireEvent.change(input, { target: { value: "My report" } });
        fireEvent.keyDown(input, { key: "Enter" });

        expect(screen.getByTestId(`sql-tab-select-${id}`).textContent).toBe("My report");

        // The custom title survives a remount (it's persisted on the tab).
        unmount();
        render(renderPanel(schemaMock()));

        const restored = within(screen.getByTestId("sql-tab-strip")).getAllByTestId(/^sql-tab-select-/u)[0] as HTMLElement;

        expect(restored.textContent).toBe("My report");

        // Clearing the title reverts the tab to its draft-derived label.
        fireEvent.doubleClick(restored);
        const reedit = screen.getByTestId<HTMLInputElement>(restored.dataset.testid?.replace("select", "rename") ?? "");

        fireEvent.change(reedit, { target: { value: "" } });
        fireEvent.keyDown(reedit, { key: "Enter" });

        // Back to the draft-derived label (the first line of the seed query, truncated).
        expect(screen.getByTestId(restored.dataset.testid ?? "").textContent).toContain("SELECT name FROM");
    });

    it("confirms before closing a tab with unsaved changes, and cancel keeps it", () => {
        expect.assertions(4);

        render(renderPanel(schemaMock()));

        // Add a second (empty) tab and type an unlinked draft into it — unsaved work.
        fireEvent.click(screen.getByTestId("sql-tab-add"));
        fireEvent.change(screen.getByTestId("sql-input"), { target: { value: "SELECT unsaved" } });

        const selects = within(screen.getByTestId("sql-tab-strip")).getAllByTestId(/^sql-tab-select-/u);
        const secondId = (selects[1] as HTMLElement).dataset.testid?.replace("sql-tab-select-", "") ?? "";

        // Clicking close on the dirty tab does NOT close it — it shows a discard prompt.
        fireEvent.click(screen.getByTestId(`sql-tab-close-${secondId}`));

        expect(screen.getByTestId(`sql-tab-close-prompt-${secondId}`)).toBeDefined();
        expect(within(screen.getByTestId("sql-tab-strip")).getAllByTestId(/^sql-tab-select-/u)).toHaveLength(2);

        // Cancel keeps the tab and restores the close button.
        fireEvent.click(screen.getByTestId(`sql-tab-close-cancel-${secondId}`));

        expect(within(screen.getByTestId("sql-tab-strip")).getAllByTestId(/^sql-tab-select-/u)).toHaveLength(2);

        // Re-open the prompt and confirm — now it closes.
        fireEvent.click(screen.getByTestId(`sql-tab-close-${secondId}`));
        fireEvent.click(screen.getByTestId(`sql-tab-close-confirm-${secondId}`));

        expect(within(screen.getByTestId("sql-tab-strip")).getAllByTestId(/^sql-tab-select-/u)).toHaveLength(1);
    });

    it("right-click opens a tab menu that closes the other tabs", () => {
        expect.assertions(3);

        render(renderPanel(schemaMock()));

        // Open two more tabs (three total).
        fireEvent.click(screen.getByTestId("sql-tab-add"));
        fireEvent.click(screen.getByTestId("sql-tab-add"));

        const selects = within(screen.getByTestId("sql-tab-strip")).getAllByTestId(/^sql-tab-select-/u);

        expect(selects).toHaveLength(3);

        // Right-click the first tab → context menu appears.
        const firstId = (selects[0] as HTMLElement).dataset.testid?.replace("sql-tab-select-", "") ?? "";

        fireEvent.contextMenu(screen.getByTestId(`sql-tab-${firstId}`));

        expect(screen.getByTestId("sql-tab-menu")).toBeDefined();

        // "Close other tabs" leaves only the right-clicked one.
        fireEvent.click(screen.getByTestId("sql-tab-menu-close-others"));

        expect(within(screen.getByTestId("sql-tab-strip")).getAllByTestId(/^sql-tab-select-/u)).toHaveLength(1);
    });

    it("confirms a bulk close that would discard an unsaved tab", () => {
        expect.assertions(3);

        render(renderPanel(schemaMock()));

        // Add a second tab and type an unlinked draft into it (unsaved work).
        fireEvent.click(screen.getByTestId("sql-tab-add"));
        fireEvent.change(screen.getByTestId("sql-input"), { target: { value: "SELECT unsaved" } });

        const selects = within(screen.getByTestId("sql-tab-strip")).getAllByTestId(/^sql-tab-select-/u);
        const firstId = (selects[0] as HTMLElement).dataset.testid?.replace("sql-tab-select-", "") ?? "";

        // Right-click the first tab and "close others" — that would drop the dirty second tab,
        // so it asks to confirm instead of closing.
        fireEvent.contextMenu(screen.getByTestId(`sql-tab-${firstId}`));
        fireEvent.click(screen.getByTestId("sql-tab-menu-close-others"));

        expect(screen.getByTestId("sql-tab-menu-confirm")).toBeDefined();
        expect(within(screen.getByTestId("sql-tab-strip")).getAllByTestId(/^sql-tab-select-/u)).toHaveLength(2);

        // Discarding goes through with the close.
        fireEvent.click(screen.getByTestId("sql-tab-menu-confirm-discard"));

        expect(within(screen.getByTestId("sql-tab-strip")).getAllByTestId(/^sql-tab-select-/u)).toHaveLength(1);
    });

    it("keeps `running` scoped per tab: a slow query in one tab never disables/spins another tab's Run button (STUDIO-11)", async () => {
        expect.assertions(4);

        let resolveSlow: ((value: SqlConsoleResult) => void) | undefined;

        const mock = createMockClient({
            query: (reference, args): unknown => {
                if (reference !== ADMIN_FUNCTIONS.runSql) {
                    return { columns: [], rowCount: 0, rows: [], truncated: false };
                }

                const { sql } = args as { sql: string };

                // Tab A's query never resolves on its own — held open until the test
                // calls `resolveSlow` explicitly, so it can assert on the state while
                // it's still in flight.
                if (sql.includes("SLOW")) {
                    return new Promise<SqlConsoleResult>((resolve) => {
                        resolveSlow = resolve;
                    });
                }

                return { columns: ["name"], rowCount: 1, rows: [{ name: "fast" }], truncated: false };
            },
        });

        render(renderPanel(mock));

        // Tab A: start the slow query.
        typeInEditor("SELECT 'SLOW'");
        fireEvent.click(screen.getByTestId("sql-run"));

        await waitFor(() => {
            if (!screen.getByTestId<HTMLButtonElement>("sql-run").disabled) {
                throw new Error("tab A hasn't started running yet");
            }
        });

        // Open a second tab — it becomes active. Tab A stays first in the strip
        // (`addTab` appends), so its id is captured before switching away.
        fireEvent.click(screen.getByTestId("sql-tab-add"));

        const tabAId =
            (within(screen.getByTestId("sql-tab-strip")).getAllByTestId(/^sql-tab-select-/u)[0] as HTMLElement).dataset.testid?.replace(
                "sql-tab-select-",
                "",
            ) ?? "";

        // Tab B's Run is enabled — tab A's in-flight query hasn't disabled/spun it,
        // the way a single panel-level `running` flag used to.
        expect(screen.getByTestId<HTMLButtonElement>("sql-run").disabled).toBe(false);
        expect(screen.getByTestId("sql-run").textContent).not.toContain("Running");

        // Land tab A's query while tab B is still the active tab.
        resolveSlow?.({ columns: ["name"], rowCount: 1, rows: [{ name: "slow-result" }], truncated: false });

        // Tab B is unaffected by tab A's query landing.
        expect(screen.getByTestId<HTMLButtonElement>("sql-run").disabled).toBe(false);

        // Switch back to tab A: its own spinner cleared (not tab B's), and its
        // result is the one that landed while it was in the background.
        fireEvent.click(screen.getByTestId(`sql-tab-select-${tabAId}`));

        await waitFor(() => {
            if (screen.getByTestId<HTMLButtonElement>("sql-run").disabled) {
                throw new Error("tab A's running flag never cleared");
            }
        });

        expect(screen.getByTestId("sql-rows").textContent).toContain("slow-result");
    });
});
