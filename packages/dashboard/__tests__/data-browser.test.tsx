import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, test } from "vitest";

import { ADMIN_FUNCTIONS } from "../src/admin.js";
import { DataBrowser, type DataBrowserProps } from "../src/data-browser.js";
import { createMockClient, type MockClientHooks } from "./mock-client.js";

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
    table: string;
}

/** A client whose admin queries serve a fixed in-memory `messages` table. */
const createBrowserClient = (): MockClientHooks =>
    createMockClient({
        query: (reference, args): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return TABLES;
            }

            const { limit = 50, offset = 0, table } = args as PageArgs;

            if (table !== "messages") {
                throw new Error(`unknown table: ${table}`);
            }

            return { columns: ["__id__", "text"], rows: MESSAGE_ROWS.slice(offset, offset + limit), total: MESSAGE_ROWS.length };
        },
    });

const renderBrowser = (mock: MockClientHooks, props: DataBrowserProps = {}): ReactElement => (
    <CirrusProvider client={mock.asClient}>
        <DataBrowser {...props} />
    </CirrusProvider>
);

describe("dataBrowser", () => {
    test("lists tables with row counts on mount", async () => {
        expect.assertions(2);

        const mock = createBrowserClient();

        render(renderBrowser(mock));

        await screen.findByTestId("db-table-list");

        expect(screen.getByTestId("db-table-messages").textContent).toBe("messages (3)");
        expect(screen.getByTestId("db-table-users").textContent).toBe("users (1)");
    });

    test("loads the first page of a table when selected", async () => {
        expect.assertions(4);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 2 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-page");

        expect(screen.getAllByTestId("db-row")).toHaveLength(2);
        expect(screen.getByTestId("db-page-info").textContent).toBe("1-2 of 3");
        expect((screen.getByTestId("db-prev") as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByTestId("db-next") as HTMLButtonElement).disabled).toBe(false);
    });

    test("pages forward and back through a table", async () => {
        expect.assertions(3);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 2 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByText("1-2 of 3");

        fireEvent.click(screen.getByTestId("db-next"));

        await screen.findByText("3-3 of 3");

        expect(screen.getAllByTestId("db-row")).toHaveLength(1);
        expect((screen.getByTestId("db-next") as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByTestId("db-prev") as HTMLButtonElement).disabled).toBe(false);

        fireEvent.click(screen.getByTestId("db-prev"));

        await screen.findByText("1-2 of 3");
    });

    test("forwards the shard key when reloading tables", async () => {
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

    test("surfaces a table-listing error", async () => {
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

    test("surfaces a page-read error without dropping the table list", async () => {
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

    test("toggles between the table and JSON views", async () => {
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
    const rowTexts = (): string[] => screen.getAllByTestId("db-row").map((row) => row.querySelectorAll("td")[1]?.textContent ?? "");

    test("sorts a column ascending then descending on repeated clicks", async () => {
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

    test("clears the sort on the third click", async () => {
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

    test("filters rows case-insensitively across all cells", async () => {
        expect.assertions(2);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-rows");

        fireEvent.change(screen.getByTestId("db-filter"), { target: { value: "WOR" } });

        expect(screen.getAllByTestId("db-row")).toHaveLength(1);
        expect(rowTexts()).toEqual(["world"]);
    });

    test("composes filter and sort on the loaded page", async () => {
        expect.assertions(1);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-rows");

        // Keep rows whose any cell contains "o" (hello, world) then sort ascending.
        fireEvent.change(screen.getByTestId("db-filter"), { target: { value: "o" } });
        fireEvent.click(screen.getByTestId("db-sort-text"));

        expect(rowTexts()).toEqual(["hello", "world"]);
    });

    test("does not refetch the page when sorting or filtering", async () => {
        expect.assertions(1);

        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 10 }));

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-rows");

        const pageCallsBefore = mock.query.mock.calls.filter((call) => (call[0] as { __cirrusRef: string }).__cirrusRef === ADMIN_FUNCTIONS.readTablePage).length;

        fireEvent.click(screen.getByTestId("db-sort-text"));
        fireEvent.change(screen.getByTestId("db-filter"), { target: { value: "or" } });

        const pageCallsAfter = mock.query.mock.calls.filter((call) => (call[0] as { __cirrusRef: string }).__cirrusRef === ADMIN_FUNCTIONS.readTablePage).length;

        expect(pageCallsAfter).toBe(pageCallsBefore);
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

                    const resultId = op === "insert" ? "m4" : id ?? null;

                    return { id: resultId, op };
                }

                const { limit = 50, offset = 0 } = args as PageArgs;

                return { columns: ["__id__", "text"], rows: MESSAGE_ROWS.slice(offset, offset + limit), total: MESSAGE_ROWS.length };
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

    test("hides edit controls unless `editable` is set", async () => {
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

    test("deletes a row via the writeRow op", async () => {
        expect.assertions(1);

        const mock = createEditableClient();

        await openMessages(mock);

        fireEvent.click(screen.getByTestId("db-delete-m1"));

        await waitFor(() => {
            if (!mock.query.mock.calls.some((c) => c[0].__cirrusRef === ADMIN_FUNCTIONS.writeRow)) {
                throw new Error("writeRow not called yet");
            }
        });

        const call = mock.query.mock.calls.find((c) => c[0].__cirrusRef === ADMIN_FUNCTIONS.writeRow) as [unknown, Record<string, unknown>, unknown];

        expect(call[1]).toMatchObject({ id: "m1", op: "delete", table: "messages" });
    });

    test("inserts a new row from the editor", async () => {
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

    test("reports invalid JSON without calling the server", async () => {
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

    test("edits an existing row (patch) prefilled from its doc", async () => {
        expect.assertions(2);

        const mock = createEditableClient();

        await openMessages(mock);

        fireEvent.click(screen.getByTestId("db-edit-m1"));

        // The editor prefills the row's editable fields (id/meta stripped).
        const editor = screen.getByTestId("db-editor-doc") as HTMLTextAreaElement;

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

    test("edits the right row while a filter and sort are active", async () => {
        expect.assertions(2);

        const mock = createEditableClient();

        render(
            <CirrusProvider client={mock.asClient}>
                <DataBrowser editable pageSize={10} />
            </CirrusProvider>,
        );

        fireEvent.click(await screen.findByTestId("db-table-messages"));

        await screen.findByTestId("db-rows");

        // Sort descending and filter to a single row — `world` is m2 in the fixture.
        fireEvent.click(screen.getByTestId("db-sort-text"));
        fireEvent.click(screen.getByTestId("db-sort-text"));
        fireEvent.change(screen.getByTestId("db-filter"), { target: { value: "world" } });

        // The editor prefills from the ORIGINAL row, not a sorted/filtered copy.
        fireEvent.click(screen.getByTestId("db-edit-m2"));

        const editor = screen.getByTestId("db-editor-doc") as HTMLTextAreaElement;

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
});
