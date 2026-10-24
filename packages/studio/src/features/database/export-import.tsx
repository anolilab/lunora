import { LunoraError } from "@lunora/errors";
import { useLunora } from "@lunora/react";
import { decodeWire, encodeWire } from "@lunora/wire";
import type { ChangeEvent, ReactElement } from "react";
import { useState } from "react";

import { ConfirmButton } from "../../components/confirm-button";
import { ShardInput } from "../../components/shard-input";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { useAdminQuery, useInvalidateAdmin } from "../../hooks/use-admin-query";
import { useT } from "../../i18n/i18n-context";
import type { ExportRow, ImportShardResult, TableColumnsResult, TableInfo } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget } from "../../lib/internal";
import { recordShard } from "../../lib/shard-history";
import { downloadFile } from "../data/grid-features";
import type { CsvProblem } from "./csv";
import { coerceCsvDocuments, CsvFormatError, parseCsvDocuments } from "./csv";

interface ExportImportPanelProps {
    /** Shard key the panel targets. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const EXPORT_SHARD = adminRef(ADMIN_FUNCTIONS.exportShard);
const IMPORT_SHARD = adminRef(ADMIN_FUNCTIONS.importShard);
const LIST_TABLES = adminRef(ADMIN_FUNCTIONS.listTables);
const DESCRIBE_TABLE = adminRef(ADMIN_FUNCTIONS.describeTable);
const NO_ARGS: Record<string, unknown> = {};

type Translate = ReturnType<typeof useT>;

/**
 * Serialise export rows to NDJSON — one `{table,doc}` object per line.
 *
 * Encoded with `encodeWire`, not stringified bare. The client `decodeWire`s
 * every admin reply, so a `v.bigint()` column reaches this panel as a real
 * `bigint` (which `JSON.stringify` THROWS on — the whole export fails) and a
 * `v.bytes()` column as an `ArrayBuffer` (which flattens to `{}` — the export
 * "succeeds" and the bytes are gone). The wire codec is identity for pure JSON,
 * so an ordinary table's NDJSON is byte-identical to before, and
 * {@link parseNdjsonLine} decodes symmetrically so the round trip restores types.
 */
const toNdjson = (rows: ExportRow[]): string => rows.map((row) => JSON.stringify(encodeWire(row))).join("\n");

/**
 * Parse one NDJSON line into an export row, or `undefined` for a blank line.
 * Throws on a line that is not a valid `{table, doc}` object so the operator
 * gets a precise failure instead of a partial import.
 *
 * The line is `decodeWire`d — the inverse of {@link toNdjson} — so a bigint /
 * bytes cell is a native value again before `client.query` re-encodes it for the
 * wire. Decoding is identity for pure JSON, so hand-written NDJSON still imports.
 */
const parseNdjsonLine = (rawLine: string, lineNumber: number): ExportRow | undefined => {
    const line = rawLine.trim();

    if (line === "") {
        return undefined;
    }

    const parsed = decodeWire(JSON.parse(line));

    if (typeof parsed !== "object" || parsed === null) {
        throw new LunoraError("INTERNAL", `line ${lineNumber.toString()}: expected a { table, doc } object`);
    }

    const row = parsed as Record<string, unknown>;

    if (typeof row.table !== "string" || typeof row.doc !== "object" || row.doc === null || Array.isArray(row.doc)) {
        throw new LunoraError("INTERNAL", `line ${lineNumber.toString()}: expected a { table, doc } object`);
    }

    return row as unknown as ExportRow;
};

/** Bytes read per piece of an import file. */
const FILE_PIECE_BYTES = 1024 * 1024;

/**
 * Yield a file's lines one at a time, 1-based, reading it in pieces so the whole
 * file is never held as one string. A piece can end mid-line, and mid-character:
 * the decoder keeps a partial character for the next piece and the carry keeps
 * a partial line whole. A line keeps its trailing `\r`, so joining the lines with
 * `\n` rebuilds the file's bytes exactly, which the CSV parser relies on.
 */
const fileLines = async function* (file: Blob): AsyncGenerator<{ line: string; lineNumber: number }> {
    // fatal: a non-UTF-8 file fails validation instead of importing U+FFFD in place of its characters.
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let carry = "";
    let lineNumber = 0;

    for (let offset = 0; offset < file.size; offset += FILE_PIECE_BYTES) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- a piece can only be decoded after the one before it, so the reads are serial by design
        const bytes = await file.slice(offset, offset + FILE_PIECE_BYTES).arrayBuffer(); // eslint-disable-line no-await-in-loop -- pieces are read in file order; each decode depends on the one before
        const lines = `${carry}${decoder.decode(bytes, { stream: true })}`.split("\n");

        carry = lines.pop() ?? "";

        for (const line of lines) {
            lineNumber += 1;

            yield { line, lineNumber };
        }
    }

