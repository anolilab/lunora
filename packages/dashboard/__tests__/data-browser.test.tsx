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
        const mock = createBrowserClient();

        render(renderBrowser(mock));

        await waitFor(() => {
            expect(screen.getByTestId("db-table-list")).toBeDefined();
        });

        expect(screen.getByTestId("db-table-messages").textContent).toBe("messages (3)");
        expect(screen.getByTestId("db-table-users").textContent).toBe("users (1)");
    });

    test("loads the first page of a table when selected", async () => {
        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 2 }));

        await waitFor(() => {
            expect(screen.getByTestId("db-table-messages")).toBeDefined();
        });

        fireEvent.click(screen.getByTestId("db-table-messages"));

        await waitFor(() => {
            expect(screen.getByTestId("db-page")).toBeDefined();
        });

        expect(screen.getAllByTestId("db-row")).toHaveLength(2);
        expect(screen.getByTestId("db-page-info").textContent).toBe("1-2 of 3");
        expect((screen.getByTestId("db-prev") as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByTestId("db-next") as HTMLButtonElement).disabled).toBe(false);
    });

    test("pages forward and back through a table", async () => {
        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 2 }));

        await waitFor(() => {
            expect(screen.getByTestId("db-table-messages")).toBeDefined();
        });

        fireEvent.click(screen.getByTestId("db-table-messages"));

        await waitFor(() => {
            expect(screen.getByTestId("db-page-info").textContent).toBe("1-2 of 3");
        });

        fireEvent.click(screen.getByTestId("db-next"));

        await waitFor(() => {
            expect(screen.getByTestId("db-page-info").textContent).toBe("3-3 of 3");
        });

        expect(screen.getAllByTestId("db-row")).toHaveLength(1);
        expect((screen.getByTestId("db-next") as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByTestId("db-prev") as HTMLButtonElement).disabled).toBe(false);

        fireEvent.click(screen.getByTestId("db-prev"));

        await waitFor(() => {
            expect(screen.getByTestId("db-page-info").textContent).toBe("1-2 of 3");
        });
    });

    test("forwards the shard key when reloading tables", async () => {
        const mock = createBrowserClient();

        render(renderBrowser(mock));

        await waitFor(() => {
            expect(screen.getByTestId("db-table-list")).toBeDefined();
        });

        fireEvent.change(screen.getByTestId("db-shard-input"), { target: { value: "room-9" } });
        fireEvent.click(screen.getByTestId("db-load-tables"));

        await waitFor(() => {
            expect(mock.query.mock.calls.length).toBeGreaterThan(1);
        });

        const listCalls = mock.query.mock.calls.filter((call) => (call[0] as { __cirrusRef: string }).__cirrusRef === ADMIN_FUNCTIONS.listTables);
        const lastListCall = listCalls.at(-1) as [unknown, unknown, { shardKey?: string }];

        expect(lastListCall[2]).toEqual({ shardKey: "room-9" });
    });

    test("surfaces a table-listing error", async () => {
        const mock = createMockClient({
            query: () => {
                throw new Error("ADMIN_FORBIDDEN");
            },
        });

        render(renderBrowser(mock));

        await waitFor(() => {
            expect(screen.getByTestId("db-tables-error")).toBeDefined();
        });

        expect(screen.getByTestId("db-tables-error").textContent).toBe("ADMIN_FORBIDDEN");
        expect(screen.queryByTestId("db-table-list")).toBeNull();
    });

    test("surfaces a page-read error without dropping the table list", async () => {
        const mock = createMockClient({
            query: (reference) => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return TABLES;
                }

                throw new Error("UNKNOWN_TABLE");
            },
        });

        render(renderBrowser(mock));

        await waitFor(() => {
            expect(screen.getByTestId("db-table-messages")).toBeDefined();
        });

        fireEvent.click(screen.getByTestId("db-table-messages"));

        await waitFor(() => {
            expect(screen.getByTestId("db-page-error")).toBeDefined();
        });

        expect(screen.getByTestId("db-page-error").textContent).toBe("UNKNOWN_TABLE");
        expect(screen.queryByTestId("db-page")).toBeNull();
        expect(screen.getByTestId("db-table-list")).toBeDefined();
    });

    test("toggles between the table and JSON views", async () => {
        const mock = createBrowserClient();

        render(renderBrowser(mock, { pageSize: 2 }));

        await waitFor(() => {
            expect(screen.getByTestId("db-table-messages")).toBeDefined();
        });

        fireEvent.click(screen.getByTestId("db-table-messages"));

        await waitFor(() => {
            expect(screen.getByTestId("db-rows")).toBeDefined();
        });

        // Table view is the default; JSON view is opt-in.
        expect(screen.queryByTestId("db-json")).toBeNull();

        fireEvent.click(screen.getByTestId("db-view-json"));

        const json = screen.getByTestId("db-json");

        expect(JSON.parse(json.textContent ?? "")).toHaveLength(2);
        expect(screen.queryByTestId("db-rows")).toBeNull();
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

        await waitFor(() => {
            expect(screen.getByTestId("db-table-messages")).toBeDefined();
        });

        fireEvent.click(screen.getByTestId("db-table-messages"));

        await waitFor(() => {
            expect(screen.getByTestId("db-page")).toBeDefined();
        });
    };

    test("hides edit controls unless `editable` is set", async () => {
        const mock = createBrowserClient();

        render(
            <CirrusProvider client={mock.asClient}>
                <DataBrowser pageSize={2} />
            </CirrusProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("db-table-messages")).toBeDefined();
        });

        fireEvent.click(screen.getByTestId("db-table-messages"));

        await waitFor(() => {
            expect(screen.getByTestId("db-page")).toBeDefined();
        });

        expect(screen.queryByTestId("db-add-row")).toBeNull();
        expect(screen.queryByTestId("db-edit-m1")).toBeNull();
    });

    test("deletes a row via the writeRow op", async () => {
        const mock = createEditableClient();

        await openMessages(mock);

        fireEvent.click(screen.getByTestId("db-delete-m1"));

        await waitFor(() => {
            const call = mock.query.mock.calls.find((c) => c[0].__cirrusRef === ADMIN_FUNCTIONS.writeRow);

            expect(call).toBeDefined();
        });

        const call = mock.query.mock.calls.find((c) => c[0].__cirrusRef === ADMIN_FUNCTIONS.writeRow) as [unknown, Record<string, unknown>, unknown];

        expect(call[1]).toMatchObject({ id: "m1", op: "delete", table: "messages" });
    });

    test("inserts a new row from the editor", async () => {
        const mock = createEditableClient();

        await openMessages(mock);

        fireEvent.click(screen.getByTestId("db-add-row"));
        fireEvent.change(screen.getByTestId("db-editor-doc"), { target: { value: '{ "text": "fresh" }' } });
        fireEvent.click(screen.getByTestId("db-editor-save"));

        await waitFor(() => {
            const call = mock.query.mock.calls.find((c) => c[0].__cirrusRef === ADMIN_FUNCTIONS.writeRow);

            expect(call).toBeDefined();
        });

        const call = mock.query.mock.calls.find((c) => c[0].__cirrusRef === ADMIN_FUNCTIONS.writeRow) as [unknown, Record<string, unknown>, unknown];

        expect(call[1]).toMatchObject({ doc: { text: "fresh" }, op: "insert", table: "messages" });
    });

    test("reports invalid JSON without calling the server", async () => {
        const mock = createEditableClient();

        await openMessages(mock);

        fireEvent.click(screen.getByTestId("db-add-row"));
        fireEvent.change(screen.getByTestId("db-editor-doc"), { target: { value: "{ not json" } });
        fireEvent.click(screen.getByTestId("db-editor-save"));

        await waitFor(() => {
            expect(screen.getByTestId("db-write-error").textContent).toContain("Invalid JSON");
        });

        expect(mock.query.mock.calls.some((c) => c[0].__cirrusRef === ADMIN_FUNCTIONS.writeRow)).toBe(false);
    });

    test("edits an existing row (patch) prefilled from its doc", async () => {
        const mock = createEditableClient();

        await openMessages(mock);

        fireEvent.click(screen.getByTestId("db-edit-m1"));

        // The editor prefills the row's editable fields (id/meta stripped).
        const editor = screen.getByTestId("db-editor-doc") as HTMLTextAreaElement;

        expect(JSON.parse(editor.value)).toEqual({ text: "hello" });

        fireEvent.change(editor, { target: { value: '{ "text": "edited" }' } });
        fireEvent.click(screen.getByTestId("db-editor-save"));

        await waitFor(() => {
            const call = mock.query.mock.calls.find((c) => c[0].__cirrusRef === ADMIN_FUNCTIONS.writeRow);

            expect(call).toBeDefined();
        });

        const call = mock.query.mock.calls.find((c) => c[0].__cirrusRef === ADMIN_FUNCTIONS.writeRow) as [unknown, Record<string, unknown>, unknown];

        expect(call[1]).toMatchObject({ doc: { text: "edited" }, id: "m1", op: "patch", table: "messages" });
    });
});
