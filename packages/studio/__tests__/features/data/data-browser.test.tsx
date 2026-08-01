import { LunoraProvider } from "@lunora/react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { DataBrowserProps } from "../../../src/features/data/data-browser";
import { DataBrowser } from "../../../src/features/data/data-browser";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const TABLES = [
    { name: "messages", rowCount: 3 },
    { name: "users", rowCount: 1 },
];

const MESSAGE_ROWS = [
    { __id__: "m1", text: "hello" },
    { __id__: "m2", text: "world" },
    { __id__: "m3", text: "again" },
];

interface PageArgs {
    limit?: number;
    offset?: number;
    orderBy?: { column: string; direction: "asc" | "desc" };
    search?: string;
    table: string;
}

/** A client whose admin queries serve a fixed in-memory `messages` table, honoring server-side `search`. */
const createBrowserClient = (): MockClientHooks =>
    createMockClient({
        query: (reference, args): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return TABLES;
            }

            const { limit = 50, offset = 0, orderBy, search = "", table } = args as PageArgs;

            if (table !== "messages") {
                throw new Error(`unknown table: ${table}`);
            }

            // Mirror the server's whole-table substring filter across all cells.
            const needle = search.trim().toLowerCase();
            const matched =
                needle === "" ? MESSAGE_ROWS : MESSAGE_ROWS.filter((row) => Object.values(row).some((value) => value.toLowerCase().includes(needle)));

            // Mirror the server's whole-table sort (orderBy) before windowing.
            const ordered =
                orderBy === undefined
                    ? matched
                    : matched.toSorted((a, b) => {
                          const cmp = a[orderBy.column as keyof typeof a].localeCompare(b[orderBy.column as keyof typeof b]);

                          return orderBy.direction === "desc" ? -cmp : cmp;
                      });

            return { columns: ["__id__", "text"], rows: ordered.slice(offset, offset + limit), total: ordered.length };
        },
    });

/**
 * Test host emulating the studio's URL-controlled wiring: the open table is
 * DERIVED from `tableParam` (there is no local selection state inside the
 * browser any more), and `onSelectTable` is the navigation callback. Selection
 * lives here as plain state, and an FK-nav's `search` option re-seeds the
 * search the way the URL would.
 */
const ControlledDataBrowser = ({ editable, initialShardKey, pageSize }: DataBrowserProps): ReactElement => {
    const [table, setTable] = useState<string | undefined>(undefined);
    const [search, setSearch] = useState<string | undefined>(undefined);

    const onSelectTable = (next: string, options?: { search?: string }): void => {
        setTable(next);
        setSearch(options?.search);
    };

    return (
        <DataBrowser
            editable={editable}
            initialSearch={search}
            initialShardKey={initialShardKey}
            onSelectTable={onSelectTable}
            pageSize={pageSize}
            tableParam={table}
        />
    );
};

const renderBrowser = (mock: MockClientHooks, props: DataBrowserProps = {}): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <ControlledDataBrowser editable={props.editable} initialShardKey={props.initialShardKey} pageSize={props.pageSize} />
    </LunoraProvider>
);