    const last = carry + decoder.decode();

    if (last !== "") {
        yield { line: last, lineNumber: lineNumber + 1 };
    }
};

/**
 * A row to import and the line it came from. For NDJSON that is the physical line. For CSV it is the record number, the header being
 * record 1: a quoted field can span physical lines, so only the record count stays consecutive, which the server's `startLine` numbering
 * needs.
 */
interface ImportEntry {
    line: number;
    row: ExportRow;
}

/** The rows of a file, re-iterable so the validation pass and the send pass can both walk it. */
type ImportSource = () => AsyncIterable<ImportEntry> | Iterable<ImportEntry>;

const ndjsonEntries = async function* (file: Blob): AsyncGenerator<ImportEntry> {
    for await (const { line, lineNumber } of fileLines(file)) {
        const row = parseNdjsonLine(line, lineNumber);

        if (row !== undefined) {
            yield { line: lineNumber, row };
        }
    }
};

/**
 * Every record of a CSV file as an import entry for `table`. The whole file is decoded and parsed before anything is returned, so a
 * malformed record fails here and nothing is written. The file is held whole because that is the only way to know every record is valid
 * before the first chunk is sent.
 */
const csvEntries = async (file: Blob, table: string, kinds: ReadonlyMap<string, string>): Promise<ImportEntry[]> => {
    const lines: string[] = [];

    for await (const { line } of fileLines(file)) {
        lines.push(line);
    }

    return coerceCsvDocuments(parseCsvDocuments(lines.join("\n")), kinds).map(({ doc, record }) => {
        return { line: record, row: { doc, table } };
    });
};

const openCsvSource = async (file: Blob, table: string, kinds: ReadonlyMap<string, string>): Promise<ImportSource> => {
    const entries = await csvEntries(file, table, kinds);

    return () => entries;
};

/**
 * The validator kind of each column of `table`, from the same `describeTable` read the generate-rows dialog uses. A failed read comes back
 * as the message to show, since a CSV that cannot be checked against its columns must not be sent.
 */
const readColumnKinds = async (
    client: ImportClient,
    t: Translate,
    shardKey: string,
    table: string,
): Promise<{ failure: string } | { kinds: ReadonlyMap<string, string> }> => {
    try {
        const { columns } = (await client.query(DESCRIBE_TABLE, { table }, callOptions(shardKey))) as TableColumnsResult;

        return { kinds: new Map(columns.map((column) => [column.name, column.type])) };
    } catch (error_) {
        return { failure: t("Couldn't read the columns of {table}: {message}", { message: errorMessage(error_), table }) };
    }
};

/** Rows sent per `importShard` call at most. The byte cap below is what keeps wide rows under the body limit. */
const IMPORT_CHUNK_ROWS = 500;

/**
 * Encoded bytes sent per `importShard` call at most, below the runtime's 1 MiB body cap with room for the request envelope. The CLI
 * importer uses the same ceiling: `--batch-size` counts rows, which says nothing about how wide they are.
 */
