import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExportImportPanel } from "../../../src/features/database/export-import";
import type { ColumnMeta, ExportRow } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const EXPORT_ROWS: ExportRow[] = [
    { doc: { __id__: "m1", text: "hello" }, table: "messages" },
    { doc: { __id__: "m2", text: "world" }, table: "messages" },
];

/** Every `messages` column is text, which is what a CSV cell is when the table declares nothing else. */
const TEXT_COLUMNS: ColumnMeta[] = [
    { name: "id", optional: false, type: "string" },
    { name: "text", optional: false, type: "string" },
];

/** The typed columns the coercion tests import into: one per kind a CSV cell is coerced to. */
const TYPED_COLUMNS: ColumnMeta[] = [
    { name: "id", optional: false, type: "string" },
    { name: "count", optional: false, type: "number" },
    { name: "active", optional: false, type: "boolean" },
    { name: "amount", optional: false, type: "bigint" },
    { name: "day", optional: false, type: "date" },
];

/**
 * A server whose shard holds `rowsByTable`, with `columns` as the `messages` table's columns; `exportShard` answers one table per call, as
 * the panel asks for it.
 */
const createClient = (rowsByTable?: Record<string, ExportRow[]>, columns: ColumnMeta[] = TEXT_COLUMNS): MockClientHooks =>
    createMockClient({
        query: (reference, args): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return Object.entries(rowsByTable ?? { messages: EXPORT_ROWS }).map(([name, rows]) => {
                    return { name, rowCount: rows.length };
                });
            }

            if (reference === ADMIN_FUNCTIONS.describeTable) {
                return { columns };
            }

            if (reference === ADMIN_FUNCTIONS.exportShard) {
                const { tables } = args as { tables: string[] };

                return { rows: tables.flatMap((table) => (rowsByTable ?? { messages: EXPORT_ROWS })[table] ?? []) };
            }

            if (reference === ADMIN_FUNCTIONS.importShard) {
                const { dryRun, rows } = args as ImportArgs;

                // A check writes nothing, so it reports nothing inserted.
                return { conflicts: 0, errors: [], inserted: dryRun === true ? {} : { messages: rows.length } };
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

/**
 * Choose a base-ui select item. The item commits a mouse selection only after a pointer-down on it, so a bare click is ignored.
 */
const pickOption = (option: HTMLElement): void => {
    fireEvent.pointerDown(option);
    fireEvent.click(option);
};

/** Pick `text` as a CSV file, choose `table` in the target-table picker, then confirm the import. */
const importCsv = async (text: string, table: string): Promise<void> => {
    fireEvent.change(screen.getByTestId("ei-file"), { target: { files: [new File([text], "rows.csv", { type: "text/csv" })] } });
    fireEvent.click(await screen.findByTestId("ei-csv-table"));
    pickOption(await screen.findByRole("option", { name: table }));
    fireEvent.click(screen.getByTestId("ei-import"));
    fireEvent.click(screen.getByTestId("ei-import-confirm"));
};

/** The rows and first line of each `importShard` call, in order. */
type ImportArgs = { dryRun?: boolean; rows: ExportRow[]; startLine: number };

/** The `importShard` calls that wrote rows: the panel sends `dryRun: false` on each, so a check can never be counted as a write. */
const importCalls = (mock: MockClientHooks): ImportArgs[] =>
    callsTo(mock, ADMIN_FUNCTIONS.importShard)
        .map((call) => call[1] as ImportArgs)
        .filter((args) => args.dryRun === false);

/** The `importShard` calls that only checked their rows, in the order the panel sent them. */
const dryChecks = (mock: MockClientHooks): ImportArgs[] =>
    callsTo(mock, ADMIN_FUNCTIONS.importShard)
        .map((call) => call[1] as ImportArgs)
        .filter((args) => args.dryRun === true);

/**
 * A server that answers `importShard` for a 1200-row file. A check (`dryRun: true`) refuses the row on `badLine` when a chunk holds it, and
 * a write inserts every row it is sent.
 */
const createCheckingClient = (badLine?: number): MockClientHooks =>
    createMockClient({
        query: (reference, args): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return [{ name: "messages", rowCount: 0 }];
            }

            if (reference === ADMIN_FUNCTIONS.importShard) {
                const { dryRun, rows, startLine } = args as ImportArgs;
                const refused = badLine !== undefined && badLine >= startLine && badLine < startLine + rows.length;

                if (dryRun === true && refused) {
                    return {
                        conflicts: 0,
                        errors: [{ code: "VALIDATION_ERROR", line: badLine, message: "text must be a string", table: "messages" }],
                        inserted: {},
                    };
                }

                // A check writes nothing, so it reports nothing inserted.
                return { conflicts: 0, errors: [], inserted: dryRun === true ? {} : { messages: rows.length } };
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

/** The columns of the CSV test table: two text columns, so every cell is kept as the text it was written as. */
const CSV_COLUMNS: ColumnMeta[] = [
    { name: "id", optional: false, type: "string" },
    { name: "body", optional: false, type: "string" },
];

/** A server for a CSV import into `messages`. `refusedRecord`, when given, is a record the check refuses; writes insert every row sent. */
const createCsvServer = (refusedRecord?: number): MockClientHooks =>
    createMockClient({
        query: (reference, args): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return [{ name: "messages", rowCount: 0 }];
            }

            if (reference === ADMIN_FUNCTIONS.describeTable) {
                return { columns: CSV_COLUMNS };
            }

            if (reference === ADMIN_FUNCTIONS.importShard) {
                const { dryRun, rows, startLine } = args as ImportArgs;
                const index = refusedRecord === undefined ? -1 : refusedRecord - startLine;

                if (dryRun === true && index >= 0 && index < rows.length) {
                    return {
                        conflicts: 0,
                        errors: [{ code: "VALIDATION_ERROR", line: startLine + index, message: "text must be a string", table: "messages" }],
                        inserted: {},
                    };
                }

                return { conflicts: 0, errors: [], inserted: dryRun === true ? {} : { messages: rows.length } };
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

/**
 * A CSV of 600 rows, with a blank line before the header and another before row 300, CRLF and LF endings mixed, and a line break inside
 * the quoted cell of row 5. Every blank line takes a record number, so row k is record 3 + k, or 4 + k from row 300 on.
 */
const mixedCsv = (): string => {
    const lines = ["", "id,body"];

    for (let row = 0; row < 600; row += 1) {
        if (row === 300) {
            lines.push("");
        }

        lines.push(row === 5 ? `m${row.toString()},"line one\nline two"` : `m${row.toString()},text ${row.toString()}`);
    }

    return lines.map((line, index) => `${line}${index % 2 === 0 ? "\r\n" : "\n"}`).join("");
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
        expect(importCalls(mock).map((call) => call.startLine)).toStrictEqual([1, 501, 1001]);
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
        expect(importCalls(mock).map((call) => call.startLine)).toStrictEqual([1, 3]);
    });

    it("refuses a row whose wire encoding is too wide, even when its NDJSON line is short", async () => {
        expect.assertions(2);

        const mock = createClient();
        // `1e400` is 6 bytes on the NDJSON line but a tagged 25-byte non-finite value on the wire.
        const values = Array.from({ length: 40_000 }).fill("1e400").join(",");

        render(renderPanel(mock));

        importText(`{"doc":{"__id__":"wide","values":[${values}]},"table":"messages"}`);

        const error = await screen.findByTestId("ei-error");

        expect(error.textContent).toContain("a single row is over the 900000-byte import limit");
        expect(callsTo(mock, ADMIN_FUNCTIONS.importShard)).toHaveLength(0);
    });

    it("starts a new chunk after a blank line, so the server numbers its errors by the file's own lines", async () => {
        expect.assertions(1);

        const mock = createClient();
        const row = (id: string): string => JSON.stringify({ doc: { __id__: id }, table: "messages" });

        render(renderPanel(mock));

        importText(`${row("m1")}\n\n${row("m2")}`);

        await screen.findByTestId("ei-import-result");

        expect(importCalls(mock).map((call) => call.startLine)).toStrictEqual([1, 3]);
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
            query: (reference, args): unknown => {
                if (reference === ADMIN_FUNCTIONS.importShard) {
                    if ((args as { dryRun?: boolean }).dryRun === true) {
                        return { conflicts: 0, errors: [], inserted: {} };
                    }

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
        expect(importCalls(mock)).toHaveLength(2);
    });

    it("stops writing once a chunk reports a refused row, so the chunks after it are never sent", async () => {
        expect.assertions(2);

        let writes = 0;

        const mock = createMockClient({
            query: (reference, args): unknown => {
                if (reference === ADMIN_FUNCTIONS.importShard) {
                    if ((args as { dryRun?: boolean }).dryRun === true) {
                        return { conflicts: 0, errors: [], inserted: {} };
                    }

                    writes += 1;

                    return {
                        conflicts: 0,
                        errors: [{ code: "VALIDATION", line: 2, message: "text must be a string", table: "messages" }],
                        inserted: { messages: 499 },
                    };
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        const lines = Array.from({ length: 1200 }, (_, index) => JSON.stringify({ doc: { __id__: `m${index.toString()}` }, table: "messages" }));

        render(renderPanel(mock));

        importText(lines.join("\n"));

        const error = await screen.findByTestId("ei-error");

        expect(error.textContent).toContain("The shard refused 1 rows, so the rest of the file was not sent.");
        expect(writes).toBe(1);
    });

    it("tells the user how many rows a refused chunk left written, and where to resume", async () => {
        expect.assertions(3);

        const mock = createMockClient({
            query: (reference, args): unknown => {
                if (reference === ADMIN_FUNCTIONS.importShard) {
                    const { dryRun, rows, startLine } = args as ImportArgs;

                    if (dryRun === true) {
                        return { conflicts: 0, errors: [], inserted: {} };
                    }

                    // The first chunk (lines 1-500) writes every row. The second (lines 501-1000) refuses line 510 and writes the other 499.
                    if (startLine === 501) {
                        return {
                            conflicts: 0,
                            errors: [{ code: "VALIDATION", line: 510, message: "text must be a string", table: "messages" }],
                            inserted: { messages: rows.length - 1 },
                        };
                    }

                    return { conflicts: 0, errors: [], inserted: { messages: rows.length } };
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        const lines = Array.from({ length: 1200 }, (_, index) => JSON.stringify({ doc: { __id__: `m${index.toString()}` }, table: "messages" }));

        render(renderPanel(mock));

        importText(lines.join("\n"));

        const error = await screen.findByTestId("ei-error");

        expect(error.textContent).toContain("999 rows were already written");
        expect(error.textContent).toContain("from line 1001 onward");
        // The "counts below cover completed chunks only" hedge is for a transport failure, where the failed chunk's writes are unknown.
        expect(error.textContent).not.toContain("counts below");
    });

    it("says rows may have been written when a chunk's request fails after earlier chunks only met conflicts", async () => {
        expect.assertions(3);

        let imports = 0;

        const mock = createMockClient({
            query: (reference, args): unknown => {
                if (reference === ADMIN_FUNCTIONS.importShard) {
                    if ((args as { dryRun?: boolean }).dryRun === true) {
                        return { conflicts: 0, errors: [], inserted: {} };
                    }

                    imports += 1;

                    if (imports === 2) {
                        throw new Error("connection reset");
                    }

                    // The first chunk writes nothing: every row meets an _id already in use.
                    return { conflicts: 500, errors: [], inserted: {} };
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        const lines = Array.from({ length: 1200 }, (_, index) => JSON.stringify({ doc: { __id__: `m${index.toString()}` }, table: "messages" }));

        render(renderPanel(mock));

        importText(lines.join("\n"));

        const error = await screen.findByTestId("ei-error");

        expect(error.textContent).toContain("Import stopped after 500 rows: connection reset");
        expect(error.textContent).toContain("The chunk from line 501 may have written rows");
        expect(importCalls(mock)).toHaveLength(2);
    });

    it("says nothing was written when the first chunk is refused before any row lands", async () => {
        expect.assertions(2);

        const mock = createMockClient({
            query: (reference, args): unknown => {
                if (reference === ADMIN_FUNCTIONS.importShard) {
                    if ((args as { dryRun?: boolean }).dryRun === true) {
                        return { conflicts: 0, errors: [], inserted: {} };
                    }

                    return {
                        conflicts: 0,
                        errors: [{ code: "VALIDATION", line: 2, message: "text must be a string", table: "messages" }],
                        inserted: {},
                    };
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        const lines = Array.from({ length: 1200 }, (_, index) => JSON.stringify({ doc: { __id__: `m${index.toString()}` }, table: "messages" }));

        render(renderPanel(mock));

        importText(lines.join("\n"));

        const error = await screen.findByTestId("ei-error");

        expect(error.textContent).toBe(
            "The shard refused 1 rows, so the rest of the file was not sent. Nothing was written. Fix the rows listed below and import again.",
        );
        expect(importCalls(mock)).toHaveLength(1);
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

                // The check the panel sends first is not a write, so it is not part of the round trip.
                if ((args as { dryRun?: boolean }).dryRun === true) {
                    return { conflicts: 0, errors: [], inserted: {} };
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

    it("imports a CSV file into the picked table, keying each row by the header and omitting empty cells", async () => {
        expect.assertions(1);

        const mock = createClient();

        render(renderPanel(mock));

        await importCsv('id,text\nm3,"again, twice"\nm4,\n', "messages");

        await screen.findByTestId("ei-import-result");

        expect(importCalls(mock)[0]?.rows).toStrictEqual([
            { doc: { id: "m3", text: "again, twice" }, table: "messages" },
            { doc: { id: "m4" }, table: "messages" },
        ]);
    });

    it("keeps import disabled for a CSV file until a target table is picked", async () => {
        expect.assertions(2);

        render(renderPanel(createClient()));

        fireEvent.change(screen.getByTestId("ei-file"), { target: { files: [new File(["id\n1\n"], "rows.csv", { type: "text/csv" })] } });

        await screen.findByTestId("ei-csv-table");

        expect(screen.getByTestId("ei-import").hasAttribute("disabled")).toBe(true);

        fireEvent.click(await screen.findByTestId("ei-csv-table"));
        pickOption(await screen.findByRole("option", { name: "messages" }));

        expect(screen.getByTestId("ei-import").hasAttribute("disabled")).toBe(false);
    });

    it("imports a replacement CSV into the table picked for it, not the table picked for the file it replaced", async () => {
        expect.assertions(3);

        const mock = createClient({ messages: EXPORT_ROWS, notes: [{ doc: { __id__: "n1", text: "note" }, table: "notes" }] });

        render(renderPanel(mock));

        await importCsv("id,text\nm3,first\n", "messages");

        await screen.findByTestId("ei-import-result");

        fireEvent.change(screen.getByTestId("ei-file"), {
            target: { files: [new File(["id,text\nn2,second\nn3,third\n"], "notes.csv", { type: "text/csv" })] },
        });

        await screen.findByTestId("ei-csv-table");

        expect(screen.getByTestId("ei-import").hasAttribute("disabled")).toBe(true);

        fireEvent.click(await screen.findByTestId("ei-csv-table"));
        pickOption(await screen.findByRole("option", { name: "notes" }));
        fireEvent.click(screen.getByTestId("ei-import"));
        fireEvent.click(screen.getByTestId("ei-import-confirm"));

        // The two-row result is the milestone: the first import's result read "Inserted 1".
        await screen.findByText("Inserted 2, 0 conflicts, 0 errors.");

        expect(importCalls(mock)).toHaveLength(2);
        expect(importCalls(mock)[1]?.rows).toStrictEqual([
            { doc: { id: "n2", text: "second" }, table: "notes" },
            { doc: { id: "n3", text: "third" }, table: "notes" },
        ]);
    });

    it("writes nothing when any CSV record is malformed, and names the record", async () => {
        expect.assertions(2);

        const mock = createClient();
        // The header is record 1, so index 1000 is record 1001.
        const lines = ["id,text", ...Array.from({ length: 1200 }, (_, index) => `m${index.toString()},hello`)];

        lines[1000] = "m999";

        render(renderPanel(mock));

        await importCsv(lines.join("\n"), "messages");

        const error = await screen.findByTestId("ei-error");

        expect(callsTo(mock, ADMIN_FUNCTIONS.importShard)).toHaveLength(0);
        expect(error.textContent).toBe("Invalid CSV: line 1001: expected 2 cells, found 1.");
    });

    it("numbers a large CSV import by record, the header being record 1, across chunks", async () => {
        expect.assertions(2);

        const mock = createClient();
        const lines = ["id,text", ...Array.from({ length: 1200 }, (_, index) => `m${index.toString()},hello`)];

        render(renderPanel(mock));

        await importCsv(lines.join("\n"), "messages");

        const importResult = await screen.findByTestId("ei-import-result");

        expect(importResult.textContent).toContain("Inserted 1200");
        expect(importCalls(mock).map((call) => call.startLine)).toStrictEqual([2, 502, 1002]);
    });

    it("rejects a CSV whose header repeats a name before writing, naming the header", async () => {
        expect.assertions(2);

        const mock = createClient();

        render(renderPanel(mock));

        await importCsv("id,text,id\n1,a,2\n", "messages");

        const error = await screen.findByTestId("ei-error");

        expect(callsTo(mock, ADMIN_FUNCTIONS.importShard)).toHaveLength(0);
        expect(error.textContent).toBe("Invalid CSV: The header “id” appears more than once.");
    });

    it("refuses a header-only CSV without calling the server", async () => {
        expect.assertions(2);

        const mock = createClient();

        render(renderPanel(mock));

        await importCsv("id,text\r\n", "messages");

        const error = await screen.findByTestId("ei-error");

        expect(callsTo(mock, ADMIN_FUNCTIONS.importShard)).toHaveLength(0);
        expect(error.textContent).toBe("The CSV has no data rows after the header.");
    });

    it("shows a server row error against its record number", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return [{ name: "messages", rowCount: 0 }];
                }

                if (reference === ADMIN_FUNCTIONS.describeTable) {
                    return { columns: TEXT_COLUMNS };
                }

                if (reference === ADMIN_FUNCTIONS.importShard) {
                    return {
                        conflicts: 0,
                        errors: [{ code: "VALIDATION", line: 3, message: "text must be a string", table: "messages" }],
                        inserted: {},
                    };
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        render(renderPanel(mock));

        await importCsv("id,text\n1,a\n2,b\n", "messages");

        const errors = await screen.findByTestId("ei-import-errors");

        expect(errors.textContent).toBe("line 3 (messages): text must be a string");
    });

    it("coerces a number column to a number, so the writer receives a value it accepts", async () => {
        expect.assertions(1);

        const mock = createClient(undefined, TYPED_COLUMNS);

        render(renderPanel(mock));

        await importCsv("id,count\nm1,42\nm2,1.5e2\n", "messages");

        await screen.findByTestId("ei-import-result");

        expect(importCalls(mock)[0]?.rows.map((row) => row.doc["count"])).toStrictEqual([42, 150]);
    });

    it("coerces a boolean column to true or false, in any case", async () => {
        expect.assertions(1);

        const mock = createClient(undefined, TYPED_COLUMNS);

        render(renderPanel(mock));

        await importCsv("id,active\nm1,TRUE\nm2,false\n", "messages");

        await screen.findByTestId("ei-import-result");

        expect(importCalls(mock)[0]?.rows.map((row) => row.doc["active"])).toStrictEqual([true, false]);
    });

    it("coerces a bigint column to a bigint, exact past 2^53", async () => {
        expect.assertions(1);

        const mock = createClient(undefined, TYPED_COLUMNS);

        render(renderPanel(mock));

        await importCsv("id,amount\nm1,9007199254740993\nm2,-12\n", "messages");

        await screen.findByTestId("ei-import-result");

        expect(importCalls(mock)[0]?.rows.map((row) => row.doc["amount"])).toStrictEqual([9_007_199_254_740_993n, -12n]);
    });

    it("writes nothing when one cell does not fit its column type, and names the record and column", async () => {
        expect.assertions(2);

        const mock = createClient(undefined, TYPED_COLUMNS);
        // The header is record 1, so index 1000 is record 1001.
        const lines = ["id,count", ...Array.from({ length: 1200 }, (_, index) => `m${index.toString()},${index.toString()}`)];

        lines[1000] = "m999,x";

        render(renderPanel(mock));

        await importCsv(lines.join("\n"), "messages");

        const error = await screen.findByTestId("ei-error");

        expect(callsTo(mock, ADMIN_FUNCTIONS.importShard)).toHaveLength(0);
        expect(error.textContent).toBe("Invalid CSV: line 1001: column “count” must be a number, got “x”.");
    });

    it("writes nothing for a number a double would round, and points to a bigint column", async () => {
        expect.assertions(2);

        const mock = createClient(undefined, TYPED_COLUMNS);

        render(renderPanel(mock));

        await importCsv("id,count\nm1,9007199254740993\n", "messages");

        const error = await screen.findByTestId("ei-error");

        expect(callsTo(mock, ADMIN_FUNCTIONS.importShard)).toHaveLength(0);
        expect(error.textContent).toBe(
            "Invalid CSV: line 2: column “count” holds “9007199254740993”, which a number column cannot store exactly. Store a whole number past 9007199254740991 in a bigint column.",
        );
    });

    it("writes nothing for a date-time with no zone, and says to add Z or an offset", async () => {
        expect.assertions(2);

        const mock = createClient(undefined, TYPED_COLUMNS);

        render(renderPanel(mock));

        await importCsv("id,day\nm1,2026-03-01T09:00:00\n", "messages");

        const error = await screen.findByTestId("ei-error");

        expect(callsTo(mock, ADMIN_FUNCTIONS.importShard)).toHaveLength(0);
        expect(error.textContent).toBe(
            "Invalid CSV: line 2: column “day” holds “2026-03-01T09:00:00”, a time with no zone. Add Z for UTC or an offset such as +02:00.",
        );
    });

    it("sends a column named __proto__ to the server as a field of its own, beside the others", async () => {
        expect.assertions(2);

        const mock = createClient(undefined, [
            { name: "kind", optional: false, type: "string" },
            { name: "__proto__", optional: false, type: "string" },
        ]);

        render(renderPanel(mock));

        await importCsv("kind,__proto__\na,surprise\n", "messages");

        await screen.findByTestId("ei-import-result");

        const [row] = importCalls(mock)[0]?.rows ?? [];

        expect(Object.keys(row?.doc ?? {})).toStrictEqual(["kind", "__proto__"]);
        expect(Object.getOwnPropertyDescriptor(row?.doc, "__proto__")?.value).toBe("surprise");
    });

    it("checks every chunk before writing, and writes nothing when a row in the last chunk would be refused", async () => {
        expect.assertions(4);

        const mock = createCheckingClient(1101);
        const lines = Array.from({ length: 1200 }, (_, index) => JSON.stringify({ doc: { __id__: `m${index.toString()}` }, table: "messages" }));

        render(renderPanel(mock));

        importText(lines.join("\n"));

        const errors = await screen.findByTestId("ei-import-errors");
        const error = await screen.findByTestId("ei-error");

        expect(dryChecks(mock).map((call) => call.startLine)).toStrictEqual([1, 501, 1001]);
        expect(importCalls(mock)).toHaveLength(0);
        expect(errors.textContent).toBe("line 1101 (messages): text must be a string");
        expect(error.textContent).toBe("Nothing was written, because some rows would be refused. Fix the rows listed below and import again.");
    });

    it("stops at the first check that reports a write, since the server ignored the dry-run flag", async () => {
        expect.assertions(3);

        // A server that predates dry runs answers a check like a real import: it inserts the rows and says so.
        const mock = createMockClient({
            query: (reference, args): unknown => {
                if (reference === ADMIN_FUNCTIONS.importShard) {
                    return { conflicts: 0, errors: [], inserted: { messages: (args as ImportArgs).rows.length } };
                }

                throw new Error(`unexpected ${reference}`);
            },
        });
        const lines = Array.from({ length: 1200 }, (_, index) => JSON.stringify({ doc: { __id__: `m${index.toString()}` }, table: "messages" }));

        render(renderPanel(mock));

        importText(lines.join("\n"));

        const error = await screen.findByTestId("ei-error");

        expect(error.textContent).toBe("This server cannot check an import before writing, so the check may already have written rows. Nothing more was sent.");
        expect(dryChecks(mock)).toHaveLength(1);
        expect(importCalls(mock)).toHaveLength(0);
    });

    it("checks every chunk in order, then writes the same chunks", async () => {
        expect.assertions(2);

        const mock = createCheckingClient();
        const lines = Array.from({ length: 1200 }, (_, index) => JSON.stringify({ doc: { __id__: `m${index.toString()}` }, table: "messages" }));

        render(renderPanel(mock));

        importText(lines.join("\n"));

        await screen.findByTestId("ei-import-result");

        expect(dryChecks(mock).map((call) => call.startLine)).toStrictEqual([1, 501, 1001]);
        expect(importCalls(mock).map((call) => call.startLine)).toStrictEqual([1, 501, 1001]);
    });

    it("chunks a CSV with blank lines, CRLF endings and a line break in a cell at its blank lines, keeping the cell's text", async () => {
        expect.assertions(4);

        const mock = createCsvServer();

        render(renderPanel(mock));

        await importCsv(mixedCsv(), "messages");

        await screen.findByTestId("ei-import-result");

        expect(dryChecks(mock).map((call) => call.startLine)).toStrictEqual([3, 304]);
        expect(importCalls(mock).map((call) => call.startLine)).toStrictEqual([3, 304]);
        expect(importCalls(mock).reduce((sum, call) => sum + call.rows.length, 0)).toBe(600);
        expect(importCalls(mock)[0]?.rows[5]?.doc).toStrictEqual({ body: "line one\nline two", id: "m5" });
    });

    it("names the record a check refuses in a CSV with blank lines, and writes nothing", async () => {
        expect.assertions(3);

        // Record 454 is row 450, in the second chunk.
        const mock = createCsvServer(454);

        render(renderPanel(mock));

        await importCsv(mixedCsv(), "messages");

        const errors = await screen.findByTestId("ei-import-errors");
        const error = await screen.findByTestId("ei-error");

        expect(errors.textContent).toBe("line 454 (messages): text must be a string");
        expect(error.textContent).toBe("Nothing was written, because some rows would be refused. Fix the rows listed below and import again.");
        expect(importCalls(mock)).toHaveLength(0);
    });

    it("reads a CSV file once for each of its three passes, the check, the dry run and the write, and never holds it whole", async () => {
        expect.assertions(2);

        const mock = createCsvServer();
        const file = new File([mixedCsv()], "rows.csv", { type: "text/csv" });
        const slice = vi.spyOn(file, "slice");

        render(renderPanel(mock));

        fireEvent.change(screen.getByTestId("ei-file"), { target: { files: [file] } });
        fireEvent.click(await screen.findByTestId("ei-csv-table"));
        pickOption(await screen.findByRole("option", { name: "messages" }));
        fireEvent.click(screen.getByTestId("ei-import"));
        fireEvent.click(screen.getByTestId("ei-import-confirm"));

        await screen.findByTestId("ei-import-result");

        // The file is under one read piece, so each pass is one slice.
        expect(slice).toHaveBeenCalledTimes(3);
        expect(importCalls(mock)).toHaveLength(2);
    });
});
