import { CirrusProvider } from "@cirrus/react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { ADMIN_FUNCTIONS } from "../src/admin";
import type { DataBrowserProps } from "../src/data-browser";
import { DataBrowser } from "../src/data-browser";
import type { MockClientHooks } from "./mock-client";
import { createMockClient } from "./mock-client";

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

            const { limit = 50, offset = 0, search = "", table } = args as PageArgs;

            if (table !== "messages") {
                throw new Error(`unknown table: ${table}`);
            }

            // Mirror the server's whole-table substring filter across all cells.
            const needle = search.trim().toLowerCase();
            const matched =
                needle === "" ? MESSAGE_ROWS : MESSAGE_ROWS.filter((row) => Object.values(row).some((value) => value.toLowerCase().includes(needle)));

            return { columns: ["__id__", "text"], rows: matched.slice(offset, offset + limit), total: matched.length };
        },
    });

const renderBrowser = (mock: MockClientHooks, props: DataBrowserProps = {}): ReactElement => (
    <CirrusProvider client={mock.asClient}>
        <DataBrowser editable={props.editable} initialShardKey={props.initialShardKey} pageSize={props.pageSize} />
    </CirrusProvider>
);

describe("dataBrowser", () => {
    it("lists tables with row counts on mount", async () => {
        expect.assertions(2);

        const mock = createBrowserClient();

        render(renderBrowser(mock));

        await screen.findByTestId("db-table-list");

        expect(screen.getByTestId("db-table-messages").textContent).toBe("messages (3)");
        expect(screen.getByTestId("db-table-users").textContent).toBe("users (1)");
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

    it("forwards the shard key when reloading tables", async () => {
        expect.assertions(1);

        const mock = createBrowserClient();

        render(renderBrowser(mock));

        await screen.findByTestId("db-table-list");

        fireEvent.change(screen.getByTestId("db-shard-input"), { target: { value: "room-9" } });
        fireEvent.click(screen.getByTestId("db-load-tables"));

        await waitFor(() => {
            if (mock.query.mock.calls.length <= 1) {
                throw new Error("tables not reloaded yet");
            }
        });

        const listCalls = mock.query.mock.calls.filter((call) => (call[0] as { __cirrusRef: string }).__cirrusRef === ADMIN_FUNCTIONS.listTables);
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
        expect(screen.queryByTestId("db-table-list")).toBeNull();
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
    const rowTexts = (): string[] => screen.getAllByTestId("db-row").map((row) => within(row).getAllByRole("cell")[1]?.textContent ?? "");

    it("sorts a column ascending then descending on repeated clicks", async () => {
        expect.assertions(3);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-rows");

        // Unsorted: rows arrive in page (document) order.
        expect(rowTexts()).toEqual(["hello", "world", "again"]);

        // First click sorts ascending by the `text` column.
        fireEvent.click(screen.getByTestId("db-sort-text"));

        expect(rowTexts()).toEqual(["again", "hello", "world"]);

        // Second click flips to descending.
        fireEvent.click(screen.getByTestId("db-sort-text"));

        expect(rowTexts()).toEqual(["world", "hello", "again"]);
    });

    it("clears the sort on the third click", async () => {
        expect.assertions(2);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-rows");

        fireEvent.click(screen.getByTestId("db-sort-text"));

        expect(rowTexts()).toEqual(["again", "hello", "world"]);

        // asc -> desc -> unsorted restores document order.
        fireEvent.click(screen.getByTestId("db-sort-text"));
        fireEvent.click(screen.getByTestId("db-sort-text"));

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

        const searchCall = mock.query.mock.calls.findLast((call) => (call[0] as { __cirrusRef: string }).__cirrusRef === ADMIN_FUNCTIONS.readTablePage) as [
            unknown,
            { offset: number; search: string },
            unknown,
        ];

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

        fireEvent.click(screen.getByTestId("db-sort-text"));

        expect(rowTexts()).toEqual(["hello", "world"]);
    });

    it("re-fetches from the server when searching, but not when sorting", async () => {
        expect.assertions(2);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-rows");

        const pageCalls = (): number =>
            mock.query.mock.calls.filter((call) => (call[0] as { __cirrusRef: string }).__cirrusRef === ADMIN_FUNCTIONS.readTablePage).length;

        // Sorting is page-local — no server round-trip.
        const beforeSort = pageCalls();

        fireEvent.click(screen.getByTestId("db-sort-text"));

        expect(pageCalls()).toBe(beforeSort);

        // Searching IS server-side — it re-fetches (whole-table filter).
        fireEvent.change(screen.getByTestId("db-filter"), { target: { value: "or" } });

        await waitFor(() => {
            if (pageCalls() <= beforeSort) {
                throw new Error("search did not refetch yet");
            }
        });

        expect(pageCalls()).toBeGreaterThan(beforeSort);
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
        render(
            <CirrusProvider client={mock.asClient}>
                <DataBrowser editable pageSize={2} />
            </CirrusProvider>,
        );

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-page");
    };

    it("hides edit controls unless `editable` is set", async () => {
        expect.assertions(2);

        const mock = createBrowserClient();

        render(
            <CirrusProvider client={mock.asClient}>
                <DataBrowser pageSize={2} />
            </CirrusProvider>,
        );

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
            if (!mock.query.mock.calls.some((c) => c[0].__cirrusRef === ADMIN_FUNCTIONS.writeRow)) {
                throw new Error("writeRow not called yet");
            }
        });

        const call = mock.query.mock.calls.find((c) => c[0].__cirrusRef === ADMIN_FUNCTIONS.writeRow) as [unknown, Record<string, unknown>, unknown];

        expect(call[1]).toMatchObject({ id: "m1", op: "delete", table: "messages" });
    });

    it("inserts a new row from the editor", async () => {
        expect.assertions(1);

        const mock = createEditableClient();

        await openMessages(mock);

        fireEvent.click(screen.getByTestId("db-add-row"));
        fireEvent.change(screen.getByTestId("db-editor-doc"), { target: { value: '{ "text": "fresh" }' } });
        fireEvent.click(screen.getByTestId("db-editor-save"));

        await waitFor(() => {
            if (!mock.query.mock.calls.some((c) => c[0].__cirrusRef === ADMIN_FUNCTIONS.writeRow)) {
                throw new Error("writeRow not called yet");
            }
        });

        const call = mock.query.mock.calls.find((c) => c[0].__cirrusRef === ADMIN_FUNCTIONS.writeRow) as [unknown, Record<string, unknown>, unknown];

        expect(call[1]).toMatchObject({ doc: { text: "fresh" }, op: "insert", table: "messages" });
    });

    it("reports invalid JSON without calling the server", async () => {
        expect.assertions(2);

        const mock = createEditableClient();

        await openMessages(mock);

        fireEvent.click(screen.getByTestId("db-add-row"));
        fireEvent.change(screen.getByTestId("db-editor-doc"), { target: { value: "{ not json" } });
        fireEvent.click(screen.getByTestId("db-editor-save"));

        const writeError = await screen.findByTestId("db-write-error");

        expect(writeError.textContent).toContain("Invalid JSON");
        expect(mock.query.mock.calls.some((c) => c[0].__cirrusRef === ADMIN_FUNCTIONS.writeRow)).toBe(false);
    });

    it("edits an existing row (patch) prefilled from its doc", async () => {
        expect.assertions(2);

        const mock = createEditableClient();

        await openMessages(mock);

        fireEvent.click(screen.getByTestId("db-edit-m1"));

        // The editor prefills the row's editable fields (id/meta stripped).
        const editor = screen.getByTestId<HTMLTextAreaElement>("db-editor-doc");

        expect(JSON.parse(editor.value)).toEqual({ text: "hello" });

        fireEvent.change(editor, { target: { value: '{ "text": "edited" }' } });
        fireEvent.click(screen.getByTestId("db-editor-save"));

        await waitFor(() => {
            if (!mock.query.mock.calls.some((c) => c[0].__cirrusRef === ADMIN_FUNCTIONS.writeRow)) {
                throw new Error("writeRow not called yet");
            }
        });

        const call = mock.query.mock.calls.find((c) => c[0].__cirrusRef === ADMIN_FUNCTIONS.writeRow) as [unknown, Record<string, unknown>, unknown];

        expect(call[1]).toMatchObject({ doc: { text: "edited" }, id: "m1", op: "patch", table: "messages" });
    });

    it("edits the right row while a filter and sort are active", async () => {
        expect.assertions(2);

        const mock = createEditableClient();

        render(
            <CirrusProvider client={mock.asClient}>
                <DataBrowser editable pageSize={10} />
            </CirrusProvider>,
        );

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-rows");

        // Sort descending and search to a single row — `world` is m2 in the fixture.
        fireEvent.click(screen.getByTestId("db-sort-text"));
        fireEvent.click(screen.getByTestId("db-sort-text"));
        fireEvent.change(screen.getByTestId("db-filter"), { target: { value: "world" } });

        // Wait for the debounced server search to narrow the page to just m2.
        await waitFor(() => {
            if (screen.getAllByTestId("db-row").length !== 1) {
                throw new Error("search not applied yet");
            }
        });

        // The editor prefills from the ORIGINAL row, not a sorted/filtered copy.
        fireEvent.click(screen.getByTestId("db-edit-m2"));

        const editor = screen.getByTestId<HTMLTextAreaElement>("db-editor-doc");

        expect(JSON.parse(editor.value)).toEqual({ text: "world" });

        fireEvent.change(editor, { target: { value: '{ "text": "patched" }' } });
        fireEvent.click(screen.getByTestId("db-editor-save"));

        await waitFor(() => {
            if (!mock.query.mock.calls.some((c) => c[0].__cirrusRef === ADMIN_FUNCTIONS.writeRow)) {
                throw new Error("writeRow not called yet");
            }
        });

        const call = mock.query.mock.calls.find((c) => c[0].__cirrusRef === ADMIN_FUNCTIONS.writeRow) as [unknown, Record<string, unknown>, unknown];

        expect(call[1]).toMatchObject({ doc: { text: "patched" }, id: "m2", op: "patch", table: "messages" });
    });

    it("toggling Live subscribes to readTablePage and renders pushed rows", async () => {
        expect.assertions(2);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 2 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-page");

        fireEvent.click(screen.getByTestId("db-live"));

        // Live opens both a readTablePage and a listTables subscription; assert
        // the page one is among them (order isn't contractual).
        const references = mock.subscribe.mock.calls.map((call) => (call[0] as { __cirrusRef: string }).__cirrusRef);

        expect(references).toContain(ADMIN_FUNCTIONS.readTablePage);

        act(() => {
            mock.emit(ADMIN_FUNCTIONS.readTablePage, { columns: ["__id__", "text"], rows: [{ __id__: "m9", text: "LIVE ROW" }], total: 1 });
        });

        expect(screen.getByTestId("db-page").textContent).toContain("LIVE ROW");
    });

    it("keeps the live subscription bound to the loaded page, ignoring shard-input keystrokes", async () => {
        expect.assertions(1);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 2 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-page");
        fireEvent.click(screen.getByTestId("db-live"));

        const callsAfterToggle = mock.subscribe.mock.calls.length;

        // Typing into the shard-key input changes `shardKey` state but not the
        // loaded page descriptor, so the live channel must NOT tear down and
        // re-subscribe per keystroke to shards that were never loaded.
        fireEvent.change(screen.getByTestId("db-shard-input"), { target: { value: "tenant-7" } });

        expect(mock.subscribe).toHaveBeenCalledTimes(callsAfterToggle);
    });

    it("live pushes a refreshed table list (new tables appear without a reload)", async () => {
        expect.assertions(2);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 2 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-page");
        fireEvent.click(screen.getByTestId("db-live"));

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
        fireEvent.change(screen.getByTestId("db-filter-column"), { target: { value: "status" } });
        fireEvent.change(screen.getByTestId("db-filter-value"), { target: { value: "archived" } });

        await waitFor(() => {
            if (screen.getAllByTestId("db-row").length !== 1) {
                throw new Error("filter not applied yet");
            }
        });

        const lastRead = mock.query.mock.calls.findLast((call) => call[0].__cirrusRef === ADMIN_FUNCTIONS.readTablePage);

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
        fireEvent.change(screen.getByTestId("db-filter-column"), { target: { value: "status" } });
        fireEvent.change(screen.getByTestId("db-filter-value"), { target: { value: "active" } });

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
        const bulk = mock.query.mock.calls.filter((call) => call[0].__cirrusRef === ADMIN_FUNCTIONS.deleteRows);
        const perRow = mock.query.mock.calls.filter((call) => call[0].__cirrusRef === ADMIN_FUNCTIONS.writeRow);

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
        fireEvent.change(screen.getByTestId("db-filter-column"), { target: { value: "status" } });
        fireEvent.change(screen.getByTestId("db-filter-value"), { target: { value: "active" } });

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

        const bulk = mock.query.mock.calls.filter((call) => call[0].__cirrusRef === ADMIN_FUNCTIONS.deleteRows);

        // Two bounded round-trips (cap=1, two matches), then a third that reports
        // hasMore=false stops the loop — so at least two, capped by the loop.
        expect(bulk.length).toBeGreaterThanOrEqual(2);
        expect(mock.query.mock.calls.some((call) => call[0].__cirrusRef === ADMIN_FUNCTIONS.writeRow)).toBe(false);
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

        const clears = mock.query.mock.calls.filter((call) => call[0].__cirrusRef === ADMIN_FUNCTIONS.clearTable);

        expect(clears).toHaveLength(1);
        expect((clears[0]?.[1] as { table: string }).table).toBe("messages");
    });
});