const IMPORT_CHUNK_BYTES = 900_000;

/** Bytes a row adds to a request: the wire-encoded JSON the client sends, which can be larger than the NDJSON line it came from. */
const wireBytes = (row: ExportRow): number => new TextEncoder().encode(JSON.stringify(encodeWire(row))).byteLength;

/**
 * Count the rows to import, and throw on a row too wide to send alone, so nothing is written for a file that cannot be imported whole. The
 * rows arrive already parsed and checked: a malformed line or record throws in its parser before this runs.
 */
const countRows = async (entries: AsyncIterable<ImportEntry> | Iterable<ImportEntry>): Promise<number> => {
    let rows = 0;

    for await (const { line, row } of entries) {
        if (wireBytes(row) > IMPORT_CHUNK_BYTES) {
            throw new LunoraError("INTERNAL", `line ${line.toString()}: a single row is over the ${IMPORT_CHUNK_BYTES.toString()}-byte import limit`);
        }

        rows += 1;
    }

    return rows;
};

/**
 * Hand the rows to `onChunk` in batches of at most {@link IMPORT_CHUNK_ROWS} rows and {@link IMPORT_CHUNK_BYTES} bytes, in file order,
 * reading them as they come.
 */
const forEachRowChunk = async (
    entries: AsyncIterable<ImportEntry> | Iterable<ImportEntry>,
    onChunk: (rows: ExportRow[], startLine: number) => Promise<void>,
): Promise<void> => {
    let chunk: ExportRow[] = [];
    let chunkBytes = 0;
    let chunkStart = 0;
    let previousLine = 0;

    for await (const { line, row } of entries) {
        const bytes = wireBytes(row);

        // The server numbers a chunk's rows from its first line, so a gap in the numbering must end the chunk.
        const gap = line !== previousLine + 1;

        if (chunk.length > 0 && (gap || chunk.length === IMPORT_CHUNK_ROWS || chunkBytes + bytes > IMPORT_CHUNK_BYTES)) {
            await onChunk(chunk, chunkStart);

            chunk = [];
            chunkBytes = 0;
        }

        if (chunk.length === 0) {
            chunkStart = line;
        }

        chunk.push(row);
        chunkBytes += bytes;
        previousLine = line;
    }

    if (chunk.length > 0) {
        await onChunk(chunk, chunkStart);
    }
};

const CSV_NAME = /\.csv$/iu;

const isCsvFile = (file: File): boolean => CSV_NAME.test(file.name) || file.type === "text/csv";

/** The user-facing text for a structural CSV problem. */
const describeCsvProblem = (problem: CsvProblem, t: Translate): string => {
    if (problem.kind === "duplicate-header") {
        return t("The header “{name}” appears more than once.", { name: problem.name });
    }

    if (problem.kind === "empty-header") {
        return t("Header column {column} is empty.", { column: problem.column });
    }

    if (problem.kind === "ragged") {
        return t("line {line}: expected {expected} cells, found {found}.", {
            expected: problem.expected,
            found: problem.found,
            line: problem.record,
        });
    }

    if (problem.kind === "cell-type") {
        if (problem.expected === "boolean") {
            return t("line {line}: column “{column}” must be true or false, got “{value}”.", {
                column: problem.column,
                line: problem.record,
                value: problem.value,
            });
        }

        if (problem.expected === "bigint") {
            return t("line {line}: column “{column}” must be an integer, got “{value}”.", {
                column: problem.column,
                line: problem.record,
                value: problem.value,
            });
        }

        if (problem.zoneless === true) {
            return t("line {line}: column “{column}” holds “{value}”, a time with no zone. Add Z for UTC or an offset such as +02:00.", {
                column: problem.column,
                line: problem.record,
                value: problem.value,
            });
        }

        if (problem.expected === "date") {
            return t("line {line}: column “{column}” must be an ISO-8601 date or epoch milliseconds, got “{value}”.", {
                column: problem.column,
                line: problem.record,
                value: problem.value,
            });
        }

        if (problem.inexact === true) {
            return t(
                "line {line}: column “{column}” holds “{value}”, which a number column cannot store exactly. Store a whole number past 9007199254740991 in a bigint column.",
                {
                    column: problem.column,
                    line: problem.record,
                    value: problem.value,
                },
            );
        }

        return t("line {line}: column “{column}” must be a number, got “{value}”.", { column: problem.column, line: problem.record, value: problem.value });
    }

    if (problem.kind === "text-after-quote") {
        return t("line {line}: text follows a closing quote.", { line: problem.record });
    }

    return t("line {line}: a quoted field is never closed.", { line: problem.record });
};

