import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { ADMIN_FUNCTIONS, type ExportRow } from "../src/admin.js";
import { ExportImportPanel } from "../src/export-import.js";
import { createMockClient, type MockClientHooks } from "./mock-client.js";

const EXPORT_ROWS: ExportRow[] = [
    { doc: { __id__: "m1", text: "hello" }, table: "messages" },
    { doc: { __id__: "m2", text: "world" }, table: "messages" },
];

const createClient = (): MockClientHooks =>
    createMockClient({
        query: (reference, args): unknown => {
            if (reference === ADMIN_FUNCTIONS.exportShard) {
                return { rows: EXPORT_ROWS };
            }

            if (reference === ADMIN_FUNCTIONS.importShard) {
                const { rows } = args as { rows: ExportRow[] };

                return { conflicts: 0, errors: [], inserted: { messages: rows.length } };
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

const renderPanel = (mock: MockClientHooks) => (
    <CirrusProvider client={mock.asClient}>
        <ExportImportPanel />
    </CirrusProvider>
);

describe("exportImportPanel", () => {
    test("exports rows into the NDJSON textarea", async () => {
        render(renderPanel(createClient()));

        fireEvent.click(screen.getByTestId("ei-export"));

        await waitFor(() => {
            expect(screen.getByTestId("ei-export-result").textContent).toBe("Exported 2 rows.");
        });

        const textarea = screen.getByTestId("ei-ndjson") as HTMLTextAreaElement;

        expect(textarea.value.split("\n")).toHaveLength(2);
        expect(JSON.parse(textarea.value.split("\n")[0] ?? "")).toMatchObject({ table: "messages" });
    });

    test("rejects malformed NDJSON before calling the server", async () => {
        const mock = createClient();

        render(renderPanel(mock));

        fireEvent.change(screen.getByTestId("ei-ndjson"), { target: { value: "{not json}" } });
        fireEvent.click(screen.getByTestId("ei-import"));

        await waitFor(() => {
            expect(screen.getByTestId("ei-error").textContent).toContain("Invalid NDJSON");
        });

        expect(mock.query.mock.calls.some((call) => call[0].__cirrusRef === ADMIN_FUNCTIONS.importShard)).toBe(false);
    });

    test("imports NDJSON and summarises the result", async () => {
        render(renderPanel(createClient()));

        fireEvent.change(screen.getByTestId("ei-ndjson"), {
            target: { value: '{"table":"messages","doc":{"__id__":"m3","text":"again"}}' },
        });
        fireEvent.click(screen.getByTestId("ei-import"));

        await waitFor(() => {
            expect(screen.getByTestId("ei-import-result").textContent).toContain("Inserted 1");
        });
    });
});
