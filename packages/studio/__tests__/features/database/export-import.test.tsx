import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExportImportPanel } from "../../../src/features/database/export-import";
import type { ExportRow } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const EXPORT_ROWS: ExportRow[] = [
    { doc: { __id__: "m1", text: "hello" }, table: "messages" },
    { doc: { __id__: "m2", text: "world" }, table: "messages" },
];

/** A server whose shard holds `rowsByTable`; `exportShard` answers one table per call, as the panel asks for it. */
const createClient = (rowsByTable?: Record<string, ExportRow[]>): MockClientHooks =>
    createMockClient({
        query: (reference, args): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return Object.entries(rowsByTable ?? { messages: EXPORT_ROWS }).map(([name, rows]) => {
                    return { name, rowCount: rows.length };
                });
            }

            if (reference === ADMIN_FUNCTIONS.exportShard) {
                const { tables } = args as { tables: string[] };

                return { rows: tables.flatMap((table) => (rowsByTable ?? { messages: EXPORT_ROWS })[table] ?? []) };
            }

            if (reference === ADMIN_FUNCTIONS.importShard) {
                const { rows } = args as { rows: ExportRow[] };

                return { conflicts: 0, errors: [], inserted: { messages: rows.length } };
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

const callsTo = (mock: MockClientHooks, path: string): unknown[][] => mock.query.mock.calls.filter((call) => call[0].__lunoraRef === path);

const renderPanel = (mock: MockClientHooks) => (
    <LunoraProvider client={mock.asClient}>
        <ExportImportPanel />
    </LunoraProvider>
);

/** Pick `text` as the import file, then confirm the import. */
const importText = (text: string): void => {
    fireEvent.change(screen.getByTestId("ei-file"), { target: { files: [new File([text], "shard.ndjson")] } });
    fireEvent.click(screen.getByTestId("ei-import"));
    fireEvent.click(screen.getByTestId("ei-import-confirm"));
};

/** Click Download and capture the Blob handed to `URL.createObjectURL`. */
const downloadBlob = (): { blobs: Blob[] } => {
    const createObjectURL = vi.spyOn(globalThis.URL, "createObjectURL").mockReturnValue("blob:fake");

    vi.spyOn(globalThis.URL, "revokeObjectURL").mockReturnValue(undefined);

    fireEvent.click(screen.getByTestId("ei-download"));

    return { blobs: createObjectURL.mock.calls.map((call) => call[0] as Blob) };
};

describe("exportImportPanel", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("exports rows into a download and a short preview", async () => {
        expect.assertions(2);

        render(renderPanel(createClient()));

        fireEvent.click(screen.getByTestId("ei-export"));

        await screen.findByText("Exported 2 rows.");

        const preview = screen.getByTestId("ei-preview").textContent ?? "";

        expect(preview.split("\n")).toHaveLength(2);
        expect(JSON.parse(preview.split("\n")[0] ?? "")).toMatchObject({ table: "messages" });
    });

    it("pages the export one table per call into a single Blob", async () => {
        expect.assertions(3);

        const mock = createClient({
            messages: EXPORT_ROWS,
            orders: [{ doc: { __id__: "o1" }, table: "orders" }],
            users: [{ doc: { __id__: "u1" }, table: "users" }],
        });

        render(renderPanel(mock));

        fireEvent.click(screen.getByTestId("ei-export"));

        await screen.findByText("Exported 4 rows.");

        expect(callsTo(mock, ADMIN_FUNCTIONS.exportShard)).toHaveLength(3);

        const { blobs } = downloadBlob();

        expect(blobs).toHaveLength(1);

        const text = (await blobs[0]?.text()) ?? "";

        expect(text.trim().split("\n")).toHaveLength(4);
    });

    it("rejects malformed NDJSON before calling the server", async () => {
        expect.assertions(2);

        const mock = createClient();

        render(renderPanel(mock));

        importText("{not json}");

        const error = await screen.findByTestId("ei-error");

        expect(error.textContent).toContain("Invalid NDJSON");
        expect(callsTo(mock, ADMIN_FUNCTIONS.importShard)).toHaveLength(0);
    });

    it("imports an NDJSON file and summarises the result", async () => {
        expect.assertions(1);

        render(renderPanel(createClient()));

        importText('{"table":"messages","doc":{"__id__":"m3","text":"again"}}');

        const importResult = await screen.findByTestId("ei-import-result");

        expect(importResult.textContent).toContain("Inserted 1");
    });

    it("sends a large import in chunks of 500 rows, numbering lines across chunks", async () => {
        expect.assertions(2);

        const mock = createClient();
        const lines = Array.from({ length: 1200 }, (_, index) => JSON.stringify({ doc: { __id__: `m${index.toString()}` }, table: "messages" }));

        render(renderPanel(mock));

        importText(lines.join("\n"));

        const importResult = await screen.findByTestId("ei-import-result");

        expect(importResult.textContent).toContain("Inserted 1200");
        expect(callsTo(mock, ADMIN_FUNCTIONS.importShard).map((call) => (call[1] as { rows: unknown[]; startLine: number }).startLine)).toStrictEqual([
            1, 501, 1001,
        ]);
    });

    it("cuts a chunk early when its rows would exceed the byte ceiling, so wide rows stay under the body limit", async () => {
        expect.assertions(2);

        const mock = createClient();
        // Each row is ~300 KB, so three would pass the ~900 KB ceiling: the chunks are two rows each.
        const wide = "x".repeat(300_000);
        const lines = Array.from({ length: 4 }, (_, index) => JSON.stringify({ doc: { __id__: `w${index.toString()}`, body: wide }, table: "messages" }));

        render(renderPanel(mock));

        importText(lines.join("\n"));

        const importResult = await screen.findByTestId("ei-import-result");

        expect(importResult.textContent).toContain("Inserted 4");
        expect(callsTo(mock, ADMIN_FUNCTIONS.importShard).map((call) => (call[1] as { startLine: number }).startLine)).toStrictEqual([1, 3]);
    });

    it("refuses a single row too wide for any request before writing a chunk", async () => {
        expect.assertions(2);

        const mock = createClient();
        const wide = JSON.stringify({ doc: { __id__: "huge", body: "x".repeat(950_000) }, table: "messages" });

        render(renderPanel(mock));

        importText(`${JSON.stringify({ doc: { __id__: "m1" }, table: "messages" })}\n${wide}`);

        const error = await screen.findByTestId("ei-error");

        expect(error.textContent).toContain("a single row is over the 900000-byte import limit");
        expect(callsTo(mock, ADMIN_FUNCTIONS.importShard)).toHaveLength(0);
    });

    it("rejects a file with a malformed line anywhere before writing any chunk", async () => {
        expect.assertions(2);

        const mock = createClient();
        const lines = Array.from({ length: 1200 }, (_, index) => JSON.stringify({ doc: { __id__: `m${index.toString()}` }, table: "messages" }));

        lines[1000] = "{not json}";

        render(renderPanel(mock));

        importText(lines.join("\n"));

        const error = await screen.findByTestId("ei-error");

        expect(error.textContent).toContain("Invalid NDJSON");
        expect(callsTo(mock, ADMIN_FUNCTIONS.importShard)).toHaveLength(0);
    });

    it("keeps the counts of the chunks already written when a later chunk fails", async () => {
        expect.assertions(3);

        let imports = 0;

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.importShard) {
                    imports += 1;

                    if (imports === 2) {
                        throw new Error("connection reset");
                    }

                    return { conflicts: 0, errors: [], inserted: { messages: 500 } };
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        const lines = Array.from({ length: 1200 }, (_, index) => JSON.stringify({ doc: { __id__: `m${index.toString()}` }, table: "messages" }));

        render(renderPanel(mock));

        importText(lines.join("\n"));

        const error = await screen.findByTestId("ei-error");
        const importResult = await screen.findByTestId("ei-import-result");

        expect(error.textContent).toContain("Import stopped after 500 rows: connection reset");
        expect(importResult.textContent).toContain("Inserted 500");
        expect(callsTo(mock, ADMIN_FUNCTIONS.importShard)).toHaveLength(2);
    });

    it("round-trips a bigint / bytes row through export and import with its types intact", async () => {
        expect.assertions(3);

        // The client wire-decodes every admin reply, so a `v.bigint()` column
        // reaches the panel as a real bigint (which `JSON.stringify` THROWS on,
        // failing the whole export) and a `v.bytes()` column as an ArrayBuffer
        // (which flattens to `{}`, so the export "succeeds" and the bytes are
        // gone). The exported file has to be re-importable as the same values.
        const blob = Uint8Array.from([1, 2, 3, 4]).buffer;
        const imported: ExportRow[] = [];
        const mock = createMockClient({
            query: (reference, args): unknown => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return [{ name: "ledger", rowCount: 1 }];
                }

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

        // Round-trip the downloaded file straight back through Import.
        const exported = (await downloadBlob().blobs[0]?.text()) ?? "";

        importText(exported);

        await screen.findByTestId("ei-import-result");

        expect(imported).toHaveLength(1);

        const [row] = imported;

        expect((row?.doc as Record<string, unknown>)["amount"]).toBe(42n);
        expect(new Uint8Array((row?.doc as Record<string, unknown>)["blob"] as ArrayBuffer)).toStrictEqual(new Uint8Array([1, 2, 3, 4]));
    });
});