/** The failure text for a file that could not be read or checked, named for the format it was picked as. */
const describeInvalidFile = (csvTable: null | string, error: unknown, t: Translate): string => {
    const detail = error instanceof CsvFormatError ? describeCsvProblem(error.problem, t) : errorMessage(error);

    return csvTable === null ? t("Invalid NDJSON: {message}", { message: detail }) : t("Invalid CSV: {message}", { message: detail });
};

interface CsvTablePickerProps {
    readonly onChange: (table: string) => void;
    readonly shardKey: string;
    readonly value: string;
}

/**
 * The table a CSV file's rows go into. A CSV row has no table column to read it from, so the operator names it here; the list is the
 * shard's own tables, so an import cannot target a table that does not exist there.
 */
const CsvTablePicker = ({ onChange, shardKey, value }: CsvTablePickerProps): ReactElement => {
    const t = useT();
    const { data: tables } = useAdminQuery<TableInfo[]>(ADMIN_FUNCTIONS.listTables, NO_ARGS, { shardKey });

    return (
        <div className="flex flex-col gap-1.5">
            <Select
                onValueChange={(next) => {
                    onChange(next ?? "");
                }}
                value={value}
            >
                <SelectTrigger aria-label={t("Target table")} className="w-56" data-testid="ei-csv-table">
                    <SelectValue placeholder={t("Choose a table")} />
                </SelectTrigger>
                <SelectContent>
                    {(tables ?? []).map((table) => (
                        <SelectItem key={table.name} value={table.name}>
                            {table.name}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("CSV rows have no table column, so choose the table they go into.")}</p>
        </div>
    );
};

/** Lines of an export shown inline; the full export is only ever a download. */
const PREVIEW_LINES = 50;

const NDJSON_MIME = "application/x-ndjson";

/**
 * A finished export: the NDJSON as one Blob (never a string in the DOM), its row count and the first lines for display. `shardKey` is the
 * shard it was read from, captured at export time, so the download is named for that shard even if the input changes afterwards.
 */
interface ExportedShard {
    blob: Blob;
    count: number;
    preview: string;
    shardKey: string;
}

/** The client `sendImport` writes through; the panel's own `useLunora()` result. */
type ImportClient = ReturnType<typeof useLunora>;

/**
 * Stream a file into the shard. Resolves `undefined` when every chunk landed; otherwise the message to show and how many rows were
 * written before it stopped. The rows are read and checked in full first, so a malformed line or record is rejected before anything is
 * written; the second pass sends them in chunks as they go, so a large NDJSON file is never held whole. `csvTable` is the target of a
 * CSV file and `null` for NDJSON, whose lines carry their own table.
 */
const sendImport = async (
    client: ImportClient,
    t: Translate,
    shardKey: string,
    onProgress: (text: string) => void,
    file: File,
    csvTable: null | string,
): Promise<{ failure: { message: string; rows: number } | undefined; total: ImportShardResult }> => {
    const total: ImportShardResult = { conflicts: 0, errors: [], inserted: {} };
    let prepared: { rows: number; source: ImportSource };

    // A CSV cell is coerced to its column's kind, so the kinds must be read first. Without them the file cannot be checked, and it is
    // refused here rather than sent as text the writer would reject row by row.
    const kindsRead = csvTable === null ? { kinds: new Map<string, string>() } : await readColumnKinds(client, t, shardKey, csvTable);

    if ("failure" in kindsRead) {
        return { failure: { message: kindsRead.failure, rows: 0 }, total };
    }

    const { kinds } = kindsRead;

    try {
        const source: ImportSource = csvTable === null ? () => ndjsonEntries(file) : await openCsvSource(file, csvTable, kinds);

        prepared = { rows: await countRows(source()), source };
    } catch (error_) {
        return { failure: { message: describeInvalidFile(csvTable, error_, t), rows: 0 }, total };
    }

    const { rows: rowCount, source } = prepared;

    if (csvTable !== null && rowCount === 0) {
        return { failure: { message: t("The CSV has no data rows after the header."), rows: 0 }, total };
    }

    // The first pass has the server check every chunk and write nothing. Its answer covers the whole file: a bad row in the last chunk
    // refuses the import before the first chunk lands, where a single pass would have written every chunk before it. The check covers the
    // shape only. An `_id` already in use, a cross-table collision and a foreign-key or unique failure are found by the real pass.
    const check: ImportShardResult = { conflicts: 0, errors: [], inserted: {} };

    onProgress(t("Checking {total} rows before writing…", { total: rowCount }));

    try {
        await forEachRowChunk(source(), async (rows, startLine) => {
            const result = (await client.query(IMPORT_SHARD, { dryRun: true, rows, startLine }, callOptions(shardKey))) as ImportShardResult;

            // A check never inserts and never meets a conflict. A server that predates dry runs ignores the flag and writes, and the real pass
            // would then write every row again, so stop on the first chunk that shows a write.
            if (result.conflicts > 0 || Object.values(result.inserted).some((count) => count > 0)) {
                throw new Error(t("This server cannot check an import before writing, so the check may already have written rows. Nothing more was sent."));
            }

            check.errors.push(...result.errors);
        });
    } catch (error_) {
        return { failure: { message: errorMessage(error_), rows: 0 }, total };
    }

    if (check.errors.length > 0) {
        return {
            failure: { message: t("Nothing was written, because some rows would be refused. Fix the rows listed below and import again."), rows: 0 },
            total: check,
        };
    }

    let sent = 0;

    const sendChunk = async (rows: ExportRow[], startLine: number): Promise<void> => {
        onProgress(
            t("Importing rows {from}–{to} of {total}…", {
                from: sent + 1,
                to: sent + rows.length,
                total: rowCount,
            }),
        );

        const result = (await client.query(IMPORT_SHARD, { dryRun: false, rows, startLine }, callOptions(shardKey))) as ImportShardResult;

        total.conflicts += result.conflicts;
        total.errors.push(...result.errors);

        for (const [table, count] of Object.entries(result.inserted)) {
            total.inserted[table] = (total.inserted[table] ?? 0) + count;
        }

        sent += rows.length;
    };

    try {
        await forEachRowChunk(source(), sendChunk);

        return { failure: undefined, total };
    } catch (error_) {
        // Chunks sent before the failure may already have written rows; the caller shows their counts next to the error.
        return { failure: { message: errorMessage(error_), rows: sent }, total };
    }
};

/**
 * Snapshot and restore a single shard's data as NDJSON.
 *
 * "Export" walks the shard's tables one `__lunora_admin__:exportShard` call at a
 * time (`tables: [name]`), appending each page's NDJSON to a `Blob` the operator
 * downloads; only the first {@link PREVIEW_LINES} lines are rendered, so a large
 * shard never lands in one textarea. "Import" reads an NDJSON file, or a CSV file
 * into the table the operator picks, and replays it through
 * `__lunora_admin__:importShard` in chunks of {@link IMPORT_CHUNK_ROWS} rows,
 * reporting progress and then the summed inserted counts, id conflicts and
 * per-row errors. Globally-scoped (`.global()`) tables live in D1 and are
 * intentionally out of scope here.
 *
 * Both calls travel over the {@link useLunora} client transport and are gated by
 * the server's `LUNORA_ADMIN_TOKEN`.
 */
export const ExportImportPanel = ({ initialShardKey }: ExportImportPanelProps): ReactElement => {
    const client = useLunora();
    const invalidateAdmin = useInvalidateAdmin();
    const t = useT();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [importFile, setImportFile] = useState<File | null>(null);
    // The CSV target is tied to the shard it was picked in, so switching shards clears it during render, not in an effect.
    const [csvPick, setCsvPick] = useState<{ shardKey: string; table: string } | null>(null);
    const [busy, setBusy] = useState<boolean>(false);
    const [error, setError] = useState<null | string>(null);
    const [importResult, setImportResult] = useState<ImportShardResult | null>(null);
    const [progress, setProgress] = useState<null | string>(null);
    const [exported, setExported] = useState<ExportedShard | null>(null);

    const csvFile = importFile !== null && isCsvFile(importFile);
    const csvTarget = csvPick !== null && csvPick.shardKey === shardKey ? csvPick.table : "";
    const importReady = importFile !== null && (!csvFile || csvTarget !== "");

    const exportShard = async (): Promise<void> => {
        const exportedShardKey = shardKey;

        setBusy(true);
        setError(null);
        setImportResult(null);
        setExported(null);

        try {
            const tables = (await client.query(LIST_TABLES, {}, callOptions(exportedShardKey))) as ReadonlyArray<TableInfo>;
            let blob = new Blob([], { type: NDJSON_MIME });
            let count = 0;
            const preview: string[] = [];

            for (const { name } of tables) {
                // eslint-disable-next-line no-await-in-loop -- one table per call, appended in order, so the whole shard is never one response
                const { rows } = (await client.query(EXPORT_SHARD, { tables: [name] }, callOptions(exportedShardKey))) as { rows: ExportRow[] };

                if (rows.length === 0) {
                    continue;
                }

                const text = toNdjson(rows);

                blob = new Blob([blob, `${text}\n`], { type: NDJSON_MIME });
                count += rows.length;

                if (preview.length < PREVIEW_LINES) {
                    preview.push(...text.split("\n").slice(0, PREVIEW_LINES - preview.length));
                }
            }

            recordShard(exportedShardKey);
            setExported({ blob, count, preview: preview.join("\n"), shardKey: exportedShardKey });
        } catch (error_) {
            setError(errorMessage(error_));
        }
    };

    const importShard = async (file: File, csvTable: null | string): Promise<void> => {
        setBusy(true);
        setError(null);
        setImportResult(null);
        setExported(null);

        const { failure, total } = await sendImport(client, t, shardKey, setProgress, file, csvTable);

        if (failure === undefined) {
            recordShard(shardKey);
            setImportResult(total);
        } else if (failure.rows > 0) {
            setImportResult(total);
            setError(
                t("Import stopped after {rows} rows: {message}. The counts below cover completed chunks only; the failed chunk may also have written rows.", {
                    message: failure.message,
                    rows: failure.rows,
                }),
            );
        } else {
            // A refused file names its bad rows, so the errors are shown with the message that says nothing was written.
            if (total.errors.length > 0) {
                setImportResult(total);
            }

            setError(failure.message);
        }

        // The import wrote rows to this shard (possibly only some chunks), so the data
        // browser's cached reads are now stale across every page/filter variant — drop
        // them (path-only, all args) so they re-fetch on next view.
        invalidateAdmin(ADMIN_FUNCTIONS.readTablePage);
        invalidateAdmin(ADMIN_FUNCTIONS.listTables);
    };

    const insertedTotal = importResult === null ? 0 : Object.values(importResult.inserted).reduce((sum, count) => sum + count, 0);

    // The busy flag clears on every settle, rejection included, so a failed run never leaves the panel stuck.
    const runExport = (): void => {
        fireAndForget(
            exportShard().finally(() => {
                setBusy(false);
            }),
        );
    };

    const runImport = (): void => {
        if (importFile !== null && importReady) {
            fireAndForget(
                importShard(importFile, csvFile ? csvTarget : null).finally(() => {
                    setProgress(null);
                    setBusy(false);
                }),
            );
        }
    };

    const download = (): void => {
        if (exported !== null) {
            downloadFile(`${exported.shardKey.trim() === "" ? "shard" : exported.shardKey.trim()}.ndjson`, exported.blob, NDJSON_MIME);
        }
    };

    const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setImportFile(event.target.files?.[0] ?? null);
    };

    const onCsvTableChange = (table: string): void => {
        setCsvPick({ shardKey, table });
    };

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-export-import">
            <Card className="gap-0 py-0 rounded-xl border border-border bg-card shadow-xs">
                <header className="border-b border-border px-4 py-3">
                    <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Export")}</span>
                </header>
                <CardContent className="flex flex-col gap-3 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <ShardInput onChange={setShardKey} testId="ei-shard-input" value={shardKey} />
                        <Button data-testid="ei-export" disabled={busy} onClick={runExport} type="button">
                            {t("Export")}
                        </Button>
                    </div>

                    {exported !== null && (
                        <div className="flex flex-col gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                                <p className="text-sm text-muted-foreground" data-testid="ei-export-result">
                                    {t("Exported {count} rows.", { count: exported.count })}
                                </p>
                                <Button data-testid="ei-download" onClick={download} size="sm" type="button" variant="outline">
                                    {t("Download")}
                                </Button>
                            </div>
                            {exported.preview !== "" && (
                                <pre
                                    className="max-h-60 overflow-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-xs"
                                    data-testid="ei-preview"
                                >
                                    {exported.preview}
                                </pre>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>

            <Card className="gap-0 py-0 rounded-xl border border-border bg-card shadow-xs">
                <header className="border-b border-border px-4 py-3">
                    <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Import")}</span>
                </header>
                <CardContent className="flex flex-col gap-3 p-4">
                    <input
                        accept=".ndjson,.jsonl,.csv,application/x-ndjson,text/csv"
                        aria-label={t("Import file")}
                        className="text-sm"
                        data-testid="ei-file"
                        onChange={onFileChange}
                        type="file"
                    />

                    {csvFile && <CsvTablePicker onChange={onCsvTableChange} shardKey={shardKey} value={csvTarget} />}

                    <div className="flex flex-wrap items-center gap-2">
                        <ConfirmButton confirmLabel={t("Import (writes rows)?")} disabled={busy || !importReady} onConfirm={runImport} testId="ei-import">
                            {t("Import")}
                        </ConfirmButton>
                    </div>

                    {progress !== null && (
                        <p className="text-sm text-muted-foreground" data-testid="ei-progress" role="status">
                            {progress}
                        </p>
                    )}

                    {importResult !== null && (
                        <div className="flex flex-col gap-2" data-testid="ei-import-result">
                            <p className="text-sm text-muted-foreground">
                                {t("Inserted {inserted}, {conflicts} conflicts, {errors} errors.", {
                                    conflicts: importResult.conflicts,
                                    errors: importResult.errors.length,
                                    inserted: insertedTotal,
                                })}
                            </p>
                            {importResult.errors.length > 0 && (
                                <ul className="flex flex-col gap-1" data-testid="ei-import-errors">
                                    {importResult.errors.map((rowError) => (
                                        <li className="text-xs text-destructive" key={`${rowError.table}-${rowError.line.toString()}`}>
                                            {t("line {line} ({table}): {message}", {
                                                line: rowError.line,
                                                message: rowError.message,
                                                table: rowError.table,
                                            })}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="ei-error" role="alert">
                    {error}
                </p>
            )}
        </div>
    );
};

export type { ExportImportPanelProps };