describe("dataBrowser", () => {
    it("lists tables with row counts on mount", async () => {
        expect.assertions(2);

        const mock = createBrowserClient();

        render(renderBrowser(mock));

        // The sidebar renders the table name and its row-count badge separately.
        // (findBy: the list only populates once the async `listTables` resolves.)
        const messagesRow = await screen.findByTestId("db-table-messages");

        expect(messagesRow.textContent).toBe("messages3");
        expect(screen.getByTestId("db-table-users").textContent).toBe("users1");
    });

    it("loads the first page of a table when selected", async () => {
        expect.assertions(4);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 2 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-page");

        expect(screen.getAllByTestId("db-row")).toHaveLength(2);
        expect(screen.getByTestId("db-page-info").textContent).toBe("1-2 of 3");
        expect(screen.getByTestId<HTMLButtonElement>("db-prev").disabled).toBe(true);
        expect(screen.getByTestId<HTMLButtonElement>("db-next").disabled).toBe(false);
    });

    it("opens (and closes) the row-detail drawer from a row's Details button", async () => {
        expect.assertions(2);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 2 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-page");

        const firstRow = screen.getAllByTestId("db-row")[0] as HTMLElement;

        fireEvent.click(within(firstRow).getByText("Details"));

        // The drawer opens with the row's fields.
        await expect(screen.findByTestId("rd-fields")).resolves.toBeDefined();

        fireEvent.click(screen.getByTestId("rd-close"));

        expect(screen.queryByTestId("rd-panel")).toBeNull();
    });

    it("pages forward and back through a table", async () => {
        expect.assertions(3);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 2 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByText("1-2 of 3");

        fireEvent.click(screen.getByTestId("db-next"));

        await screen.findByText("3-3 of 3");

        expect(screen.getAllByTestId("db-row")).toHaveLength(1);
        expect(screen.getByTestId<HTMLButtonElement>("db-next").disabled).toBe(true);
        expect(screen.getByTestId<HTMLButtonElement>("db-prev").disabled).toBe(false);

        fireEvent.click(screen.getByTestId("db-prev"));

        await screen.findByText("1-2 of 3");
    });

    it("jumps straight to a page via the page-jump input", async () => {
        expect.assertions(1);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 2 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByText("1-2 of 3");

        // Type page 2 and commit with Enter → offset jumps to (2-1)*2 = 2.
        fireEvent.keyDown(screen.getByTestId("db-page-jump"), { key: "Enter", target: { value: "2" } });

        await screen.findByText("3-3 of 3");

        expect(screen.getAllByTestId("db-row")).toHaveLength(1);
    });

    it("changes rows-per-page and re-fetches with the new limit", async () => {
        expect.assertions(1);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 50 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-rows");

        fireEvent.change(screen.getByTestId("db-page-size"), { target: { value: "25" } });

        await waitFor(() => {
            const lastPage = mock.query.mock.calls.findLast((call) => (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.readTablePage) as [
                unknown,
                { limit?: number },
            ];

            if (lastPage[1].limit !== 25) {
                throw new Error(`expected limit 25, saw ${String(lastPage[1].limit)}`);
            }
        });

        const lastPage = mock.query.mock.calls.findLast((call) => (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.readTablePage) as [
            unknown,
            { limit?: number },
        ];

        expect(lastPage[1].limit).toBe(25);
    });

    it("auto-loads tables for the typed shard key (debounced, no manual trigger)", async () => {
        expect.assertions(1);

        const mock = createBrowserClient();

        render(renderBrowser(mock));

        await screen.findByTestId("db-table-list");

        // Typing a shard key auto-loads its tables once the input settles — no
        // "Load tables" button to click.
        fireEvent.change(screen.getByTestId("db-shard-input"), { target: { value: "room-9" } });

        await waitFor(() => {
            const calls = mock.query.mock.calls.filter(
                (call) =>
                    (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.listTables &&
                    (call[2] as { shardKey?: string } | undefined)?.shardKey === "room-9",
            );

            if (calls.length === 0) {
                throw new Error("tables not auto-loaded yet");
            }
        });

        const listCalls = mock.query.mock.calls.filter((call) => (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.listTables);
        const lastListCall = listCalls.at(-1) as [unknown, unknown, { shardKey?: string }];

        expect(lastListCall[2]).toEqual({ shardKey: "room-9" });
    });

    it("surfaces a table-listing error", async () => {
        expect.assertions(2);

        const mock = createMockClient({
            query: () => {
                throw new Error("ADMIN_FORBIDDEN");
            },
        });

        render(renderBrowser(mock));

        await screen.findByTestId("db-tables-error");

        expect(screen.getByTestId("db-tables-error").textContent).toBe("ADMIN_FORBIDDEN");
        // The sidebar stays mounted (so the shard picker remains usable to retry),
        // but with no tables it lists no selectable table entries.
        expect(screen.queryByTestId("db-table-messages")).toBeNull();
    });

    it("surfaces a page-read error without dropping the table list", async () => {
        expect.assertions(3);

        const mock = createMockClient({
            query: (reference) => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return TABLES;
                }

                throw new Error("UNKNOWN_TABLE");
            },
        });

        render(renderBrowser(mock));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-page-error");

        expect(screen.getByTestId("db-page-error").textContent).toBe("UNKNOWN_TABLE");
        expect(screen.queryByTestId("db-page")).toBeNull();
        expect(screen.getByTestId("db-table-list")).toBeDefined();
    });

    it("toggles between the table and JSON views", async () => {
        expect.assertions(3);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 2 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-rows");

        // Table view is the default; JSON view is opt-in.
        expect(screen.queryByTestId("db-json")).toBeNull();

        fireEvent.click(screen.getByTestId("db-view-json"));

        const json = screen.getByTestId("db-json");

        expect(JSON.parse(json.textContent ?? "")).toHaveLength(2);
        expect(screen.queryByTestId("db-rows")).toBeNull();
    });

    /** The first cell of every `db-row` in document order. */
    // Cell 0 is the row-select checkbox, cell 1 the `__id__` column, cell 2 the `text` value.
    const rowTexts = (): string[] => screen.getAllByTestId("db-row").map((row) => within(row).getAllByRole("cell")[2]?.textContent ?? "");

    // Wait for the grid rows to settle into an expected order (server-side sort
    // re-fetches the page asynchronously, so the new order isn't synchronous).
    const expectRowOrder = async (order: string[]): Promise<void> => {
        await waitFor(() => {
            if (rowTexts().join("|") !== order.join("|")) {
                throw new Error(`rows not ${order.join(",")} yet (saw ${rowTexts().join(",")})`);
            }
        });
    };

    it("sorts a column ascending then descending on repeated clicks (server-side)", async () => {
        expect.assertions(3);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-rows");

        // Unsorted: rows arrive in page (document) order.
        expect(rowTexts()).toEqual(["hello", "world", "again"]);

        // First click sorts ascending by the `text` column — re-fetched from the server.
        fireEvent.click(screen.getByTestId("db-sort-text"));
        await expectRowOrder(["again", "hello", "world"]);

        expect(rowTexts()).toEqual(["again", "hello", "world"]);

        // Second click flips to descending.
        fireEvent.click(screen.getByTestId("db-sort-text"));
        await expectRowOrder(["world", "hello", "again"]);

        expect(rowTexts()).toEqual(["world", "hello", "again"]);
    });

    it("transposes the grid (fields as rows) and back", async () => {
        expect.assertions(3);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-rows");

        // Toggle transpose: the virtualized grid is replaced by the transposed table,
        // whose row headers are the column names.
        fireEvent.click(screen.getByTestId("grid-transpose"));

        const transposed = await screen.findByTestId("db-transposed");

        expect(within(transposed).getByText("text")).toBeDefined();
        expect(screen.queryByTestId("db-rows")).toBeNull();

        // Toggle back to the normal grid.
        fireEvent.click(screen.getByTestId("grid-transpose"));

        await expect(screen.findByTestId("db-rows")).resolves.toBeDefined();
    });

    it("virtualizes the table sidebar so a huge schema mounts only a subset", async () => {
        expect.assertions(2);

        const many = Array.from({ length: 200 }, (_, index) => {
            return { name: `t${index.toString()}`, rowCount: 0 };
        });
        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return many;
                }

                return { columns: ["__id__"], rows: [], total: 0 };
            },
        });

        render(renderBrowser(mock, { pageSize: 10 }));

        // The first table mounts; the full 200 do not (only the visible window + overscan).
        await screen.findByTestId("db-table-t0");

        const mounted = screen.getAllByTestId(/^db-table-t\d+$/u);

        expect(mounted.length).toBeGreaterThan(0);
        expect(mounted.length).toBeLessThan(200);
    });

    it("clears the sort on the third click", async () => {
        expect.assertions(2);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-rows");

        fireEvent.click(screen.getByTestId("db-sort-text"));
        await expectRowOrder(["again", "hello", "world"]);

        expect(rowTexts()).toEqual(["again", "hello", "world"]);

        // asc -> desc -> unsorted restores document order. Each click triggers a
        // server re-fetch that unmounts the grid until the page lands, so settle
        // between clicks instead of firing them back-to-back.
        fireEvent.click(screen.getByTestId("db-sort-text"));
        await expectRowOrder(["world", "hello", "again"]);
        fireEvent.click(screen.getByTestId("db-sort-text"));
        await expectRowOrder(["hello", "world", "again"]);

        expect(rowTexts()).toEqual(["hello", "world", "again"]);
    });

    it("searches the whole table server-side, case-insensitively", async () => {
        expect.assertions(3);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-rows");

        fireEvent.change(screen.getByTestId("db-filter"), { target: { value: "WOR" } });

        // Debounced → re-fetched from the server with the search arg.
        await waitFor(() => {
            if (rowTexts().length !== 1) {
                throw new Error("search not applied yet");
            }
        });

        expect(rowTexts()).toEqual(["world"]);

        // The row count rides a separate predicate-keyed `readTablePage` call
        // (limit 1, no offset) — pick the PAGE read (`skipCount: true`), not
        // whichever of the two happened to resolve last.
        const searchCall = mock.query.mock.calls.findLast(
            (call) =>
                (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.readTablePage && (call[1] as { skipCount?: boolean }).skipCount === true,
        ) as [unknown, { offset: number; search: string }, unknown];

        // The search is sent to the server (lowercased trim applied client-side) and resets to page 0.
        expect(searchCall[1].search).toBe("WOR");
        expect(searchCall[1].offset).toBe(0);
    });

    it("composes server search with page-local sort", async () => {
        expect.assertions(1);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-rows");

        // Server keeps the rows containing "o" (hello, world); sort them ascending locally.
        fireEvent.change(screen.getByTestId("db-filter"), { target: { value: "o" } });

        await waitFor(() => {
            if (rowTexts().length !== 2) {
                throw new Error("search not applied yet");
            }
        });

        // Sorting is server-side and unmounts the grid while re-fetching — settle.
        fireEvent.click(screen.getByTestId("db-sort-text"));
        await expectRowOrder(["hello", "world"]);

        expect(rowTexts()).toEqual(["hello", "world"]);
    });

    it("re-fetches from the server with an orderBy arg when sorting", async () => {
        expect.assertions(2);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-rows");

        const pageCalls = (): number =>
            mock.query.mock.calls.filter((call) => (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.readTablePage).length;

        // Sorting is server-side — clicking a header re-fetches the whole table in
        // the new order (so paging through a sorted view stays correct).
        const beforeSort = pageCalls();

        fireEvent.click(screen.getByTestId("db-sort-text"));

        await waitFor(() => {
            if (pageCalls() <= beforeSort) {
                throw new Error("sort did not refetch yet");
            }
        });

        expect(pageCalls()).toBeGreaterThan(beforeSort);

        // The re-fetch carries the orderBy for the clicked column, ascending first.
        const sortCall = mock.query.mock.calls.findLast((call) => (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.readTablePage) as [
            unknown,
            { orderBy?: { column: string; direction: string } },
        ];

        expect(sortCall[1].orderBy).toEqual({ column: "text", direction: "asc" });
    });

    it("virtualizes a large page so the DOM row count stays bounded", async () => {
        expect.assertions(3);

        // A 250-row page far exceeds the ~400px viewport (rows are ~36px), so the
        // virtualizer must mount only the visible window plus overscan — never all
        // 250 rows. The fixed viewport height is reported to the virtualizer via a
        // custom `observeElementRect`, so this is deterministic under jsdom.
        const bigRows = Array.from({ length: 250 }, (_, index) => {
            return { __id__: `m${index.toString()}`, text: `row-${index.toString()}` };
        });

        const mock = createMockClient({
            query: (reference, args): unknown => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return [{ name: "messages", rowCount: bigRows.length }];
                }

                const { limit = 50, offset = 0 } = args as PageArgs;

                return { columns: ["__id__", "text"], rows: bigRows.slice(offset, offset + limit), total: bigRows.length };
            },
        });

        render(renderBrowser(mock, { pageSize: 250 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-rows");

        const rendered = screen.getAllByTestId("db-row");

        // The whole page is loaded (total reflects all 250 rows) ...
        expect(screen.getByTestId("db-page-info").textContent).toBe("1-250 of 250");
        // ... but only a small bounded window is actually in the DOM ...
        expect(rendered.length).toBeLessThan(60);
        // ... and the window is non-empty (the first row is mounted).
        expect(rendered.length).toBeGreaterThan(0);
    });
});

describe("dataBrowser — editable", () => {
    /** Records writeRow calls and serves the messages table for everything else. */
    const createEditableClient = (): MockClientHooks =>
        createMockClient({
            query: (reference, args): unknown => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return TABLES;
                }

                if (reference === ADMIN_FUNCTIONS.writeRow) {
                    const { id, op } = args as { id?: string; op: string };

                    const resultId = op === "insert" ? "m4" : (id ?? null);

                    return { id: resultId, op };
                }

                const { limit = 50, offset = 0, search = "" } = args as PageArgs;
                const needle = search.trim().toLowerCase();
                const matched =
                    needle === "" ? MESSAGE_ROWS : MESSAGE_ROWS.filter((row) => Object.values(row).some((value) => value.toLowerCase().includes(needle)));

                return { columns: ["__id__", "text"], rows: matched.slice(offset, offset + limit), total: matched.length };
            },
        });

    const openMessages = async (mock: MockClientHooks): Promise<void> => {
        render(renderBrowser(mock, { editable: true, pageSize: 2 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-page");
    };

    it("hides edit controls unless `editable` is set", async () => {
        expect.assertions(2);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 2 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-page");

        expect(screen.queryByTestId("db-add-row")).toBeNull();
        expect(screen.queryByTestId("db-edit-m1")).toBeNull();
    });

    it("deletes a row via the writeRow op", async () => {
        expect.assertions(1);

        const mock = createEditableClient();

        await openMessages(mock);

        fireEvent.click(screen.getByTestId("db-delete-m1"));
        fireEvent.click(screen.getByTestId("db-delete-m1-confirm"));

        await waitFor(() => {
            if (!mock.query.mock.calls.some((c) => c[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow)) {
                throw new Error("writeRow not called yet");
            }
        });

        const call = mock.query.mock.calls.find((c) => c[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow) as [unknown, Record<string, unknown>, unknown];

        expect(call[1]).toMatchObject({ id: "m1", op: "delete", table: "messages" });
    });

    it("inserts a new row from the editor", async () => {
        expect.assertions(1);

        const mock = createEditableClient();

        await openMessages(mock);

        fireEvent.click(screen.getByTestId("db-add-row"));
        // Switch the editor to raw-JSON mode to set the whole document at once.
        fireEvent.click(screen.getByTestId("db-editor-json"));
        fireEvent.change(screen.getByTestId("db-editor-doc"), { target: { value: '{ "text": "fresh" }' } });
        fireEvent.click(screen.getByTestId("db-editor-save"));

        await waitFor(() => {
            if (!mock.query.mock.calls.some((c) => c[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow)) {
                throw new Error("writeRow not called yet");
            }
        });

        const call = mock.query.mock.calls.find((c) => c[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow) as [unknown, Record<string, unknown>, unknown];

        expect(call[1]).toMatchObject({ doc: { text: "fresh" }, op: "insert", table: "messages" });
    });

    it("inserts a new row from the type-aware form fields", async () => {
        expect.assertions(2);

        const mock = createEditableClient();

        await openMessages(mock);

        fireEvent.click(screen.getByTestId("db-add-row"));

        // The form seeds an input per editable column (the `text` field here).
        const field = await screen.findByTestId<HTMLInputElement>("db-field-text");

        expect(field).toBeDefined();

        fireEvent.change(field, { target: { value: "from-form" } });
        fireEvent.click(screen.getByTestId("db-editor-save"));

        await waitFor(() => {
            if (!mock.query.mock.calls.some((c) => c[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow)) {
                throw new Error("writeRow not called yet");
            }
        });

        const call = mock.query.mock.calls.find((c) => c[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow) as [unknown, Record<string, unknown>, unknown];

        expect(call[1]).toMatchObject({ doc: { text: "from-form" }, op: "insert", table: "messages" });
    });

    it("stages an inline cell edit and commits it as a patch of just that field", async () => {
        expect.assertions(2);

        const mock = createEditableClient();

        await openMessages(mock);

        // Double-click the `text` cell of row m1 to open the inline editor, change
        // the value, and commit the cell with Enter — staging the edit.
        fireEvent.doubleClick(await screen.findByTestId("db-cell-m1-text"));

        const input = await screen.findByTestId<HTMLInputElement>("db-cell-input-m1-text");

        fireEvent.change(input, { target: { value: "edited" } });
        fireEvent.keyDown(input, { key: "Enter" });

        // The staged-diff panel surfaces the pending change before any write.
        const staged = await screen.findByTestId("db-staged");

        expect(staged.textContent).toContain("edited");

        // Commit issues a single patch carrying only the edited field.
        fireEvent.click(screen.getByTestId("db-staged-commit"));

        await waitFor(() => {
            if (!mock.query.mock.calls.some((c) => c[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow)) {
                throw new Error("writeRow not called yet");
            }
        });

        const call = mock.query.mock.calls.find((c) => c[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow) as [unknown, Record<string, unknown>, unknown];

        expect(call[1]).toMatchObject({ doc: { text: "edited" }, id: "m1", op: "patch", table: "messages" });
    });

    it("reports invalid JSON without calling the server", async () => {
        expect.assertions(2);

        const mock = createEditableClient();

        await openMessages(mock);

        fireEvent.click(screen.getByTestId("db-add-row"));
        fireEvent.click(screen.getByTestId("db-editor-json"));
        fireEvent.change(screen.getByTestId("db-editor-doc"), { target: { value: "{ not json" } });
        fireEvent.click(screen.getByTestId("db-editor-save"));

        const writeError = await screen.findByTestId("db-write-error");

        expect(writeError.textContent).toContain("Invalid JSON");
        expect(mock.query.mock.calls.some((c) => c[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow)).toBe(false);
    });

    it("edits an existing row (patch) prefilled from its doc", async () => {
        expect.assertions(2);

        const mock = createEditableClient();

        await openMessages(mock);

        fireEvent.click(screen.getByTestId("db-edit-m1"));
        fireEvent.click(screen.getByTestId("db-editor-json"));

        // The editor prefills the row's editable fields (id/meta stripped).
        const editor = screen.getByTestId<HTMLTextAreaElement>("db-editor-doc");

        expect(JSON.parse(editor.value)).toEqual({ text: "hello" });

        fireEvent.change(editor, { target: { value: '{ "text": "edited" }' } });
        fireEvent.click(screen.getByTestId("db-editor-save"));

        await waitFor(() => {
            if (!mock.query.mock.calls.some((c) => c[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow)) {
                throw new Error("writeRow not called yet");
            }
        });

        const call = mock.query.mock.calls.find((c) => c[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow) as [unknown, Record<string, unknown>, unknown];

        expect(call[1]).toMatchObject({ doc: { text: "edited" }, id: "m1", op: "patch", table: "messages" });
    });

    it("edits the right row while a filter and sort are active", async () => {
        expect.hasAssertions();

        const mock = createEditableClient();

        render(renderBrowser(mock, { editable: true, pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-rows");

        // Sort descending and search to a single row — `world` is m2 in the fixture.
        // Sorting is server-side: each click re-fetches (unmounting the grid until
        // the page lands), so settle between the two clicks.
        fireEvent.click(screen.getByTestId("db-sort-text"));
        await waitFor(() => {
            expect(screen.getAllByTestId("db-row").length).toBeGreaterThan(0);
        });
        fireEvent.click(screen.getByTestId("db-sort-text"));
        await waitFor(() => {
            expect(screen.getAllByTestId("db-row").length).toBeGreaterThan(0);
        });
        fireEvent.change(screen.getByTestId("db-filter"), { target: { value: "world" } });

        // Wait for the debounced server search to narrow the page to just m2.
        await waitFor(() => {
            if (screen.getAllByTestId("db-row").length !== 1) {
                throw new Error("search not applied yet");
            }
        });

        // The editor prefills from the ORIGINAL row, not a sorted/filtered copy.
        fireEvent.click(screen.getByTestId("db-edit-m2"));
        fireEvent.click(screen.getByTestId("db-editor-json"));

        const editor = screen.getByTestId<HTMLTextAreaElement>("db-editor-doc");

        expect(JSON.parse(editor.value)).toEqual({ text: "world" });

        fireEvent.change(editor, { target: { value: '{ "text": "patched" }' } });
        fireEvent.click(screen.getByTestId("db-editor-save"));

        await waitFor(() => {
            if (!mock.query.mock.calls.some((c) => c[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow)) {
                throw new Error("writeRow not called yet");
            }
        });

        const call = mock.query.mock.calls.find((c) => c[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow) as [unknown, Record<string, unknown>, unknown];

        expect(call[1]).toMatchObject({ doc: { text: "patched" }, id: "m2", op: "patch", table: "messages" });
    });

    it("is always live: subscribes to readTablePage on load and renders pushed rows", async () => {
        expect.assertions(2);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 2 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-page");

        // No Live toggle — loading a page opens both a readTablePage and a listTables
        // subscription; assert the page one is among them (order isn't contractual).
        const references = mock.subscribe.mock.calls.map((call) => (call[0] as { __lunoraRef: string }).__lunoraRef);

        expect(references).toContain(ADMIN_FUNCTIONS.readTablePage);

        act(() => {
            mock.emit(ADMIN_FUNCTIONS.readTablePage, { columns: ["__id__", "text"], rows: [{ __id__: "m9", text: "LIVE ROW" }], total: 1 });
        });

        expect(screen.getByTestId("db-page").textContent).toContain("LIVE ROW");
    });

    it("keeps the live subscription bound to the loaded page, ignoring shard-input keystrokes", async () => {
        expect.hasAssertions();

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 2 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-page");

        // The page renders from its first read before the subscription effects run,
        // so wait until both load-time subscriptions (the page + the table list) have
        // settled before snapshotting — otherwise a late load-time subscribe would be
        // misattributed to the keystroke below and flake the count.
        await waitFor(() => {
            const refs = mock.subscribe.mock.calls.map((call) => (call[0] as { __lunoraRef: string }).__lunoraRef);

            expect(refs).toEqual(expect.arrayContaining([ADMIN_FUNCTIONS.readTablePage, ADMIN_FUNCTIONS.listTables]));
        });

        const callsAfterLoad = mock.subscribe.mock.calls.length;

        // Typing into the shard-key input changes `shardKey` state but not the
        // loaded page descriptor, so the live channel must NOT tear down and
        // re-subscribe per keystroke to shards that were never loaded.
        fireEvent.change(screen.getByTestId("db-shard-input"), { target: { value: "tenant-7" } });

        expect(mock.subscribe).toHaveBeenCalledTimes(callsAfterLoad);
    });

    it("live pushes a refreshed table list (new tables appear without a reload)", async () => {
        expect.assertions(2);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 2 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-page");

        // A live listTables push adds a table the initial load didn't include.
        act(() => {
            mock.emit(ADMIN_FUNCTIONS.listTables, [
                { name: "messages", rowCount: 3 },
                { name: "users", rowCount: 1 },
                { name: "invoices", rowCount: 7 },
            ]);
        });

        expect(screen.getByTestId("db-table-invoices")).toBeDefined();
        expect(screen.getByTestId("db-table-invoices").textContent).toContain("invoices");
    });

    /**
     * A two-table client: `posts` has an `authorId` foreign key into `users`,
     * surfaced via the page's `refs` map (as the server's readTablePage emits).
     */
    const createRelationalClient = (): MockClientHooks => {
        const POSTS = [{ authorId: "u1", id: "p1", title: "Hello" }];
        const USERS = [
            { id: "u1", name: "Ada" },
            { id: "u2", name: "Bob" },
        ];

        return createMockClient({
            query: (reference, args): unknown => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return [
                        { name: "posts", rowCount: 1 },
                        { name: "users", rowCount: 2 },
                    ];
                }

                const { search = "", table } = args as { search?: string; table: string };
                const needle = search.trim().toLowerCase();
                const rowMatchesNeedle = (row: Record<string, unknown>): boolean =>
                    Object.values(row).some((value) => String(value).toLowerCase().includes(needle));
                const match = <T extends Record<string, unknown>>(source: T[]): T[] => (needle === "" ? source : source.filter((row) => rowMatchesNeedle(row)));

                if (table === "posts") {
                    return { columns: ["id", "title", "authorId"], refs: { authorId: "users" }, rows: match(POSTS), total: match(POSTS).length };
                }

                return { columns: ["id", "name"], rows: match(USERS), total: match(USERS).length };
            },
        });
    };

    it("renders a foreign-key cell as a link and clicking it navigates to the target row", async () => {
        expect.assertions(3);

        const mock = createRelationalClient();

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-posts"));
        await screen.findByTestId("db-rows");

        // The authorId cell is a link showing the referenced id.
        const refLink = screen.getByTestId("db-ref-authorId");

        expect(refLink.textContent).toContain("u1");

        // Clicking it switches to `users` and searches for that id.
        fireEvent.click(refLink);

        await waitFor(() => {
            if (screen.queryAllByTestId("db-row").length !== 1) {
                throw new Error("did not navigate to the users row yet");
            }
        });

        // Only the referenced user (u1 / Ada) is shown after navigation.
        const rowText = screen.getAllByTestId("db-row")[0]?.textContent ?? "";

        expect(rowText).toContain("u1");
        expect(rowText).toContain("Ada");
    });

    it("non-foreign-key columns render plain text, not links", async () => {
        expect.assertions(2);

        const mock = createRelationalClient();

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-posts"));
        await screen.findByTestId("db-rows");

        // `title` has no ref → no link button for it.
        expect(screen.queryByTestId("db-ref-title")).toBeNull();
        expect(screen.getByTestId("db-ref-authorId")).toBeDefined();
    });

    it("previews the referenced row on hover without navigating away", async () => {
        expect.assertions(3);

        const mock = createRelationalClient();

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-posts"));
        await screen.findByTestId("db-rows");

        // Hovering the FK cell lazily fetches and shows the referenced user's fields.
        fireEvent.mouseEnter(screen.getByTestId("db-ref-authorId"));

        const preview = await screen.findByTestId("db-ref-preview");

        expect(within(preview).getByText("name")).toBeDefined();
        await expect(within(preview).findByText("Ada")).resolves.toBeDefined();

        // The current table is still `posts` — preview didn't navigate.
        expect(screen.getByTestId("db-table-posts").getAttribute("aria-pressed")).toBe("true");
    });
});

interface FilterArg {
    column: string;
    operator: string;
    value: unknown;
}

/**
 * A stateful client over a mutable `messages` table that honours structured
 * `filters`, single-row `writeRow` deletes, and the writer-routed bulk ops
 * (`deleteRows` / `clearTable`). The bulk ops mirror the server: they match the
 * same `eq`-filter predicate `readTablePage` previews, delete in bulk, and
 * return `{ deleted, hasMore }` — bounded by `bulkCap` so a test can drive the
 * client's multi-call loop.
 */
const createFilterableClient = (bulkCap = 50): MockClientHooks => {
    let rows = [
        { __id__: "m1", status: "active", text: "hello" },
        { __id__: "m2", status: "active", text: "world" },
        { __id__: "m3", status: "archived", text: "again" },
    ];

    const matchesFilters = (row: Record<string, unknown>, filters: FilterArg[]): boolean =>
        filters.every((clause) => clause.operator !== "eq" || String(row[clause.column]) === String(clause.value));

    return createMockClient({
        query: (reference, args): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return [{ name: "messages", rowCount: rows.length }];
            }

            if (reference === ADMIN_FUNCTIONS.writeRow) {
                const { id, op } = args as { id?: string; op: string };

                if (op === "delete" && id !== undefined) {
                    rows = rows.filter((row) => row["__id__"] !== id);
                }

                return { id: id ?? null, op };
            }

            if (reference === ADMIN_FUNCTIONS.deleteRows || reference === ADMIN_FUNCTIONS.clearTable) {
                const { filters = [] } = args as { filters?: FilterArg[] };
                const matched = rows.filter((row) => matchesFilters(row as Record<string, unknown>, filters));
                const batch = matched.slice(0, bulkCap);
                const doomed = new Set(batch.map((row) => row["__id__"]));

                rows = rows.filter((row) => !doomed.has(row["__id__"]));

                return { deleted: batch.length, hasMore: matched.length > bulkCap };
            }

            // readTablePage: apply each structured filter (eq only, enough here).
            const { filters = [], limit = 50, offset = 0, table } = args as { filters?: FilterArg[]; limit?: number; offset?: number; table: string };

            if (table !== "messages") {
                throw new Error(`unknown table: ${table}`);
            }

            const matched = rows.filter((row) => matchesFilters(row as Record<string, unknown>, filters));

            return { columns: ["__id__", "status", "text"], rows: matched.slice(offset, offset + limit), total: matched.length };
        },
    });
};

describe("dataBrowser — structured filters and bulk delete", () => {
    it("passes a structured filter to readTablePage and narrows the page", async () => {
        expect.assertions(2);

        const mock = createFilterableClient();

        render(renderBrowser(mock, { editable: true, pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-page");

        // Add a clause and set it to `status = archived` → only m3 survives.
        fireEvent.click(screen.getByTestId("db-add-filter"));
        // Each filter edit re-keys the page read; the toolbar (and the filter row
        // with it) unmounts until the new page lands — await each control back.
        fireEvent.change(await screen.findByTestId("db-filter-column"), { target: { value: "status" } });
        fireEvent.change(await screen.findByTestId("db-filter-value"), { target: { value: "archived" } });

        await waitFor(() => {
            if (screen.getAllByTestId("db-row").length !== 1) {
                throw new Error("filter not applied yet");
            }
        });

        const lastRead = mock.query.mock.calls.findLast((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.readTablePage);

        expect((lastRead?.[1] as { filters?: FilterArg[] }).filters).toStrictEqual([{ column: "status", operator: "eq", value: "archived" }]);
        expect(screen.getByTestId("db-row").textContent).toContain("again");
    });

    it("bulk-deletes every row matching the active filter", async () => {
        expect.assertions(3);

        const mock = createFilterableClient();

        render(renderBrowser(mock, { editable: true, pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-page");

        // Filter to the two active rows, then bulk-delete them.
        fireEvent.click(screen.getByTestId("db-add-filter"));
        // Each filter edit re-keys the page read; the toolbar (and the filter row
        // with it) unmounts until the new page lands — await each control back.
        fireEvent.change(await screen.findByTestId("db-filter-column"), { target: { value: "status" } });
        fireEvent.change(await screen.findByTestId("db-filter-value"), { target: { value: "active" } });

        await waitFor(() => {
            if (screen.getAllByTestId("db-row").length !== 2) {
                throw new Error("filter not applied yet");
            }
        });

        fireEvent.click(screen.getByTestId("db-bulk-delete"));
        fireEvent.click(screen.getByTestId("db-bulk-delete-confirm"));

        // Both active rows deleted → the filtered page is now empty.
        await waitFor(() => {
            if (screen.queryAllByTestId("db-row").length > 0) {
                throw new Error("rows not deleted yet");
            }
        });

        // One server `deleteRows` round-trip (not the old per-row N+1 loop), and
        // never a single-row writeRow delete.
        const bulk = mock.query.mock.calls.filter((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.deleteRows);
        const perRow = mock.query.mock.calls.filter((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow);

        expect(bulk).toHaveLength(1);
        expect((bulk[0]?.[1] as { filters?: FilterArg[] }).filters).toStrictEqual([{ column: "status", operator: "eq", value: "active" }]);
        expect(perRow).toHaveLength(0);
    });

    it("loops the bounded deleteRows call until the server reports no more", async () => {
        expect.assertions(2);

        // Cap each server call at one row, so draining the two active rows takes
        // two `deleteRows` round-trips driven by `hasMore`.
        const mock = createFilterableClient(1);

        render(renderBrowser(mock, { editable: true, pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-page");

        fireEvent.click(screen.getByTestId("db-add-filter"));
        // Each filter edit re-keys the page read; the toolbar (and the filter row
        // with it) unmounts until the new page lands — await each control back.
        fireEvent.change(await screen.findByTestId("db-filter-column"), { target: { value: "status" } });
        fireEvent.change(await screen.findByTestId("db-filter-value"), { target: { value: "active" } });

        await waitFor(() => {
            if (screen.getAllByTestId("db-row").length !== 2) {
                throw new Error("filter not applied yet");
            }
        });

        fireEvent.click(screen.getByTestId("db-bulk-delete"));
        fireEvent.click(screen.getByTestId("db-bulk-delete-confirm"));

        await waitFor(() => {
            if (screen.queryAllByTestId("db-row").length > 0) {
                throw new Error("rows not deleted yet");
            }
        });

        const bulk = mock.query.mock.calls.filter((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.deleteRows);

        // Two bounded round-trips (cap=1, two matches), then a third that reports
        // hasMore=false stops the loop — so at least two, capped by the loop.
        expect(bulk.length).toBeGreaterThanOrEqual(2);
        expect(mock.query.mock.calls.some((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow)).toBe(false);
    });

    it("clears the whole table via the clearTable op when no filter is active", async () => {
        expect.assertions(2);

        const mock = createFilterableClient();

        render(renderBrowser(mock, { editable: true, pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-page");

        // No filter/search → the "Clear table" affordance is shown.
        fireEvent.click(screen.getByTestId("db-clear-table"));
        fireEvent.click(screen.getByTestId("db-clear-table-confirm"));

        await waitFor(() => {
            if (screen.queryAllByTestId("db-row").length > 0) {
                throw new Error("table not cleared yet");
            }
        });

        const clears = mock.query.mock.calls.filter((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.clearTable);

        expect(clears).toHaveLength(1);
        expect((clears[0]?.[1] as { table: string }).table).toBe("messages");
    });

    it("selects all rows and surfaces the selection bar with a count", async () => {
        expect.assertions(2);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-rows");

        // No selection → no bar.
        expect(screen.queryByTestId("grid-selection-bar")).toBeNull();

        fireEvent.click(screen.getByTestId("db-select-all"));

        // All three fixture rows selected.
        const countBar = await screen.findByTestId("grid-selection-count");

        expect(countBar.textContent).toContain("3 selected");
    });

    it("bulk-deletes the selected rows through the writer", async () => {
        expect.assertions(2);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { editable: true, pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-rows");

        fireEvent.click(screen.getByTestId("db-select-all"));
        await screen.findByTestId("grid-selection-count");

        fireEvent.click(screen.getByTestId("grid-selection-delete"));
        fireEvent.click(screen.getByTestId("grid-selection-delete-confirm"));

        await waitFor(() => {
            const deletes = mock.query.mock.calls.filter(
                (call) => (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.writeRow && (call[1] as { op: string }).op === "delete",
            );

            if (deletes.length !== 3) {
                throw new Error(`expected 3 deletes, saw ${deletes.length.toString()}`);
            }
        });

        const deletes = mock.query.mock.calls.filter(
            (call) => (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.writeRow && (call[1] as { op: string }).op === "delete",
        );

        // One delete per selected row, each addressing a fixture id.
        expect(deletes).toHaveLength(3);
        expect((deletes[0]?.[1] as { id: string }).id).toMatch(/^m\d$/u);
    });

    it("expands a cell to show its full value and copies it", async () => {
        expect.assertions(3);

        const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);

        Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText } });

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-rows");

        fireEvent.click(screen.getAllByTestId("db-expand-text")[0] as HTMLElement);

        const value = await screen.findByTestId("grid-cell-value");

        expect(value.textContent).toBe("hello");

        fireEvent.click(screen.getByTestId("grid-cell-copy"));

        expect(writeText).toHaveBeenCalledWith("hello");

        fireEvent.click(screen.getByTestId("grid-cell-close"));

        expect(screen.queryByTestId("grid-cell-dialog")).toBeNull();
    });

    it("hides a column via the Columns menu", async () => {
        expect.assertions(2);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-rows");

        // The `text` column header is present to start.
        expect(screen.getByTestId("db-sort-text")).toBeDefined();

        fireEvent.click(screen.getByTestId("grid-columns"));
        fireEvent.click(await screen.findByTestId("grid-column-text"));

        await waitFor(() => {
            if (screen.queryByTestId("db-sort-text") !== null) {
                throw new Error("column not hidden yet");
            }
        });

        expect(screen.queryByTestId("db-sort-text")).toBeNull();
    });
});

/**
 * A client that serves a fixed `messages` page plus a `facetColumn` summary for
 * the `status` column, honouring the active `eq` filters so the facet reflects the
 * previewed view. The `status` value distribution is skewed (active=2, archived=1)
 * so the ORDER-BY-count ordering and the value/count rows are observable.
 */
const createFacetableClient = (): MockClientHooks => {
    const rows = [
        { __id__: "m1", status: "active", text: "hello" },
        { __id__: "m2", status: "active", text: "world" },
        { __id__: "m3", status: "archived", text: "again" },
    ];

    const matchesFilters = (row: Record<string, unknown>, filters: FilterArg[]): boolean =>
        filters.every((clause) => clause.operator !== "eq" || String(row[clause.column]) === String(clause.value));

    return createMockClient({
        query: (reference, args): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return [{ name: "messages", rowCount: rows.length }];
            }

            if (reference === ADMIN_FUNCTIONS.facetColumn) {
                const { column, filters = [] } = args as { column: string; filters?: FilterArg[] };
                const scoped = rows.filter((row) => matchesFilters(row, filters));
                const counts = new Map<unknown, number>();

                for (const row of scoped) {
                    const value = row[column as keyof typeof row];

                    counts.set(value, (counts.get(value) ?? 0) + 1);
                }

                const values = [...counts.entries()]
                    .map(([value, count]) => {
                        return { count, value };
                    })
                    .toSorted((a, b) => b.count - a.count);

                return { truncated: false, values };
            }

            const { filters = [], limit = 50, offset = 0, table } = args as { filters?: FilterArg[]; limit?: number; offset?: number; table: string };

            if (table !== "messages") {
                throw new Error(`unknown table: ${table}`);
            }

            const matched = rows.filter((row) => matchesFilters(row, filters));

            return { columns: ["__id__", "status", "text"], rows: matched.slice(offset, offset + limit), total: matched.length };
        },
    });
};

describe("dataBrowser — facets", () => {
    it("toggles a column on and renders its value/count rows", async () => {
        expect.assertions(2);

        const mock = createFacetableClient();

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-page");

        // Toggle the `status` column into the facet sidebar.
        fireEvent.click(screen.getByTestId("db-facet-toggle-status"));

        const facet = await screen.findByTestId("db-facet-status");
        const values = within(facet).getAllByTestId("db-facet-value-status");

        // active=2, archived=1 → ordered by count, active leads.
        expect(values[0]?.textContent).toBe("active2");
        expect(values[1]?.textContent).toBe("archived1");
    });

    it("adds an `eq` filter when a facet value is clicked", async () => {
        expect.assertions(2);

        const mock = createFacetableClient();

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-page");

        fireEvent.click(screen.getByTestId("db-facet-toggle-status"));
        await screen.findByTestId("db-facet-status");

        // Click the `archived` facet value → adds `status = archived`, narrowing to m3.
        const facet = screen.getByTestId("db-facet-status");

        fireEvent.click(within(facet).getAllByTestId("db-facet-value-status")[1] as HTMLElement);

        await waitFor(() => {
            if (screen.getAllByTestId("db-row").length !== 1) {
                throw new Error("facet filter not applied yet");
            }
        });

        const lastRead = mock.query.mock.calls.findLast((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.readTablePage);

        expect((lastRead?.[1] as { filters?: FilterArg[] }).filters).toStrictEqual([{ column: "status", operator: "eq", value: "archived" }]);
        expect(screen.getByTestId("db-row").textContent).toContain("again");
    });
});

interface ShardSwitchRow {
    __id__: string;
    text: string;
}

/**
 * Two independent shard fixtures — `""` (the default/root shard) serving table
 * `inbox`, and `"s2"` serving a DIFFERENT table `archive` — so a test can drive
 * an atomic table+shard switch (the shape a saved-query apply or a cross-shard
 * deep link produces: table, shard, and search all change in ONE URL push) and
 * tell which shard a request actually reached from `options.shardKey`.
 */
const SHARD_SWITCH_FIXTURES: Record<string, { rows: ShardSwitchRow[]; table: string }> = {
    "": { rows: [{ __id__: "a1", text: "alpha-hello" }], table: "inbox" },
    s2: { rows: [{ __id__: "b1", text: "beta-world" }], table: "archive" },
};

const createShardSwitchClient = (): MockClientHooks =>
    createMockClient({
        query: (reference, args, options): unknown => {
            const shard = (options as { shardKey?: string } | undefined)?.shardKey ?? "";
            const fixture = SHARD_SWITCH_FIXTURES[shard];

            if (fixture === undefined) {
                throw new Error(`unknown shard: ${shard}`);
            }

            if (reference === ADMIN_FUNCTIONS.listTables) {
                return [{ name: fixture.table, rowCount: fixture.rows.length }];
            }

            if (reference === ADMIN_FUNCTIONS.writeRow) {
                const { id, op } = args as { id?: string; op: string };

                if (op === "delete" && id !== undefined) {
                    fixture.rows = fixture.rows.filter((row) => row["__id__"] !== id);
                }

                return { id: id ?? null, op };
            }

            // readTablePage
            const { search = "", table } = args as { search?: string; table: string };

            if (table !== fixture.table) {
                throw new Error(`unknown table "${table}" on shard "${shard}"`);
            }

            const needle = search.trim().toLowerCase();
            const matched = needle === "" ? fixture.rows : fixture.rows.filter((row) => row.text.toLowerCase().includes(needle));

            return { columns: ["__id__", "text"], rows: matched, total: matched.length };
        },
    });

/**
 * Test host that can drive an ATOMIC table+shard+search switch — `table`,
 * `search`, and `shardKey` all change inside ONE event handler (one React
 * commit), the way the real Table editor's "apply saved query" flow pushes a
 * saved view's table, shard, and search as a single URL update.
 * `onSelectTable` (a plain in-app table click) deliberately leaves the shard
 * alone, matching production.
 */
const ShardSwitchDataBrowser = ({ pageSize }: { pageSize?: number }): ReactElement => {
    const [table, setTable] = useState<string | undefined>(undefined);
    const [search, setSearch] = useState<string | undefined>(undefined);
    const [shardKey, setShardKey] = useState<string | undefined>(undefined);

    const onSelectTable = (next: string, options?: { search?: string }): void => {
        setTable(next);
        setSearch(options?.search);
    };

    const applyShardSwitch = (): void => {
        setTable("archive");
        setSearch(undefined);
        setShardKey("s2");
    };

    return (
        <>
            <button data-testid="apply-shard-switch" onClick={applyShardSwitch} type="button">
                apply saved query
            </button>
            <DataBrowser editable initialSearch={search} initialShardKey={shardKey} onSelectTable={onSelectTable} pageSize={pageSize} tableParam={table} />
        </>
    );
};

describe("dataBrowser — table switch reset (STUDIO-01)", () => {
    it("issues the first read for the new table with ITS OWN search, not the previous table's leftover search", async () => {
        expect.assertions(1);

        const mock = createShardSwitchClient();

        render(
            <LunoraProvider client={mock.asClient}>
                <ShardSwitchDataBrowser pageSize={10} />
            </LunoraProvider>,
        );

        fireEvent.click(await screen.findByTestId("db-table-inbox"));
        await screen.findByText("alpha-hello");

        // Type a search for table A, then switch WITHOUT waiting for its 300ms
        // debounce to settle — the reset must discard it outright, not merely win
        // a race against it.
        fireEvent.change(screen.getByTestId("db-filter"), { target: { value: "alpha" } });
        fireEvent.click(screen.getByTestId("apply-shard-switch"));

        await screen.findByText("beta-world");

        const archiveRead = mock.query.mock.calls.find(
            (call) => (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.readTablePage && (call[1] as { table: string }).table === "archive",
        ) as [unknown, { search?: string; table: string }, unknown] | undefined;

        // The very first read for the new table already carries ITS search
        // ("") — never table A's leftover "alpha".
        expect(archiveRead?.[1].search).toBe("");
    });

    it("targets the NEW shard for a delete issued right after a switch that also changes shard", async () => {
        expect.assertions(1);

        const mock = createShardSwitchClient();

        render(
            <LunoraProvider client={mock.asClient}>
                <ShardSwitchDataBrowser pageSize={10} />
            </LunoraProvider>,
        );

        fireEvent.click(await screen.findByTestId("db-table-inbox"));
        await screen.findByText("alpha-hello");

        fireEvent.click(screen.getByTestId("apply-shard-switch"));
        await screen.findByText("beta-world");

        // Select and delete the new table's row as soon as it's on screen — the
        // earliest an operator could possibly click after the switch.
        fireEvent.click(screen.getByTestId("db-select-all"));
        await screen.findByTestId("grid-selection-count");

        fireEvent.click(screen.getByTestId("grid-selection-delete"));
        fireEvent.click(screen.getByTestId("grid-selection-delete-confirm"));

        await waitFor(() => {
            const deletes = mock.query.mock.calls.filter(
                (call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow && (call[1] as { op: string }).op === "delete",
            );

            if (deletes.length === 0) {
                throw new Error("delete not issued yet");
            }
        });

        const deletes = mock.query.mock.calls.filter((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow && (call[1] as { op: string }).op === "delete");

        // Every delete targets the NEW shard ("s2") — the old code's own comment
        // claimed this couldn't happen, and it could: the debounced shard used to
        // lag the table-derived selection by up to 400ms.
        expect(deletes.every((call) => (call[2] as { shardKey?: string } | undefined)?.shardKey === "s2")).toBe(true);
    });
});

// Mirrors `MAX_BULK_DELETE_BATCHES` in `use-data-browser.tsx` (not exported —
// this test drives the client-side loop-exhaustion path directly).
const MAX_BULK_DELETE_BATCHES = 200;

/**
 * A `messages` table pre-loaded with more matching rows than
 * `MAX_BULK_DELETE_BATCHES × bulkCap` can drain in one bulk-delete run, so the
 * client's own batch loop runs out before the server ever reports
 * `hasMore: false` — exercising the STUDIO-02 truncation path, distinct from
 * `createFilterableClient`'s ordinary (server-completes) multi-batch drain.
 */
const createCapExhaustingClient = (rowCount: number, bulkCap: number): MockClientHooks => {
    let rows = Array.from({ length: rowCount }, (_, index) => {
        return { __id__: `m${index.toString()}`, status: "active", text: `row-${index.toString()}` };
    });

    return createMockClient({
        query: (reference, args): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return [{ name: "messages", rowCount: rows.length }];
            }

            if (reference === ADMIN_FUNCTIONS.deleteRows) {
                const batch = rows.slice(0, bulkCap);
                const doomed = new Set(batch.map((row) => row["__id__"]));

                rows = rows.filter((row) => !doomed.has(row["__id__"]));

                return { deleted: batch.length, hasMore: rows.length > 0 };
            }

            const { limit = 50, offset = 0, table } = args as { limit?: number; offset?: number; table: string };

            if (table !== "messages") {
                throw new Error(`unknown table: ${table}`);
            }

            return { columns: ["__id__", "status", "text"], rows: rows.slice(offset, offset + limit), total: rows.length };
        },
    });
};

describe("dataBrowser — bulk delete cap exhaustion (STUDIO-02)", () => {
    it("surfaces a truncation message when the client's batch cap is hit before the server reports done", async () => {
        expect.assertions(3);

        // 205 matching rows, capped at 1 row/call → needs 205 round-trips to
        // finish; the client stops itself at 200.
        const mock = createCapExhaustingClient(MAX_BULK_DELETE_BATCHES + 5, 1);

        render(renderBrowser(mock, { editable: true, pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-page");

        fireEvent.click(screen.getByTestId("db-add-filter"));
        fireEvent.change(await screen.findByTestId("db-filter-column"), { target: { value: "status" } });
        fireEvent.change(await screen.findByTestId("db-filter-value"), { target: { value: "active" } });

        await waitFor(() => {
            if (screen.queryAllByTestId("db-row").length === 0) {
                throw new Error("filter not applied yet");
            }
        });

        fireEvent.click(screen.getByTestId("db-bulk-delete"));
        fireEvent.click(screen.getByTestId("db-bulk-delete-confirm"));

        const errorElement = await screen.findByTestId("db-write-error");

        expect(errorElement.textContent).toBe("Stopped after 200 batches — rows still match this delete. Run it again to remove the rest.");

        const bulk = mock.query.mock.calls.filter((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.deleteRows);

        expect(bulk).toHaveLength(MAX_BULK_DELETE_BATCHES);

        // 205 rows − 200×1 deleted = 5 left; the refetch this triggers shows them
        // rather than a page that quietly still looks "done".
        await waitFor(() => {
            if (screen.getAllByTestId("db-row").length !== 5) {
                throw new Error("page not refetched yet");
            }
        });

        expect(screen.getAllByTestId("db-row")).toHaveLength(5);
    });

    it("still reports clean success (no writeError) when the delete finishes under the cap", async () => {
        expect.assertions(1);

        const mock = createFilterableClient(1);

        render(renderBrowser(mock, { editable: true, pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-page");

        fireEvent.click(screen.getByTestId("db-add-filter"));
        fireEvent.change(await screen.findByTestId("db-filter-column"), { target: { value: "status" } });
        fireEvent.change(await screen.findByTestId("db-filter-value"), { target: { value: "active" } });

        await waitFor(() => {
            if (screen.getAllByTestId("db-row").length !== 2) {
                throw new Error("filter not applied yet");
            }
        });

        fireEvent.click(screen.getByTestId("db-bulk-delete"));
        fireEvent.click(screen.getByTestId("db-bulk-delete-confirm"));

        await waitFor(() => {
            if (screen.queryAllByTestId("db-row").length > 0) {
                throw new Error("rows not deleted yet");
            }
        });

        expect(screen.queryByTestId("db-write-error")).toBeNull();
    });
});
