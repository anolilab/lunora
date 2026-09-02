import { LunoraProvider } from "@lunora/react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

// Bundler-inlined shared helper (see CLAUDE.md `shared/` rules) — the same codec
// the shard writer stores `__doc__` with, so the test asserts against the real
// stored form rather than a hand-written copy of it.
import { encodeWire } from "../../../../../shared/wire-codec";
import type { DataBrowserProps } from "../../../src/features/data/data-browser";
import { DataBrowser } from "../../../src/features/data/data-browser";
import useMirroredRef from "../../../src/hooks/use-mirrored-ref";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import { dataViewToSearch, searchToDataView } from "../../../src/lib/data-view-params";
import type { DataView } from "../../../src/lib/saved-queries";
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

/**
 * Type into the table's search box.
 *
 * The toolbar is not in the DOM the instant the first row paints, so a
 * synchronous `getByTestId` here is a race that only loses on a loaded runner —
 * which is exactly how it failed in CI and never locally.
 */
const typeFilter = async (value: string): Promise<void> => {
    fireEvent.change(await screen.findByTestId("db-filter"), { target: { value } });
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

        await typeFilter("WOR");

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
        await typeFilter("o");

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

    /** Fire a clipboard paste carrying `text` at the grid's scroll container. */
    const pasteIntoGrid = (text: string): void => {
        fireEvent.paste(screen.getByTestId("db-scroll"), { clipboardData: { getData: () => text } });
    };

    it("stages a pasted TSV block and reports the cells it skipped", async () => {
        expect.assertions(3);

        await openMessages(createEditableClient());

        // The focus anchor defaults to the first cell, which is the primary key —
        // so each line's first value lands on a column nothing may write.
        pasteIntoGrid("ignored\tfirst\nignored\tsecond");

        const staged = await screen.findByTestId("db-staged-list");

        expect(within(staged).getAllByRole("listitem")).toHaveLength(2);
        expect(staged.textContent).toContain("second");
        // Reported, not silent: a paste that quietly dropped half its block would
        // read as a clean apply.
        expect(screen.getByTestId("db-paste-skipped").textContent).toContain("2");
    });

    it("judges a pasted value against the DECLARED column, not the cell's current value", async () => {
        expect.assertions(2);

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return [{ name: "posts", rowCount: 2 }];
                }

                if (reference === ADMIN_FUNCTIONS.describeTables) {
                    return {
                        columnsByTable: {
                            posts: [
                                { name: "views", optional: false, type: "number" },
                                { enumValues: ["draft", "published"], name: "status", optional: false, type: "union" },
                            ],
                        },
                    };
                }

                return {
                    columns: ["__id__", "views", "status"],
                    // `views` is NULL on both rows: judging by the value would read
                    // "no type at all" and wave anything through.
                    rows: [
                        { __id__: "p1", status: "draft", views: null },
                        { __id__: "p2", status: "draft", views: null },
                    ],
                    total: 2,
                };
            },
        });

        render(renderBrowser(mock, { editable: true, pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-posts"));
        await screen.findByTestId("db-page");

        // The anchor defaults to the first column, the primary key, so each line
        // leads with a value nothing may write.
        pasteIntoGrid("ignored\tn/a\tarchived\nignored\t7\tpublished");

        const staged = await screen.findByTestId("db-staged-list");

        // Only `7` (fits the declared number) and `published` (a declared union
        // member) survive; `n/a` and `archived` do not, and neither does either
        // primary-key cell.
        expect(within(staged).getAllByRole("listitem")).toHaveLength(2);
        expect(screen.getByTestId("db-paste-skipped").textContent).toContain("4");
    });

    it("anchors a paste at the cell the operator clicked", async () => {
        expect.assertions(1);

        const mock = createEditableClient();

        await openMessages(mock);

        // Click the `text` cell of the second row, then paste one value. Before
        // this, `active` was written only by the arrow keys, so a pointer-selected
        // cell was ignored and the block landed at the top-left of the page.
        fireEvent.pointerDown(screen.getAllByTestId("db-expand-text")[1] as HTMLElement);
        pasteIntoGrid("clicked");

        const staged = await screen.findByTestId("db-staged-list");

        expect(staged.textContent).toContain("clicked");
    });

    it("refuses a pasted value that does not fit a numeric column", async () => {
        expect.assertions(2);

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return [{ name: "scores", rowCount: 2 }];
                }

                return {
                    columns: ["__id__", "points"],
                    rows: [
                        { __id__: "s1", points: 1 },
                        { __id__: "s2", points: 2 },
                    ],
                    total: 2,
                };
            },
        });

        render(renderBrowser(mock, { editable: true, pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-scores"));
        await screen.findByTestId("db-page");

        pasteIntoGrid("ignored\t7\nignored\tn/a");

        const staged = await screen.findByTestId("db-staged-list");

        // The parseable one stages; "n/a" does not become the string "n/a" in a
        // numeric column, which is what a plain inline edit would have allowed.
        expect(within(staged).getAllByRole("listitem")).toHaveLength(1);
        expect(screen.getByTestId("db-paste-skipped").textContent).toContain("3");
    });

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
        // The cascade-impact preview IS the confirmation step for a row delete.
        fireEvent.click(await screen.findByTestId("cascade-confirm"));

        await waitFor(() => {
            if (!mock.query.mock.calls.some((c) => c[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow)) {
                throw new Error("writeRow not called yet");
            }
        });

        const call = mock.query.mock.calls.find((c) => c[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow) as [unknown, Record<string, unknown>, unknown];

        expect(call[1]).toMatchObject({ id: "m1", op: "delete", table: "messages" });
    });

    it("shows the cascade-impact preview before deleting, and deletes nothing until it is confirmed", async () => {
        expect.assertions(2);

        const mock = createEditableClient();

        await openMessages(mock);

        fireEvent.click(screen.getByTestId("db-delete-m1"));

        // The preview opens instead of the delete running: an operator must see
        // which related rows go with the row before the write is issued.
        await expect(screen.findByTestId("cascade-panel")).resolves.not.toBeNull();
        expect(mock.query.mock.calls.some((c) => c[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow)).toBe(false);
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

    it("renders a declared string-literal union as a dropdown, and a null boolean as a tri-state", async () => {
        expect.assertions(5);

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return [{ name: "posts", rowCount: 1 }];
                }

                if (reference === ADMIN_FUNCTIONS.describeTables) {
                    return {
                        columnsByTable: {
                            posts: [
                                { enumValues: ["draft", "published"], name: "status", optional: false, type: "union" },
                                { name: "pinned", optional: true, type: "boolean" },
                            ],
                        },
                    };
                }

                if (reference === ADMIN_FUNCTIONS.writeRow) {
                    return { id: "p1", op: "patch" };
                }

                return { columns: ["__id__", "status", "pinned"], rows: [{ __id__: "p1", pinned: null, status: "draft" }], total: 1 };
            },
        });

        render(renderBrowser(mock, { editable: true, pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-posts"));
        await screen.findByTestId("db-page");

        fireEvent.click(screen.getByTestId("db-edit-p1"));

        const status = await screen.findByTestId<HTMLSelectElement>("db-field-status");

        // Before this the widget came from the VALUE, so a literal union was a
        // free-text box and a null boolean was a free-text box too.
        expect(status.tagName).toBe("SELECT");
        expect([...status.options].map((option) => option.value)).toStrictEqual(["draft", "published"]);

        // A checkbox has two states and this column has three. The row holds
        // `null`, which a checkbox renders as unchecked — indistinguishable from
        // a stored `false`, and with no way back to `null` once ticked. This
        // assertion used to demand that checkbox.
        const pinned = screen.getByTestId<HTMLSelectElement>("db-field-pinned");

        expect(pinned.tagName).toBe("SELECT");
        expect([...pinned.options].map((option) => option.value)).toStrictEqual(["\u0000clear", "true", "false"]);

        fireEvent.change(status, { target: { value: "published" } });
        fireEvent.click(screen.getByTestId("db-editor-save"));

        await waitFor(() => {
            if (!mock.query.mock.calls.some((c) => c[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow)) {
                throw new Error("writeRow not called yet");
            }
        });

        const call = mock.query.mock.calls.find((c) => c[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow) as [unknown, Record<string, unknown>, unknown];

        expect((call[1] as { doc: Record<string, unknown> }).doc).toMatchObject({ status: "published" });
    });

    it("marks each header with its declared type, and leaves an undescribed column bare", async () => {
        expect.assertions(3);

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return [{ name: "posts", rowCount: 1 }];
                }

                if (reference === ADMIN_FUNCTIONS.describeTables) {
                    return {
                        columnsByTable: {
                            posts: [
                                { name: "title", optional: false, type: "string" },
                                { name: "views", optional: false, type: "number" },
                            ],
                        },
                    };
                }

                return { columns: ["__id__", "title", "views"], rows: [{ __id__: "p1", title: "hi", views: 3 }], total: 1 };
            },
        });

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-posts"));
        await screen.findByTestId("db-rows");

        expect(screen.getByTestId("db-type-title").textContent).toBe("T");
        expect(screen.getByTestId("db-type-views").textContent).toBe("#");
        // `__id__` is a page column the schema does not describe — a glyph there
        // would be an assertion about a type nobody declared.
        expect(screen.queryByTestId("db-type-__id__")).toBeNull();
    });

    it("keeps a stored value the union no longer declares, rather than rewriting it", async () => {
        expect.assertions(2);

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return [{ name: "posts", rowCount: 1 }];
                }

                if (reference === ADMIN_FUNCTIONS.describeTables) {
                    return { columnsByTable: { posts: [{ enumValues: ["draft", "published"], name: "status", optional: false, type: "union" }] } };
                }

                return { columns: ["__id__", "status"], rows: [{ __id__: "p1", status: "archived" }], total: 1 };
            },
        });

        render(renderBrowser(mock, { editable: true, pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-posts"));
        await screen.findByTestId("db-page");

        fireEvent.click(screen.getByTestId("db-edit-p1"));

        const status = await screen.findByTestId<HTMLSelectElement>("db-field-status");

        // A row written before the union changed keeps what it holds; a dropdown
        // that silently snapped it to the first option would edit a field nobody
        // touched.
        expect(status.value).toBe("archived");
        expect([...status.options].map((option) => option.value)).toContain("archived");
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

    it("drops each row from the staged buffer as its own patch lands, so a mid-batch failure leaves only the unwritten ones", async () => {
        expect.assertions(3);

        // The writer commits per row, so a failure on row k has ALREADY written
        // rows 1..k-1. Clearing the buffer only after the loop never ran on that
        // path, and the panel went on showing an old→new diff for changes that
        // were already on disk.
        const mock = createMockClient({
            query: (reference, args): unknown => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return TABLES;
                }

                if (reference === ADMIN_FUNCTIONS.writeRow) {
                    const { id, op } = args as { id?: string; op: string };

                    if (id === "m2") {
                        throw new Error("row write failed");
                    }

                    return { id: id ?? null, op };
                }

                const { limit = 50, offset = 0 } = args as PageArgs;

                return { columns: ["__id__", "text"], rows: MESSAGE_ROWS.slice(offset, offset + limit), total: MESSAGE_ROWS.length };
            },
        });

        await openMessages(mock);

        // Stage an edit on m1 and on m2 in one paste.
        pasteIntoGrid("ignored\tfirst\nignored\tsecond");

        const before = await screen.findByTestId("db-staged-list");

        expect(within(before).getAllByRole("listitem")).toHaveLength(2);

        fireEvent.click(screen.getByTestId("db-staged-commit"));

        const error = await screen.findByTestId("db-write-error");

        expect(error.textContent).toContain("row write failed");

        // m1's patch landed and left the buffer; only the row that never wrote
        // is still pending.
        await waitFor(() => {
            expect(within(screen.getByTestId("db-staged-list")).getAllByRole("listitem")).toHaveLength(1);
        });
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
        await typeFilter("world");

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
 * (`deleteRows` / `clearTable` / `patchRows`). The bulk ops mirror the server:
 * they match the same `eq`-filter predicate `readTablePage` previews, write in
 * bulk, and report `hasMore` — bounded by `bulkCap` so a test can drive the
 * client's multi-call loop. `patchRows` additionally mirrors the server's keyset
 * cursor, so a client that fails to thread it round-trips forever.
 */
const createFilterableClient = (bulkCap = 50): MockClientHooks => {
    let rows = [
        { __id__: "m1", slug: "a", status: "active", text: "hello" },
        { __id__: "m2", slug: "b", status: "active", text: "world" },
        { __id__: "m3", slug: "c", status: "archived", text: "again" },
    ];

    const matchesFilters = (row: Record<string, unknown>, filters: FilterArg[]): boolean =>
        filters.every((clause) => clause.operator !== "eq" || String(row[clause.column]) === String(clause.value));

    return createMockClient({
        query: (reference, args): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return [{ name: "messages", rowCount: rows.length }];
            }

            if (reference === ADMIN_FUNCTIONS.listTablesIndexes) {
                // `slug` carries a single-column unique index; `status` and `text` carry none.
                return { indexesByTable: { messages: [{ fields: ["slug"], name: "bySlug", type: "index", unique: true }] } };
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

                return { count: batch.length, hasMore: matched.length > bulkCap };
            }

            if (reference === ADMIN_FUNCTIONS.patchRows) {
                const { after, doc = {}, filters = [] } = args as { after?: string; doc?: Record<string, unknown>; filters?: FilterArg[] };

                // Mirrors the shard EXACTLY on the point that matters: `after`'s
                // PRESENCE is what makes the scan ordered, and only an ordered scan
                // answers with a cursor. Treating a missing cursor as "start from the
                // top, ordered" — which both mocks used to do — is precisely how a
                // client that never sends its opening `""` looks identical to one that
                // does, and it hid a silent partial-write bug.
                const keyset = after !== undefined;
                const matched = rows.filter((row) => matchesFilters(row as Record<string, unknown>, filters)).filter((row) => !keyset || row["__id__"] > after);
                const scanned = keyset ? matched.toSorted((a, b) => (a["__id__"] < b["__id__"] ? -1 : 1)) : matched;
                const batch = scanned.slice(0, bulkCap);
                const touched = new Set(batch.map((row) => row["__id__"]));

                rows = rows.map((row) => (touched.has(row["__id__"]) ? { ...row, ...doc } : row));

                return { count: batch.length, cursor: keyset ? batch.at(-1)?.["__id__"] : undefined, hasMore: matched.length > bulkCap };
            }

            // readTablePage: apply each structured filter (eq only, enough here).
            const { filters = [], limit = 50, offset = 0, table } = args as { filters?: FilterArg[]; limit?: number; offset?: number; table: string };

            if (table !== "messages") {
                throw new Error(`unknown table: ${table}`);
            }

            const matched = rows.filter((row) => matchesFilters(row as Record<string, unknown>, filters));

            return { columns: ["__id__", "slug", "status", "text"], rows: matched.slice(offset, offset + limit), total: matched.length };
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

    it('does not offer "Delete N matching" during the search debounce, when the predicate is still empty', async () => {
        expect.assertions(4);

        // The button used to gate on the RAW search box while `bulkDelete` sent the
        // 300ms-DEBOUNCED mirror. For that window the button was on screen reading
        // "Delete 3 matching" with `search === ""` and no filters — and confirming
        // sent a predicate-free `deleteRows`, i.e. a whole-table truncate, past the
        // separate `Clear all N rows?` confirm the studio puts in front of exactly
        // that operation.
        const mock = createBrowserClient();

        render(renderBrowser(mock, { editable: true, pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-page");

        // Unfiltered: the whole-table action is the one on offer.
        expect(screen.queryByTestId("db-bulk-delete")).toBeNull();
        expect(screen.getByTestId("db-clear-table")).toBeDefined();

        // First keystroke. The debounce has NOT elapsed, so the request would still
        // carry an empty predicate — nothing that deletes by predicate may render.
        fireEvent.change(screen.getByTestId("db-filter"), { target: { value: "h" } });

        expect(screen.queryByTestId("db-bulk-delete")).toBeNull();
        expect(screen.queryByTestId("db-bulk-patch")).toBeNull();
    });

    it('does not offer "Delete N matching" for a filter row that carries no column', async () => {
        expect.assertions(4);

        // `addFilter` seeds the row from `columns[0] ?? ""`, and `columns` is
        // `page?.columns ?? []` — so a page whose columns have not resolved adds a
        // column-less row. `toFilterClauses` DROPS such a row, so the request
        // carries `filters: []` (a whole-table predicate the server refuses) while
        // the button counted raw filter rows and offered "Delete 3 matching".
        const mock = createMockClient({
            query: (reference, args): unknown => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return TABLES;
                }

                const { limit = 50, offset = 0 } = args as PageArgs;

                return { columns: [], rows: MESSAGE_ROWS.slice(offset, offset + limit), total: MESSAGE_ROWS.length };
            },
        });

        render(renderBrowser(mock, { editable: true, pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-page");

        expect(screen.queryByTestId("db-bulk-delete")).toBeNull();

        fireEvent.click(screen.getByTestId("db-add-filter"));
        await screen.findByTestId("db-filter-row");

        expect(screen.queryByTestId("db-bulk-delete")).toBeNull();
        expect(screen.queryByTestId("db-bulk-patch")).toBeNull();
        // The whole-table action stays the one on offer, behind its own confirm.
        expect(screen.getByTestId("db-clear-table")).toBeDefined();
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

    it("bulk-patches every matching row, threading the server's cursor so the loop advances", async () => {
        expect.assertions(4);

        // Cap each server call at one row, so patching the two active rows takes
        // two `patchRows` round-trips. The patch writes `text` while the filter
        // is on `status`, so a patched row STILL matches — only the cursor moves
        // the scan forward. A client that dropped it would re-patch row one until
        // it hit its batch bound and surface the truncation error.
        const mock = createFilterableClient(1);

        render(renderBrowser(mock, { editable: true, pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-page");

        fireEvent.click(screen.getByTestId("db-add-filter"));
        // Each filter edit re-keys the page read; the toolbar (and the filter row
        // with it) unmounts until the new page lands - await each control back.
        fireEvent.change(await screen.findByTestId("db-filter-column"), { target: { value: "status" } });
        fireEvent.change(await screen.findByTestId("db-filter-value"), { target: { value: "active" } });

        await waitFor(() => {
            if (screen.getAllByTestId("db-row").length !== 2) {
                throw new Error("filter not applied yet");
            }
        });

        fireEvent.click(screen.getByTestId("db-bulk-patch"));
        fireEvent.change(await screen.findByTestId("bulk-patch-column"), { target: { value: "text" } });
        // JSON-typed, so the quotes are what make this a string rather than a
        // parse error - the same encoding the row editor uses.
        fireEvent.change(screen.getByTestId("bulk-patch-value"), { target: { value: '"seen"' } });
        fireEvent.click(screen.getByTestId("bulk-patch-apply"));

        await waitFor(() => {
            if (screen.getAllByTestId("db-row").filter((row) => (row.textContent ?? "").includes("seen")).length !== 2) {
                throw new Error("rows not patched yet");
            }
        });

        const bulk = mock.query.mock.calls.filter((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.patchRows);

        // Exactly two: call one patches m1 and reports hasMore, call two patches m2
        // and reports done. A third would mean the loop re-asked after the drain.
        expect(bulk).toHaveLength(2);
        // The opening `after: ""` is the whole contract: without it the server scans
        // unordered and the cursor it returns is an arbitrary id.
        expect(bulk[0]?.[1]).toMatchObject({ after: "", doc: { text: "seen" }, filters: [{ column: "status", operator: "eq", value: "active" }] });
        // The second call resumes from the first call's cursor rather than
        // re-reading from the top.
        expect((bulk[1]?.[1] as { after?: string }).after).toBe("m1");
        // The loop finished on `hasMore: false`, so no truncation notice.
        expect(screen.queryByTestId("db-write-error")).toBeNull();
    });

    it("refuses to set a unique column across more than one matching row", async () => {
        expect.assertions(3);

        const mock = createFilterableClient();

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

        fireEvent.click(screen.getByTestId("db-bulk-patch"));

        // `slug` is uniquely indexed and two rows match: the same value cannot land
        // on both, and the writer would fail PARTWAY — after row one committed.
        fireEvent.change(await screen.findByTestId("bulk-patch-column"), { target: { value: "slug" } });
        fireEvent.change(screen.getByTestId("bulk-patch-value"), { target: { value: '"seen"' } });

        expect(screen.getByTestId("bulk-patch-unique").textContent).toContain("unique index");
        expect(screen.getByTestId<HTMLButtonElement>("bulk-patch-apply").disabled).toBe(true);

        // `status` is not unique, so the same view is writable through it.
        fireEvent.change(screen.getByTestId("bulk-patch-column"), { target: { value: "status" } });

        expect(screen.getByTestId<HTMLButtonElement>("bulk-patch-apply").disabled).toBe(false);
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

    it("previews a v.storage() cell as an image, and leaves an ordinary cell as text", async () => {
        expect.assertions(3);

        const mock = createMockClient({
            query: (reference, args): unknown => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return [{ name: "files", rowCount: 1 }];
                }

                if (reference === ADMIN_FUNCTIONS.describeTables) {
                    return {
                        columnsByTable: {
                            files: [
                                { isStorage: true, name: "avatar", optional: false, type: "storage" },
                                { name: "note", optional: false, type: "string" },
                            ],
                        },
                    };
                }

                const { table } = args as { table: string };

                if (table !== "files") {
                    throw new Error(`unknown table: ${table}`);
                }

                return { columns: ["__id__", "avatar", "note"], rows: [{ __id__: "f1", avatar: "avatars/ada.png", note: "not a key" }], total: 1 };
            },
        });

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-files"));
        await screen.findByTestId("db-rows");

        fireEvent.click(screen.getByTestId("db-expand-avatar"));

        const image = await screen.findByTestId("grid-cell-image");

        expect(image.getAttribute("src")).toBe("https://mock.example/avatars/ada.png?sig=test");
        // The key stays visible under the preview — it is what an operator copies.
        expect(screen.getByTestId("grid-cell-value").textContent).toBe("avatars/ada.png");

        fireEvent.click(screen.getByTestId("grid-cell-close"));
        fireEvent.click(screen.getByTestId("db-expand-note"));
        await screen.findByTestId("grid-cell-value");

        // A plain column is never fetched as an object, whatever its value looks like.
        expect(screen.queryByTestId("grid-cell-image")).toBeNull();
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
        await typeFilter("alpha");
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

// Mirrors `MAX_BULK_BATCHES` in `use-data-browser.tsx` (not exported — this test
// drives the client-side loop-exhaustion path directly).
const MAX_BULK_BATCHES = 200;

/**
 * A `messages` table pre-loaded with more matching rows than
 * `MAX_BULK_BATCHES × bulkCap` can drain in one bulk-delete run, so the
 * client's own batch loop runs out before the server ever reports
 * `hasMore: false` — exercising the STUDIO-02 truncation path, distinct from
 * `createFilterableClient`'s ordinary (server-completes) multi-batch drain.
 */
const createCapExhaustingClient = (rowCount: number, bulkCap: number): MockClientHooks => {
    let rows = Array.from({ length: rowCount }, (_, index) => {
        // Zero-padded: the patch arm below resumes by a LEXICAL `id > after`, exactly
        // as SQLite does, and `m10 < m9` would silently break the keyset walk.
        const id = `m${index.toString().padStart(4, "0")}`;

        return { __id__: id, status: "active", text: `row-${index.toString()}` };
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

                return { count: batch.length, hasMore: rows.length > 0 };
            }

            if (reference === ADMIN_FUNCTIONS.patchRows) {
                // Keyset, and the patch does NOT remove rows from the match set — the
                // shape that makes the cursor load-bearing. Ids sort lexically, so the
                // fixture pads them to a fixed width. A missing `after` is NOT defaulted
                // to `""`: an unordered scan is what the server would really do, and
                // defaulting it away is what let a client bug through unseen.
                const { after, doc = {} } = args as { after?: string; doc?: Record<string, unknown> };
                const keyset = after !== undefined;
                const remaining = keyset ? rows.filter((row) => row["__id__"] > after) : rows;
                const batch = remaining.slice(0, bulkCap);
                const touched = new Set(batch.map((row) => row["__id__"]));

                rows = rows.map((row) => (touched.has(row["__id__"]) ? { ...row, ...doc } : row));

                return { count: batch.length, cursor: keyset ? batch.at(-1)?.["__id__"] : undefined, hasMore: remaining.length > bulkCap };
            }

            const { limit = 50, offset = 0, table } = args as { limit?: number; offset?: number; table: string };

            if (table !== "messages") {
                throw new Error(`unknown table: ${table}`);
            }

            return { columns: ["__id__", "status", "text"], rows: rows.slice(offset, offset + limit), total: rows.length };
        },
    });
};

describe("dataBrowser — bulk patch cap exhaustion and resume", () => {
    /** Filter to the active rows and open the bulk-patch dialog on `text`. */
    const patchTextTo = async (json: string): Promise<void> => {
        fireEvent.click(screen.getByTestId("db-bulk-patch"));
        fireEvent.change(await screen.findByTestId("bulk-patch-column"), { target: { value: "text" } });
        fireEvent.change(screen.getByTestId("bulk-patch-value"), { target: { value: json } });
        fireEvent.click(screen.getByTestId("bulk-patch-apply"));
    };

    const openFilteredTable = async (mock: MockClientHooks): Promise<void> => {
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
    };

    it("resumes from where the capped run stopped instead of rescanning from the top", async () => {
        expect.assertions(3);

        // 205 matching rows, 1 per call → the client stops itself at 200. The patch
        // writes `text` while the filter is on `status`, so every patched row STILL
        // matches: a re-run that restarted from the top would rewrite rows 1..200
        // again and never reach the last five. This is the case the parked cursor
        // exists for, and it is unreachable through the UI without it.
        const mock = createCapExhaustingClient(MAX_BULK_BATCHES + 5, 1);

        await openFilteredTable(mock);
        await patchTextTo('"seen"');

        await screen.findByTestId("db-write-error");

        const firstRun = mock.query.mock.calls.filter((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.patchRows);

        expect(firstRun).toHaveLength(MAX_BULK_BATCHES);

        // Second, identical run: it must open at the cursor the first run parked,
        // not at the empty-string cursor a fresh drain opens with.
        await patchTextTo('"seen"');

        await waitFor(() => {
            const calls = mock.query.mock.calls.filter((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.patchRows);

            if (calls.length <= MAX_BULK_BATCHES) {
                throw new Error("second run has not started");
            }
        });

        const secondRunFirstCall = mock.query.mock.calls.filter((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.patchRows)[MAX_BULK_BATCHES];

        // 200 calls at one row each consumed m0000..m0199, so that is where the
        // parked cursor sits — NOT the "" a fresh drain opens with.
        expect((secondRunFirstCall?.[1] as { after?: string }).after).toBe("m0199");

        // The remaining five get written, and the run reports a clean finish.
        await waitFor(() => {
            if (screen.queryByTestId("db-write-error") !== null) {
                throw new Error("still truncated");
            }
        });

        expect(screen.getByTestId("db-write-notice").textContent).toBe("5 rows written.");
    });
});

describe("dataBrowser — bulk delete cap exhaustion (STUDIO-02)", () => {
    it("surfaces a truncation message when the client's batch cap is hit before the server reports done", async () => {
        expect.assertions(3);

        // 205 matching rows, capped at 1 row/call → needs 205 round-trips to
        // finish; the client stops itself at 200.
        const mock = createCapExhaustingClient(MAX_BULK_BATCHES + 5, 1);

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

        expect(errorElement.textContent).toBe("Stopped after 200 batches — rows still match. Run it again to remove the rest.");

        const bulk = mock.query.mock.calls.filter((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.deleteRows);

        expect(bulk).toHaveLength(MAX_BULK_BATCHES);

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

interface SameTableRow {
    __id__: string;
    category: string;
    text: string;
}

/**
 * Two shard fixtures for the SAME table name (`messages`), so a test can drive
 * a saved-query apply that changes shard/search/filters while the URL's `table`
 * param never changes — the same-table dead spot STUDIO-274 fixes (a
 * `tableParam`-only reset gate can't see this apply, since `tableParam` alone
 * hasn't moved).
 */
const SAME_TABLE_FIXTURES: Record<string, SameTableRow[]> = {
    "": [
        { __id__: "r1", category: "default", text: "hello" },
        { __id__: "r2", category: "default", text: "world" },
    ],
    b: [
        { __id__: "b1", category: "beta", text: "b-row-one" },
        { __id__: "b2", category: "beta", text: "b-row-two" },
    ],
};

const createSameTableClient = (): MockClientHooks =>
    createMockClient({
        query: (reference, args, options): unknown => {
            const shard = (options as { shardKey?: string } | undefined)?.shardKey ?? "";
            const fixture = SAME_TABLE_FIXTURES[shard];

            if (fixture === undefined) {
                throw new Error(`unknown shard: ${shard}`);
            }

            if (reference === ADMIN_FUNCTIONS.listTables) {
                return [{ name: "messages", rowCount: fixture.length }];
            }

            if (reference !== ADMIN_FUNCTIONS.readTablePage) {
                // describeTables / facetColumn / etc — not exercised by these tests.
                return { columns: [], rows: [], total: 0 };
            }

            const {
                filters = [],
                limit = 50,
                offset = 0,
                search = "",
                table,
            } = args as {
                filters?: { column: string; operator: string; value?: unknown }[];
                limit?: number;
                offset?: number;
                search?: string;
                table: string;
            };

            if (table !== "messages") {
                throw new Error(`unknown table: ${table}`);
            }

            const needle = search.trim().toLowerCase();
            let matched = needle === "" ? fixture : fixture.filter((row) => row.text.toLowerCase().includes(needle));

            for (const clause of filters) {
                if (clause.operator === "eq") {
                    matched = matched.filter((row) => row[clause.column as keyof SameTableRow] === clause.value);
                }
            }

            return { columns: ["__id__", "category", "text"], rows: matched.slice(offset, offset + limit), total: matched.length };
        },
    });

/** The saved query STUDIO-274 exercises: same table, new shard/search/filter. */
const SAME_TABLE_SAVED_QUERY: DataView = {
    filters: [{ column: "category", operator: "eq", value: "beta" }],
    orderBy: undefined,
    search: "b-row",
    shard: "b",
    table: "messages",
    tier: "shard",
};

/** The `onViewChange` payload shape — the mirrored view's shard/search/filters/sort. */
type MirroredView = Pick<DataView, "filters" | "orderBy" | "search" | "shard">;

/**
 * A faithful miniature of `table-editor.tsx`'s URL wiring: the view lives in a
 * plain in-memory "URL" object, `onViewChange` mirrors the loaded view back
 * into it (skipping the write when the URL already reflects it — the same
 * `unchanged` short-circuit `table-editor.tsx` uses), and applying a saved
 * query pushes a fresh URL object carrying table + shard + search + filters in
 * ONE update, exactly like `onApplyQuery`. Modeling this precisely (rather than
 * a `ControlledDataBrowser`-style ad hoc host) is what lets these tests exercise
 * the actual regression: a same-table apply that changes shard/search/filters
 * without ever changing `tableParam`.
 */
const MiniTableEditor = ({ onViewChangeCall, pageSize }: { onViewChangeCall?: (view: MirroredView) => void; pageSize?: number }): ReactElement => {
    const [urlSearch, setUrlSearch] = useState<Record<string, unknown>>({ table: "messages" });
    const urlRef = useMirroredRef(urlSearch);
    const view = searchToDataView(urlSearch);

    const onSelectTable = (table: string, options?: { search?: string }): void => {
        setUrlSearch({ search: options?.search, table });
    };

    const onViewChange = (next: MirroredView): void => {
        onViewChangeCall?.(next);

        const patch = dataViewToSearch(next);
        const { current } = urlRef;

        const unchanged =
            (current["filters"] ?? undefined) === patch.filters &&
            (current["order"] ?? undefined) === patch.order &&
            (current["search"] ?? undefined) === patch.search &&
            (current["shard"] ?? undefined) === patch.shard;

        if (unchanged) {
            return;
        }

        setUrlSearch((previous) => {
            return { ...previous, filters: patch.filters, order: patch.order, search: patch.search, shard: patch.shard };
        });
    };

    const applySavedQuery = (): void => {
        const patch = dataViewToSearch(SAME_TABLE_SAVED_QUERY);

        setUrlSearch({ filters: patch.filters, order: patch.order, schema: patch.schema, search: patch.search, shard: patch.shard, table: patch.table });
    };

    return (
        <>
            <button data-testid="apply-saved-query" onClick={applySavedQuery} type="button">
                apply saved query
            </button>
            <DataBrowser
                editable
                initialFilters={view.filters}
                initialOrderBy={view.orderBy}
                initialSearch={view.search}
                initialShardKey={view.shard}
                onSelectTable={onSelectTable}
                onViewChange={onViewChange}
                pageSize={pageSize}
                tableParam={view.table}
            />
        </>
    );
};

describe("dataBrowser — same-table saved-query apply (STUDIO-274)", () => {
    it("re-seeds shard, search, and filters when a saved query names the ALREADY-OPEN table", async () => {
        expect.assertions(2);

        const mock = createSameTableClient();

        render(
            <LunoraProvider client={mock.asClient}>
                <MiniTableEditor pageSize={10} />
            </LunoraProvider>,
        );

        // Mount opens "messages" on the root shard.
        await screen.findByText("hello");

        fireEvent.click(screen.getByTestId("apply-saved-query"));

        // The saved query names shard "b", search "b-row", and an `eq` filter on
        // `category` — all while `table` stays "messages" throughout. Asserted
        // via the cell testids (not `findByText`) because the active search
        // highlights the "b-row" match, splitting the cell's text across
        // `<mark>` spans — `findByText` can't match text split across elements.
        await waitFor(
            () => {
                if (
                    screen.queryByTestId("db-cell-b1-text")?.textContent !== "b-row-one" ||
                    screen.queryByTestId("db-cell-b2-text")?.textContent !== "b-row-two"
                ) {
                    throw new Error("rows not re-seeded to shard b yet");
                }
            },
            { timeout: 3000 },
        );

        expect(screen.getByTestId<HTMLInputElement>("db-shard-input").value).toBe("b");

        const reads = mock.query.mock.calls.filter((call) => (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.readTablePage);
        const lastRead = reads.at(-1) as [unknown, { table: string }, { shardKey?: string } | undefined];

        // The read that produced the rows above already targeted shard "b" — not
        // the root shard the browser opened with.
        expect(lastRead[2]?.shardKey).toBe("b");
    });

    it("mirrors the newly-applied view back to the host, never with the stale pre-apply shard/search", async () => {
        expect.assertions(2);

        const mock = createSameTableClient();
        const onViewChangeCall = vi.fn<(view: MirroredView) => void>();

        render(
            <LunoraProvider client={mock.asClient}>
                <MiniTableEditor onViewChangeCall={onViewChangeCall} pageSize={10} />
            </LunoraProvider>,
        );

        await screen.findByText("hello");

        // Discard the mount-time mirror call(s) — only what happens AFTER the
        // apply matters here.
        onViewChangeCall.mockClear();

        fireEvent.click(screen.getByTestId("apply-saved-query"));

        // See the sibling test above for why this is a testid check, not
        // `findByText("b-row-one")` — the active search highlights the match.
        await waitFor(
            () => {
                if (screen.queryByTestId("db-cell-b1-text")?.textContent !== "b-row-one") {
                    throw new Error("rows not re-seeded to shard b yet");
                }
            },
            { timeout: 3000 },
        );

        // Give the mirror a chance to fire (or, on the pre-fix code, to not).
        await waitFor(
            () => {
                if (onViewChangeCall.mock.calls.length === 0) {
                    throw new Error("view was never mirrored back after the apply");
                }
            },
            { timeout: 3000 },
        );

        // Every post-apply mirror call reflects the NEW view — none regresses to
        // the pre-apply shard ("") or search (undefined), which is the reported
        // "operator watches the just-applied link revert" symptom.
        const revertedToStale = onViewChangeCall.mock.calls.some(([call]) => call.shard !== "b" || call.search !== "b-row");

        expect(revertedToStale).toBe(false);

        // And it did settle on the new view at least once (not just avoid the
        // stale one) — otherwise "never reverts" would be vacuously true.
        const mirroredNewView = onViewChangeCall.mock.calls.some(([call]) => call.shard === "b" && call.search === "b-row");

        expect(mirroredNewView).toBe(true);
    });

    it("never re-seeds on a keystroke, even once the URL mirror echoes it back (contract — holds before AND after the fix)", async () => {
        expect.assertions(2);

        const mock = createSameTableClient();

        render(
            <LunoraProvider client={mock.asClient}>
                <MiniTableEditor pageSize={10} />
            </LunoraProvider>,
        );

        await screen.findByText("hello");

        // Type a search that only matches one of the root shard's rows — the
        // debounced round trip (state → debounce → onViewChange → URL →
        // `initialSearch`) must be a fixed point: it can echo `initialSearch`
        // back without ever resetting what's on screen.
        await typeFilter("hel");

        await waitFor(() => {
            const reads = mock.query.mock.calls.filter(
                (call) =>
                    (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.readTablePage && (call[1] as { search?: string }).search === "hel",
            );

            if (reads.length === 0) {
                throw new Error("debounced search not applied yet");
            }
        });

        // The wait above only proves the read was ISSUED. `keepPreviousData` is
        // off, so between that call and the new page committing the whole page —
        // filter bar included — is unmounted, and a synchronous `getByTestId`
        // here is a race that only loses on a loaded runner. Same reason, and
        // same fix, as the sibling test below.
        const filterInput = await screen.findByTestId<HTMLInputElement>("db-filter");

        // The typed value is still exactly what was typed — never reset by a
        // re-seed reacting to the mirror's own echo of `initialSearch`.
        expect(filterInput.value).toBe("hel");

        const settledCount = mock.query.mock.calls.filter((call) => (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.readTablePage).length;

        // Wait well past every debounce window; a re-seed loop would keep
        // issuing reads (its own reset re-triggers the mirror, which re-seeds
        // again, …). No loop → the read count stays put.
        await act(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 500);
            });
        });

        const laterCount = mock.query.mock.calls.filter((call) => (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.readTablePage).length;

        expect(laterCount).toBe(settledCount);
    });

    it("keeps mirroring — and never reverts a SECOND change — after the URL has already echoed back the first one", async () => {
        expect.assertions(3);

        const mock = createSameTableClient();
        const onViewChangeCall = vi.fn<(view: Pick<DataView, "filters" | "orderBy" | "search" | "shard">) => void>();

        render(
            <LunoraProvider client={mock.asClient}>
                <MiniTableEditor onViewChangeCall={onViewChangeCall} pageSize={10} />
            </LunoraProvider>,
        );

        await screen.findByText("hello");

        // Stage an inline cell edit BEFORE touching the search box — a spurious
        // re-seed (this test's whole point) wipes it via `stagedEdits.clear()`.
        fireEvent.doubleClick(screen.getByTestId("db-cell-r1-text"));

        const cellInput = await screen.findByTestId<HTMLInputElement>("db-cell-input-r1-text");

        fireEvent.change(cellInput, { target: { value: "edited" } });
        fireEvent.keyDown(cellInput, { key: "Enter" });
        await screen.findByTestId("db-staged");

        // First change: type "hel" and let it debounce-settle, mirror, and echo
        // back through `initialSearch` — the exact round trip the same-table
        // gate exists to survive.
        await typeFilter("hel");

        await waitFor(
            () => {
                const reads = mock.query.mock.calls.filter(
                    (call) =>
                        (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.readTablePage && (call[1] as { search?: string }).search === "hel",
                );

                if (reads.length === 0) {
                    throw new Error("first change not applied yet");
                }
            },
            { timeout: 3000 },
        );

        // Give the mirror's echo (onViewChange → host state → back down as
        // `initialSearch`) a moment to actually round-trip before the second edit.
        await waitFor(
            () => {
                if (!onViewChangeCall.mock.calls.some(([view]) => view.search === "hel")) {
                    throw new Error("first change was never mirrored to the host");
                }
            },
            { timeout: 3000 },
        );

        onViewChangeCall.mockClear();

        // Second change: type "hell" — a further, distinct edit made AFTER the
        // first one's echo has already landed as this render's `initialSearch`.
        await typeFilter("hell");

        await waitFor(
            () => {
                const reads = mock.query.mock.calls.filter(
                    (call) =>
                        (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.readTablePage &&
                        (call[1] as { search?: string }).search === "hell",
                );

                if (reads.length === 0) {
                    throw new Error("second change never took effect — the mirror died after the first echo");
                }
            },
            { timeout: 3000 },
        );

        // (a) the host's view reflects the SECOND change — the mirror is still
        // alive, not permanently blocked by a `seededViewKey` that fell behind
        // `incomingViewKey` after the first echo.
        expect(onViewChangeCall.mock.calls.some(([view]) => view.search === "hell")).toBe(true);

        // `keepPreviousData` is off, so the page (and everything inside it,
        // including the filter bar) can briefly disappear between the read
        // landing above and the new page committing — `findByTestId` waits for
        // that to settle rather than racing it.
        const filterInput = await screen.findByTestId<HTMLInputElement>("db-filter");

        // The search box itself must still show what was typed — a spurious
        // re-seed snaps it back to the stale `initialSearch` ("hel").
        expect(filterInput.value).toBe("hell");

        // (b) the staged inline edit survives. A spurious re-seed wipes it via
        // `stagedEdits.clear()` / `setEditingCell(null)`.
        expect(screen.getByTestId("db-staged").textContent).toContain("edited");
    });
});

/**
 * Plan 265 made `v.bigint()` / `v.bytes()` storable by routing `__doc__` through
 * the wire codec, so a decoded row now reaches the browser carrying real
 * `bigint` and `ArrayBuffer` values rather than JSON-safe stand-ins. The JSON
 * editor is the one surface where that is dangerous: `JSON.stringify` throws
 * outright on a bigint and flattens an ArrayBuffer to `{}`, so the prefill has
 * to be the ENCODED document and the save has to decode it back.
 */
describe("dataBrowser — wire-tagged columns in the JSON editor", () => {
    const MONEY_DOC: Record<string, unknown> = { amountMinor: 1000n, blob: new Uint8Array([0, 1, 2]).buffer, note: "ok" };

    /** Exactly what `encodeDocJson` stores for {@link MONEY_DOC} on the shard. */
    const STORED_DOC_JSON = JSON.stringify(encodeWire(MONEY_DOC));

    const createMoneyClient = (): MockClientHooks =>
        createMockClient({
            query: (reference, args): unknown => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return [{ name: "paymentSessions", rowCount: 1 }];
                }

                if (reference === ADMIN_FUNCTIONS.writeRow) {
                    const { id, op } = args as { id?: string; op: string };

                    return { id: id ?? null, op };
                }

                // The server-side expansion already decoded the doc, so the row
                // arrives with real bigint / ArrayBuffer values.
                return { columns: ["__id__", "amountMinor", "blob", "note"], rows: [{ __id__: "s1", ...MONEY_DOC }], total: 1 };
            },
        });

    const openSessions = async (mock: MockClientHooks): Promise<void> => {
        render(
            <LunoraProvider client={mock.asClient}>
                <ControlledDataBrowser editable pageSize={10} />
            </LunoraProvider>,
        );

        fireEvent.click(await screen.findByTestId("db-table-paymentSessions"));
        await screen.findByTestId("db-page");
    };

    it("renders the decoded amount and a byte summary, not a raw tag or an empty object", async () => {
        expect.assertions(2);

        await openSessions(createMoneyClient());

        // `1000`, not `["$lunora.wire$","bigint","1000"]`.
        expect(screen.getByTestId("db-cell-s1-amountMinor").textContent).toBe("1000");
        // A byte summary, not `{}` (what `JSON.stringify` gives an ArrayBuffer).
        expect(screen.getByTestId("db-cell-s1-blob").textContent).toBe("<bytes: 3 B>");
    });

    it("round-trips an untouched save byte-identically to what the shard stored", async () => {
        expect.assertions(3);

        const mock = createMoneyClient();

        await openSessions(mock);

        fireEvent.click(screen.getByTestId("db-edit-s1"));
        fireEvent.click(screen.getByTestId("db-editor-json"));

        // The editor is seeded with the stored (encoded) form — the only text
        // that can express a bigint and survive `JSON.parse` on the way back.
        const editor = screen.getByTestId<HTMLTextAreaElement>("db-editor-doc");

        expect(JSON.parse(editor.value)).toEqual(JSON.parse(STORED_DOC_JSON));

        // Save without editing a character.
        fireEvent.click(screen.getByTestId("db-editor-save"));

        await waitFor(() => {
            if (!mock.query.mock.calls.some((call) => (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.writeRow)) {
                throw new Error("writeRow not called yet");
            }
        });

        const write = mock.query.mock.calls.find((call) => (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.writeRow) as [
            unknown,
            { doc: Record<string, unknown> },
            unknown,
        ];

        // A real bigint reaches the writer — a `v.bigint()` validator rejects
        // anything else, and a number would silently lose precision.
        expect(write[1].doc["amountMinor"]).toBe(1000n);

        // The byte-identity the plan turns on: re-encoding what we sent yields
        // exactly the string the shard had stored, so an untouched save is a
        // no-op on disk rather than a silent migration of the row.
        expect(JSON.stringify(encodeWire(write[1].doc))).toBe(STORED_DOC_JSON);
    });

    // Valid JSON that is not a DOCUMENT. `[1,2]` was always rejectable by the
    // old `!Array.isArray` check, but a root-level tag parses as an array and
    // DECODES to a Uint8Array/Date — neither an array nor null — so an
    // array-only check would let it through and the writer would persist junk
    // fields. The guard is by prototype, so both are refused before the write.
    it.each([
        ["a bare array", "[1, 2, 3]"],
        ["a root-level bytes tag", '["$lunora.wire$", "bytes", "AAEC", "ArrayBuffer"]'],
        ["a root-level date tag", '["$lunora.wire$", "date", 0]'],
    ])("refuses to write %s as a document", async (_label, text) => {
        expect.assertions(2);

        const mock = createMoneyClient();

        await openSessions(mock);

        fireEvent.click(screen.getByTestId("db-edit-s1"));
        fireEvent.click(screen.getByTestId("db-editor-json"));
        fireEvent.change(screen.getByTestId("db-editor-doc"), { target: { value: text } });
        fireEvent.click(screen.getByTestId("db-editor-save"));

        const writeError = await screen.findByTestId("db-write-error");

        expect(writeError.textContent).toContain("must be a JSON object");
        expect(mock.query.mock.calls.some((call) => (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.writeRow)).toBe(false);
    });

    it("leaves a plain-JSON row's editor text unchanged", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: (reference): unknown =>
                reference === ADMIN_FUNCTIONS.listTables ? TABLES : { columns: ["__id__", "text"], rows: [{ __id__: "m1", text: "hello" }], total: 1 },
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <ControlledDataBrowser editable pageSize={10} />
            </LunoraProvider>,
        );

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await screen.findByTestId("db-page");

        fireEvent.click(screen.getByTestId("db-edit-m1"));
        fireEvent.click(screen.getByTestId("db-editor-json"));

        // No tagged leaves → the encode is identity, so the editor shows the
        // same plain document it always did.
        expect(JSON.parse(screen.getByTestId<HTMLTextAreaElement>("db-editor-doc").value)).toEqual({ text: "hello" });
    });
});
