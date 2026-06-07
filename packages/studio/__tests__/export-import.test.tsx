import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ExportRow } from "../src/admin.js";
import { ADMIN_FUNCTIONS } from "../src/admin.js";
import { ExportImportPanel } from "../src/export-import.js";
import type { MockClientHooks } from "./mock-client.js";
import { createMockClient } from "./mock-client.js";

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
    it("exports rows into the NDJSON textarea", async () => {
        expect.assertions(2);

        render(renderPanel(createClient()));

        fireEvent.click(screen.getByTestId("ei-export"));

        await screen.findByText("Exported 2 rows.");

        const textarea = screen.getByTestId<HTMLTextAreaElement>("ei-ndjson");

        expect(textarea.value.split("\n")).toHaveLength(2);
        expect(JSON.parse(textarea.value.split("\n")[0] ?? "")).toMatchObject({ table: "messages" });
    });

    it("rejects malformed NDJSON before calling the server", async () => {
        expect.assertions(2);

        const mock = createClient();

        render(renderPanel(mock));

        fireEvent.change(screen.getByTestId("ei-ndjson"), { target: { value: "{not json}" } });
        fireEvent.click(screen.getByTestId("ei-import"));
        fireEvent.click(screen.getByTestId("ei-import-confirm"));

        const error = await screen.findByTestId("ei-error");

        expect(error.textContent).toContain("Invalid NDJSON");
        expect(mock.query.mock.calls.some((call) => call[0].__cirrusRef === ADMIN_FUNCTIONS.importShard)).toBe(false);
    });

    it("imports NDJSON and summarises the result", async () => {
        expect.assertions(1);

        render(renderPanel(createClient()));

        fireEvent.change(screen.getByTestId("ei-ndjson"), {
            target: { value: '{"table":"messages","doc":{"__id__":"m3","text":"again"}}' },
        });
        fireEvent.click(screen.getByTestId("ei-import"));
        fireEvent.click(screen.getByTestId("ei-import-confirm"));

        const importResult = await screen.findByTestId("ei-import-result");

        expect(importResult.textContent).toContain("Inserted 1");
    });
});
