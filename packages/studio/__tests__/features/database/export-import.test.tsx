import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ExportImportPanel } from "../../../src/features/database/export-import";
import type { ExportRow } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

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
    <LunoraProvider client={mock.asClient}>
        <ExportImportPanel />
    </LunoraProvider>
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
        expect(mock.query.mock.calls.some((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.importShard)).toBe(false);
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

    it("round-trips a bigint / bytes row through export and import with its types intact", async () => {
        expect.assertions(3);

        // The client wire-decodes every admin reply, so a `v.bigint()` column
        // reaches the panel as a real bigint (which `JSON.stringify` THROWS on,
        // failing the whole export) and a `v.bytes()` column as an ArrayBuffer
        // (which flattens to `{}`, so the export "succeeds" and the bytes are
        // gone). The exported text has to be re-importable as the same values.
        const blob = Uint8Array.from([1, 2, 3, 4]).buffer;
        const imported: ExportRow[] = [];
        const mock = createMockClient({
            query: (reference, args): unknown => {
                if (reference === ADMIN_FUNCTIONS.exportShard) {
                    return { rows: [{ doc: { __id__: "l1", amount: 42n, blob }, table: "ledger" }] };
                }

                imported.push(...(args as { rows: ExportRow[] }).rows);

                return { conflicts: 0, errors: [], inserted: { ledger: 1 } };
            },
        });

        render(renderPanel(mock));
        fireEvent.click(screen.getByTestId("ei-export"));

        await screen.findByText("Exported 1 rows.");

        // Round-trip the exported text straight back through Import.
        fireEvent.click(screen.getByTestId("ei-import"));
        fireEvent.click(screen.getByTestId("ei-import-confirm"));

        await screen.findByTestId("ei-import-result");

        const [row] = imported;

        expect(imported).toHaveLength(1);
        expect((row?.doc as Record<string, unknown>)["amount"]).toBe(42n);
        expect(new Uint8Array((row?.doc as Record<string, unknown>)["blob"] as ArrayBuffer)).toStrictEqual(new Uint8Array([1, 2, 3, 4]));
    });
});
