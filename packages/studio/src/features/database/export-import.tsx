import { LunoraError } from "@lunora/errors";
import { decodeWire, encodeWire } from "@lunora/wire";
import type { ChangeEvent, ReactElement } from "react";
import { useRef, useState } from "react";

import { createExportEndTracker, exportEndLine } from "../../../../../shared/export-end";
import { ConfirmButton } from "../../components/confirm-button";
import { ShardInput } from "../../components/shard-input";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { useAdminQuery, useInvalidateAdmin } from "../../hooks/use-admin-query";
import useStudioClient from "../../hooks/use-studio-client";
import { useT } from "../../i18n/i18n-context";
import type { ExportRow, ImportShardResult, TableColumnsResult, TableInfo } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget } from "../../lib/internal";
import { recordShard } from "../../lib/shard-history";
import { downloadFile } from "../data/grid-features";
import type { CsvProblem } from "./csv";
import { checkCsvDocuments, CsvFormatError, nullOnEmptyColumns, readCsvDocuments } from "./csv";

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
 * {@link rowFromJson} decodes symmetrically so the round trip restores types.
 */
const toNdjson = (rows: ExportRow[]): string => rows.map((row) => JSON.stringify(encodeWire(row))).join("\n");

/**
 * An export row from one parsed NDJSON line. Throws on a line that is not a valid `{table, doc}` object so the operator gets a precise
 * failure instead of a partial import.
 *
 * The line is `decodeWire`d, the inverse of {@link toNdjson}, so a bigint / bytes cell is a native value again before `client.query`
 * re-encodes it for the wire. Decoding is identity for pure JSON.
 */
const rowFromJson = (json: unknown, lineNumber: number): ExportRow => {
    const parsed = decodeWire(json);

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
 * The text of a file, decoded from UTF-8 a piece at a time, so a CSV is parsed as it is read and never held whole. Fatal on bad UTF-8: a
 * non-UTF-8 file fails the check instead of importing U+FFFD in place of its characters.
 */
const fileText = async function* (file: Blob): AsyncGenerator<string> {
    const decoder = new TextDecoder("utf-8", { fatal: true });

    for (let offset = 0; offset < file.size; offset += FILE_PIECE_BYTES) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- a piece can only be decoded after the one before it, so the reads are serial by design
        const bytes = await file.slice(offset, offset + FILE_PIECE_BYTES).arrayBuffer(); // eslint-disable-line no-await-in-loop -- pieces are read in file order; each decode depends on the one before

        yield decoder.decode(bytes, { stream: true });
    }

    const last = decoder.decode();

    if (last !== "") {
        yield last;
    }
};

/**
 * Yield a file's lines one at a time, 1-based, reading it in pieces so the whole
 * file is never held as one string. A piece can end mid-line, and mid-character:
 * the decoder keeps a partial character for the next piece and the carry keeps
 * a partial line whole. A line keeps its trailing `\r`, which `JSON.parse` reads
 * as whitespace, so an NDJSON line parses the same with or without it.
 */
const fileLines = async function* (file: Blob): AsyncGenerator<{ line: string; lineNumber: number }> {
    let carry = "";
    let lineNumber = 0;

    for await (const text of fileText(file)) {
        const lines = `${carry}${text}`.split("\n");

        carry = lines.pop() ?? "";

        for (const line of lines) {
            lineNumber += 1;

            yield { line, lineNumber };
        }
    }

    if (carry !== "") {
        yield { line: carry, lineNumber: lineNumber + 1 };
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
    // An export ends with a marker carrying its row count. A file cut on a row boundary still parses as a smaller export, so the file
    // is only complete when the marker is there and agrees; the check pass reads the whole file first, so nothing is written otherwise.
    const end = createExportEndTracker();

    for await (const { line, lineNumber } of fileLines(file)) {
        const trimmed = line.trim();

        if (trimmed === "") {
            continue;
        }

        const json: unknown = JSON.parse(trimmed);

        if (!end.read(json)) {
            continue;
        }

        yield { line: lineNumber, row: rowFromJson(json, lineNumber) };
    }

    const problem = end.problem();

    if (problem !== undefined) {
        throw new LunoraError("INTERNAL", problem);
    }
};

/**
 * Every record of a CSV file as an import entry for `table`. Each pass reads the file again and coerces a row only when it is reached.
 * {@link checkCsv} has read the whole file first, so a malformed record is refused before anything is written and never surfaces here.
 */
const csvEntries = async function* (
    file: Blob,
    table: string,
    kinds: ReadonlyMap<string, string>,
    nullOnEmpty: ReadonlySet<string>,
): AsyncGenerator<ImportEntry> {
    for await (const { doc, record } of readCsvDocuments(fileText(file), kinds, nullOnEmpty)) {
        yield { line: record, row: { doc, table } };
    }
};

/**
 * The validator kind of each column of `table`, from the same `describeTable` read the generate-rows dialog uses, and the columns whose blank
 * cell is stored as null: nullable and not optional. An optional column is left out instead, so the server takes its default. A failed read
 * comes back as the message to show, since a CSV that cannot be checked against its columns must not be sent.
 */
const readColumnKinds = async (
    client: ImportClient,
    t: Translate,
    shardKey: string,
    table: string,
): Promise<{ failure: string } | { kinds: ReadonlyMap<string, string>; nullOnEmpty: ReadonlySet<string> }> => {
    try {
        const { columns } = (await client.query(DESCRIBE_TABLE, { table }, callOptions(shardKey))) as TableColumnsResult;

        return {
            kinds: new Map(columns.map((column) => [column.name, column.type])),
            nullOnEmpty: nullOnEmptyColumns(columns),
        };
    } catch (error_) {
        return { failure: t("Couldn't read the columns of {table}: {message}", { message: errorMessage(error_), table }) };
    }
};

/** Lines of an export shown inline; the full export is only ever a download. */
const PREVIEW_LINES = 50;

/** Rows sent per `importShard` call at most. The byte cap below is what keeps wide rows under the body limit. */
const IMPORT_CHUNK_ROWS = 500;

/**
 * Encoded bytes sent per `importShard` call at most, below the runtime's 1 MiB body cap with room for the request envelope. The CLI
 * importer uses the same ceiling: `--batch-size` counts rows, which says nothing about how wide they are.
 */
const IMPORT_CHUNK_BYTES = 900_000;

/** Bytes a row adds to a request: the wire-encoded JSON the client sends, which can be larger than the NDJSON line it came from. */
const wireBytes = (row: ExportRow): number => new TextEncoder().encode(JSON.stringify(encodeWire(row))).byteLength;

const NDJSON_MIME = "application/x-ndjson";

/** The error for a row too wide to send alone, so nothing is written for a file that cannot be imported whole. */
const wideRowError = (line: number): LunoraError =>
    new LunoraError("INTERNAL", `line ${line.toString()}: a single row is over the ${IMPORT_CHUNK_BYTES.toString()}-byte import limit`);

/**
 * Count the rows of an NDJSON file, and throw on a row too wide to send alone. A malformed line throws in its parser before this runs.
 */
const countRows = async (entries: AsyncIterable<ImportEntry> | Iterable<ImportEntry>): Promise<number> => {
    let rows = 0;

    for await (const { line, row } of entries) {
        if (wireBytes(row) > IMPORT_CHUNK_BYTES) {
            throw wideRowError(line);
        }

        rows += 1;
    }

    return rows;
};

/**
 * Read a CSV file once: check every record, count its rows, and throw on a row too wide to send alone. A wide row is held back until the
 * whole file has parsed, so a malformed record is reported first, as a whole-file parse would report it. Nothing is written by this pass.
 */
const checkCsv = async (file: Blob, table: string, kinds: ReadonlyMap<string, string>, nullOnEmpty: ReadonlySet<string>): Promise<number> => {
    const count: { rows: number; wide?: number } = { rows: 0 };

    await checkCsvDocuments(fileText(file), kinds, nullOnEmpty, ({ doc, record }) => {
        count.rows += 1;

        if (count.wide === undefined && wireBytes({ doc, table }) > IMPORT_CHUNK_BYTES) {
            count.wide = record;
        }
    });

    if (count.wide !== undefined) {
        throw wideRowError(count.wide);
    }

    return count.rows;
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

/** The user-facing text for a CSV cell that does not fit its column. */
const describeCellProblem = (problem: Extract<CsvProblem, { kind: "cell-type" }>, t: Translate): string => {
    if (problem.expected === "boolean") {
        return t("line {line}: column “{column}” must be true or false, got “{value}”.", {
            column: problem.column,
            line: problem.record,
            value: problem.value,
        });
    }

    if (problem.tooLong === true) {
        return t("line {line}: column “{column}” holds an integer longer than the import can send.", {
            column: problem.column,
            line: problem.record,
        });
    }

    if (problem.expected === "bigint") {
        return t("line {line}: column “{column}” must be an integer, got “{value}”.", {
            column: problem.column,
            line: problem.record,
            value: problem.value,
        });
    }

    if (problem.expected === "date") {
        return t("line {line}: column “{column}” must be an ISO-8601 date or epoch milliseconds of at least 11 digits, got “{value}”.", {
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
};

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
        return describeCellProblem(problem, t);
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

/** The client `sendImport` writes through; the panel's own `useStudioClient()` result. */
type ImportClient = ReturnType<typeof useStudioClient>;

/** A shard's answer to an `importShard` check: the echo of `dryRun` marks one that honoured the flag. */
type DryRunAnswer = ImportShardResult & { dryRun?: boolean };

/**
 * Why an import stopped. `refused` marks a failure whose message already says what was written. `nextLine` is the line after the last
 * completed chunk, which is where an import that stopped between two requests has to resume.
 */
interface ImportFailure {
    message: string;
    nextLine?: number;
    refused?: true;
    rows: number;
    unknownFrom?: number;
}

/** The rows a shard reported as written, summed over its tables. */
const insertedRowCount = (inserted: Record<string, number>): number => Object.values(inserted).reduce((sum, count) => sum + count, 0);

/** How an import treats the rows the shard already holds; the same four modes as `lunora import --mode`. */
type ImportMode = "append" | "replace" | "require-empty" | "upsert";

/** Delete rows as import entries, numbered from 1: a delete names the `_id` to remove, and the shard is already addressed. */
const deleteEntries = (deletions: ReadonlyArray<ExportRow>): ImportEntry[] =>
    deletions.map((row, index) => {
        return { line: index + 1, row };
    });

/** The file's rows per table: how many, which `_id`s, how many repeat one, and how many carry none. */
const indexSource = async (
    entries: AsyncIterable<ImportEntry> | Iterable<ImportEntry>,
): Promise<Map<string, { duplicates: number; ids: Set<string>; rows: number; unkeyed: number }>> => {
    const source = new Map<string, { duplicates: number; ids: Set<string>; rows: number; unkeyed: number }>();

    for await (const { row } of entries) {
        const entry = source.get(row.table) ?? { duplicates: 0, ids: new Set<string>(), rows: 0, unkeyed: 0 };
        const id = row.doc["_id"];

        source.set(row.table, entry);
        entry.rows += 1;

        if (typeof id === "string") {
            if (entry.ids.has(id)) {
                entry.duplicates += 1;
            }

            entry.ids.add(id);
        } else {
            entry.unkeyed += 1;
        }
    }

    return source;
};

/**
 * What an import would do to the shard: per table the rows it adds, the stored rows its `_id`s match, and, under `replace`, the stored
 * rows it deletes. Reads the shard's rows for the file's tables, one table per call.
 */
const planShardImport = async (
    client: ImportClient,
    shardKey: string,
    entries: AsyncIterable<ImportEntry> | Iterable<ImportEntry>,
    mode: ImportMode,
): Promise<{ deletions: ExportRow[]; lines: string[]; tables: { stored: number; table: string }[] }> => {
    const source = await indexSource(entries);

    // A row with no `_id` is written under a fresh one, so a replace could never match it to what a previous run stored: the prune would
    // delete the earlier copy and the write recreate it under a different id, on every run.
    const unkeyed = mode === "replace" ? [...source].find(([, entry]) => entry.unkeyed > 0) : undefined;

    if (unkeyed !== undefined) {
        throw new LunoraError("INTERNAL", `Replace needs every row to carry an _id: ${unkeyed[1].unkeyed.toString()} row(s) of ${unkeyed[0]} have none`);
    }

    const deletions: ExportRow[] = [];
    const lines: string[] = [];
    const tables: { stored: number; table: string }[] = [];

    for (const [table, entry] of [...source].toSorted(([a], [b]) => a.localeCompare(b))) {
        // eslint-disable-next-line no-await-in-loop -- one table per call, so a large shard is never one response
        const { rows } = (await client.query(EXPORT_SHARD, { tables: [table] }, callOptions(shardKey))) as { rows: ExportRow[] };
        let add = entry.rows - entry.duplicates;
        let existing = entry.duplicates;
        let toDelete = 0;

        for (const stored of rows) {
            const id = stored.doc["_id"];

            if (typeof id === "string" && entry.ids.has(id)) {
                existing += 1;
                add -= 1;
            } else if (mode === "replace" && typeof id === "string") {
                toDelete += 1;
                deletions.push({ doc: { _id: id }, op: "delete", table } as unknown as ExportRow);
            }
        }

        tables.push({ stored: rows.length, table });
        lines.push(
            `${table}: ${entry.rows.toString()} in file, ${rows.length.toString()} stored — ${add.toString()} to add, ${existing.toString()} existing, ${toDelete.toString()} to delete`,
        );
    }

    return { deletions, lines, tables };
};

/**
 * The part of an import that depends on what the shard already holds: the plan, `require-empty`'s refusal, and the check of the deletes a
 * `replace` would make. A failure comes back with the totals to show; otherwise the deletions to send after the file's rows.
 */
const decideFromPlan = async (options: {
    client: ImportClient;
    mode: ImportMode;
    onConflict: "replace" | "skip";
    planOnly: boolean;
    shardKey: string;
    source: ImportSource;
    t: Translate;
}): Promise<{ deletions: ExportRow[]; plan?: string[] } | { failure: ImportFailure; plan?: string[]; total?: ImportShardResult }> => {
    const { client, mode, onConflict, planOnly, shardKey, source, t } = options;

    // `replace` and `require-empty` need the plan to decide; `upsert` and `append` only show it on request, since it costs a read of
    // every stored row of the file's tables.
    if (mode !== "replace" && mode !== "require-empty" && !planOnly) {
        return { deletions: [] };
    }

    let planned: Awaited<ReturnType<typeof planShardImport>>;

    try {
        planned = await planShardImport(client, shardKey, source(), mode);
    } catch (error_) {
        return { failure: { message: errorMessage(error_), rows: 0 } };
    }

    const occupied = planned.tables.find((entry) => entry.stored > 0);

    if (mode === "require-empty" && occupied !== undefined) {
        return {
            failure: {
                message: t("Nothing was sent: --mode require-empty needs the file's tables to hold no rows, and {table} already holds {count}.", {
                    count: occupied.stored,
                    table: occupied.table,
                }),
                rows: 0,
            },
            plan: planned.lines,
        };
    }

    // The deletes are checked before the first row is written, so a shard that would refuse them leaves the data as it was.
    const refused: ImportShardResult = { conflicts: 0, errors: [], inserted: {} };

    if (!planOnly && planned.deletions.length > 0) {
        try {
            await forEachRowChunk(deleteEntries(planned.deletions), async (rows, startLine) => {
                const result = (await client.query(
                    IMPORT_SHARD,
                    { deletes: true, dryRun: true, onConflict, rows, startLine },
                    callOptions(shardKey),
                )) as ImportShardResult;

                refused.errors.push(...result.errors);
            });
        } catch (error_) {
            return { failure: { message: errorMessage(error_), rows: 0 } };
        }

        if (refused.errors.length > 0) {
            return {
                failure: { message: t("Nothing was written, because some deletes would be refused. Fix the rows listed below and import again."), rows: 0 },
                total: refused,
            };
        }
    }

    return { deletions: planned.deletions, plan: planned.lines };
};

/**
 * Remove the stored rows a `replace` found the file lacks. Runs after every file row is written and clean, so a failed run never leaves
 * fewer rows than before, and a re-run converges.
 */
const pruneStored = async (options: {
    client: ImportClient;
    deletions: ReadonlyArray<ExportRow>;
    onConflict: "replace" | "skip";
    onProgress: (text: string) => void;
    shardKey: string;
    t: Translate;
    total: ImportShardResult;
}): Promise<void> => {
    const { client, deletions, onConflict, onProgress, shardKey, t, total } = options;

    await forEachRowChunk(deleteEntries(deletions), async (rows, startLine) => {
        onProgress(t("Deleting {count} stored rows the file lacks…", { count: deletions.length }));

        const result = (await client.query(
            IMPORT_SHARD,
            { deletes: true, dryRun: false, onConflict, rows, startLine },
            callOptions(shardKey),
        )) as ImportShardResult;

        total.deleted = (total.deleted ?? 0) + (result.deleted ?? 0);
        total.errors.push(...result.errors);
    });

    if (total.errors.length > 0) {
        throw new Error(total.errors[0]?.message ?? "a delete was refused");
    }
};

/** The confirmation on the Import button: what this mode will do to the shard's stored rows. */
const importConfirmLabel = (mode: ImportMode, t: Translate): string => {
    if (mode === "replace") {
        return t("Import (overwrites rows and may delete rows)?");
    }

    return mode === "upsert" ? t("Import (overwrites rows)?") : t("Import (writes rows)?");
};

/** Why the shard cannot honour the import, read from its answer to the empty probe, or `undefined` when it can. */
const probeRefusal = (probe: DryRunAnswer, mode: ImportMode, onConflict: "replace" | "skip", t: Translate): string | undefined => {
    if (probe.dryRun !== true) {
        return t("This shard predates import checks, so it would write the file while checking it. Nothing was sent. Update the app and import again.");
    }

    // A shard built before replace imports ignores the mode and would report every existing row as a conflict; one that has it
    // always answers with a `replaced` count, even for no rows.
    if (onConflict === "replace" && typeof probe.replaced !== "number") {
        return t("This shard cannot overwrite existing rows. Nothing was sent. Update the app and import again.");
    }

    // A shard built before delete rows ignores the flag and the rows; one that has them always answers with a `deleted` count.
    return mode === "replace" && typeof probe.deleted !== "number"
        ? t("This shard cannot delete rows. Nothing was sent. Update the app and import again.")
        : undefined;
};

/** What a finished import shows: the counts (when any row was written or refused) and the message to put beside them. */
const importOutcome = (failure: ImportFailure | undefined, total: ImportShardResult, t: Translate): { error?: string; result?: ImportShardResult } => {
    if (failure === undefined) {
        return { result: total };
    }

    if (failure.unknownFrom === undefined && (failure.refused === true || failure.rows === 0)) {
        // A refusal names its bad rows and its message already says how many rows were written, so it is shown as it is. So is a
        // failure before any chunk was sent, where nothing was written.
        return { error: failure.message, ...(total.errors.length > 0 ? { result: total } : {}) };
    }

    if (failure.unknownFrom === undefined) {
        // The file could not be read for the next chunk, so no request is in doubt but the chunks before it are written.
        return {
            error: t(
                "Import stopped after {rows} rows: {message}. The counts below cover those rows. Rows from line {line} onward were not sent: do not import the whole file again, import from that line onward, or delete the written rows first and then import the whole file.",
                { line: failure.nextLine, message: failure.message, rows: failure.rows },
            ),
            result: total,
        };
    }

    // A request that never answered: its chunk may have written rows, whatever the completed chunks reported.
    return {
        error: t(
            "Import stopped after {rows} rows: {message}. The counts below cover completed chunks only. The chunk from line {line} may have written rows: check the table for rows from line {line} onward before importing again, or delete the written rows first and then import the whole file.",
            { line: failure.unknownFrom, message: failure.message, rows: failure.rows },
        ),
        result: total,
    };
};

/**
 * Stream a file into the shard. Resolves `undefined` when every chunk landed; otherwise the message to show, how many rows the completed
 * chunks sent, and, when a chunk's request failed without an answer, the line that chunk starts at: its rows may have been written. The file
 * is read in full first, so a malformed line or record is rejected before anything is written. Each later pass reads the file again and
 * sends its rows in chunks as they go, so neither format is held whole. `csvTable` is the target of a CSV file and `null` for NDJSON, whose
 * lines carry their own table.
 */
const sendImport = async (
    client: ImportClient,
    t: Translate,
    shardKey: string,
    onProgress: (text: string) => void,
    file: File,
    csvTable: null | string,
    mode: ImportMode,
    planOnly: boolean,
): Promise<{ failure: ImportFailure | undefined; plan?: string[]; total: ImportShardResult }> => {
    const onConflict = mode === "upsert" || mode === "replace" ? "replace" : "skip";
    const total: ImportShardResult = { conflicts: 0, deleted: 0, errors: [], inserted: {}, replaced: 0 };
    let prepared: { rows: number; source: ImportSource };

    // A CSV cell is coerced to its column's kind, so the kinds must be read first. Without them the file cannot be checked, and it is
    // refused here rather than sent as text the writer would reject row by row.
    const kindsRead =
        csvTable === null ? { kinds: new Map<string, string>(), nullOnEmpty: new Set<string>() } : await readColumnKinds(client, t, shardKey, csvTable);

    if ("failure" in kindsRead) {
        return { failure: { message: kindsRead.failure, rows: 0 }, total };
    }

    const { kinds, nullOnEmpty } = kindsRead;

    try {
        if (csvTable === null) {
            const source: ImportSource = () => ndjsonEntries(file);

            prepared = { rows: await countRows(source()), source };
        } else {
            prepared = { rows: await checkCsv(file, csvTable, kinds, nullOnEmpty), source: () => csvEntries(file, csvTable, kinds, nullOnEmpty) };
        }
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
        // A shard built before dry runs ignores the flag and writes every row it is sent, and the check would learn that only after the
        // rows are in. So the first request carries no row, which no shard version can write, and only a shard that honours the flag
        // echoes `dryRun: true` in its answer.
        const probe = (await client.query(IMPORT_SHARD, { dryRun: true, onConflict, rows: [], startLine: 1 }, callOptions(shardKey))) as DryRunAnswer;

        const unsupported = probeRefusal(probe, mode, onConflict, t);

        if (unsupported !== undefined) {
            return { failure: { message: unsupported, rows: 0 }, total };
        }

        await forEachRowChunk(source(), async (rows, startLine) => {
            const result = (await client.query(IMPORT_SHARD, { dryRun: true, onConflict, rows, startLine }, callOptions(shardKey))) as ImportShardResult;

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

    const planned = await decideFromPlan({ client, mode, onConflict, planOnly, shardKey, source, t });

    if ("failure" in planned) {
        return { failure: planned.failure, plan: planned.plan, total: planned.total ?? total };
    }

    if (planOnly) {
        return { failure: undefined, plan: planned.plan, total };
    }

    const { deletions } = planned;

    let sent = 0;
    let nextLine = 1;
    // Set when the shard refused rows, whose message says what was written.
    const stop: { refused?: true } = {};
    // The start line of the chunk whose request has not answered yet. A request that fails without an answer leaves its rows' fate unknown.
    const pending: { startLine?: number } = {};

    const sendChunk = async (rows: ExportRow[], startLine: number): Promise<void> => {
        onProgress(
            t("Importing rows {from}–{to} of {total}…", {
                from: sent + 1,
                to: sent + rows.length,
                total: rowCount,
            }),
        );

        pending.startLine = startLine;

        const result = (await client.query(IMPORT_SHARD, { dryRun: false, onConflict, rows, startLine }, callOptions(shardKey))) as ImportShardResult;

        pending.startLine = undefined;
        total.conflicts += result.conflicts;
        total.deleted = (total.deleted ?? 0) + (result.deleted ?? 0);
        total.replaced = (total.replaced ?? 0) + (result.replaced ?? 0);
        total.errors.push(...result.errors);

        for (const [table, count] of Object.entries(result.inserted)) {
            total.inserted[table] = (total.inserted[table] ?? 0) + count;
        }

        sent += rows.length;
        nextLine = startLine + rows.length;

        // The shard refused rows that the check let through, so the rest of the file is not sent. The thrown error reaches the
        // caller's catch, which keeps the structured errors above for display. Rows the shard accepted are already written, so the
        // message names how many and where a re-import has to resume; a whole-file re-import would write them twice.
        if (result.errors.length > 0) {
            // An overwritten row has landed too, so it counts as written.
            const written = insertedRowCount(total.inserted) + (total.replaced ?? 0);

            stop.refused = true;

            throw new Error(
                written === 0
                    ? t(
                          "The shard refused {count} rows, so the rest of the file was not sent. Nothing was written. Fix the rows listed below and import again.",
                          {
                              count: result.errors.length,
                          },
                      )
                    : t(
                          "The shard refused {count} rows, so the rest of the file was not sent. {written} rows were already written, so do not import the whole file again. Import the refused rows and any rows from line {line} onward, or delete the written rows first and then import the whole file.",
                          {
                              count: result.errors.length,
                              line: startLine + rows.length,
                              written,
                          },
                      ),
            );
        }
    };

    try {
        await forEachRowChunk(source(), sendChunk);

        try {
            await pruneStored({ client, deletions, onConflict, onProgress, shardKey, t, total });
        } catch (error_) {
            // Every file row is written; only the removal of the rows the file lacks failed, and a delete may have landed. The file-row
            // resumption text would send the operator to a line that was already sent.
            return {
                failure: {
                    message: t(
                        "Every file row is written, but removing the stored rows the file lacks failed: {message}. Import again to finish the deletes.",
                        {
                            message: errorMessage(error_),
                        },
                    ),
                    refused: true,
                    rows: sent,
                },
                total,
            };
        }

        return { failure: undefined, total };
    } catch (error_) {
        // A refusal clears `pending` before it throws, so only a request that never answered leaves it set. `rows` counts the rows of the
        // completed chunks, refused or conflicting ones included, because the caller says how far the import got.
        return { failure: { message: errorMessage(error_), nextLine, rows: sent, unknownFrom: pending.startLine, ...stop }, total };
    }
};

/** The summed outcome of an import: row counts, then each refused row with its line. */
const ImportResultSummary = ({ result }: { readonly result: ImportShardResult }): ReactElement => {
    const t = useT();

    return (
        <div className="flex flex-col gap-2" data-testid="ei-import-result">
            <p className="text-sm text-muted-foreground">
                {t("Inserted {inserted}, replaced {replaced}, deleted {deleted}, {conflicts} conflicts, {errors} errors.", {
                    conflicts: result.conflicts,
                    deleted: result.deleted ?? 0,
                    errors: result.errors.length,
                    inserted: insertedRowCount(result.inserted),
                    replaced: result.replaced ?? 0,
                })}
            </p>
            {result.errors.length > 0 && (
                <ul className="flex flex-col gap-1" data-testid="ei-import-errors">
                    {result.errors.map((rowError) => (
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
    );
};

interface ImportCardProps {
    readonly busy: boolean;
    readonly csvFile: boolean;
    readonly csvTarget: string;
    readonly importReady: boolean;
    readonly importResult: ImportShardResult | null;
    readonly mode: ImportMode;
    readonly onCsvTableChange: (table: string) => void;
    readonly onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
    readonly onModeChange: (event: ChangeEvent<HTMLSelectElement>) => void;
    readonly plan: null | string[];
    readonly progress: null | string;
    readonly runImport: () => void;
    readonly runPlan: () => void;
    readonly shardKey: string;
}

/** The import half of the panel: the file, the mode, the plan and the result. State stays in {@link ExportImportPanel}. */
const ImportCard = ({
    busy,
    csvFile,
    csvTarget,
    importReady,
    importResult,
    mode,
    onCsvTableChange,
    onFileChange,
    onModeChange,
    plan,
    progress,
    runImport,
    runPlan,
    shardKey,
}: ImportCardProps): ReactElement => {
    const t = useT();

    return (
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

                <Label className="flex flex-col gap-1 text-xs font-normal text-muted-foreground" htmlFor="ei-mode">
                    {t("Import mode")}
                    <select
                        className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                        data-testid="ei-mode"
                        id="ei-mode"
                        onChange={onModeChange}
                        value={mode}
                    >
                        <option value="append">{t("Append: rows whose _id already exists are left unchanged and counted as conflicts")}</option>
                        <option value="upsert">
                            {t("Upsert: new _id values are inserted, rows whose _id already exists are overwritten, nothing is deleted")}
                        </option>
                        <option value="replace">{t("Replace: overwrite, then delete this shard's rows of the file's tables that the file lacks")}</option>
                        <option value="require-empty">{t("Require empty: refuse unless the file's tables hold no rows in this shard")}</option>
                    </select>
                </Label>

                <div className="flex flex-wrap items-center gap-2">
                    <ConfirmButton confirmLabel={importConfirmLabel(mode, t)} disabled={busy || !importReady} onConfirm={runImport} testId="ei-import">
                        {t("Import")}
                    </ConfirmButton>
                    <Button data-testid="ei-plan" disabled={busy || !importReady} onClick={runPlan} type="button" variant="outline">
                        {t("Show plan")}
                    </Button>
                </div>

                {progress !== null && (
                    <p className="text-sm text-muted-foreground" data-testid="ei-progress" role="status">
                        {progress}
                    </p>
                )}

                {plan !== null && (
                    <pre className="whitespace-pre-wrap text-xs text-muted-foreground" data-testid="ei-plan-result">
                        {[t("Import plan"), ...plan.map((line) => `  ${line}`)].join("\n")}
                    </pre>
                )}

                {importResult !== null && <ImportResultSummary result={importResult} />}
            </CardContent>
        </Card>
    );
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
 * Both calls travel over the {@link useStudioClient} client transport and are gated by
 * the server's `LUNORA_ADMIN_TOKEN`.
 */
export const ExportImportPanel = ({ initialShardKey }: ExportImportPanelProps): ReactElement => {
    const client = useStudioClient();
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
    const [mode, setMode] = useState<ImportMode>("append");
    const [plan, setPlan] = useState<null | string[]>(null);
    // Bumped whenever an input a plan depends on changes, so a plan that settles late can tell it is out of date.
    const selectionVersion = useRef(0);

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

            // The marker is what lets an import tell this file from one cut short.
            blob = new Blob([blob, exportEndLine(count)], { type: NDJSON_MIME });

            recordShard(exportedShardKey);
            setExported({ blob, count, preview: preview.join("\n"), shardKey: exportedShardKey });
        } catch (error_) {
            setError(errorMessage(error_));
        }
    };

    const importShard = async (file: File, csvTable: null | string, planOnly = false): Promise<void> => {
        setBusy(true);
        setError(null);
        setImportResult(null);
        setExported(null);
        setPlan(null);

        const selection = selectionVersion.current;
        const { failure, plan: planned, total } = await sendImport(client, t, shardKey, setProgress, file, csvTable, mode, planOnly);

        // The mode, shard, file or CSV table may have changed while this ran; a plan made for the old selection is not shown for the new one.
        if (planned !== undefined && selection === selectionVersion.current) {
            setPlan(planned);
        }

        if (failure === undefined && planOnly) {
            // A plan writes nothing, so there is nothing to record or invalidate.
            return;
        }

        if (failure === undefined) {
            recordShard(shardKey);
        }

        const outcome = importOutcome(failure, total, t);

        if (outcome.result !== undefined) {
            setImportResult(outcome.result);
        }

        if (outcome.error !== undefined) {
            setError(outcome.error);
        }

        // The import wrote rows to this shard (possibly only some chunks), so the data
        // browser's cached reads are now stale across every page/filter variant — drop
        // them (path-only, all args) so they re-fetch on next view.
        invalidateAdmin(ADMIN_FUNCTIONS.readTablePage);
        invalidateAdmin(ADMIN_FUNCTIONS.listTables);
    };

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

    const runPlan = (): void => {
        if (importFile !== null && importReady) {
            fireAndForget(
                importShard(importFile, csvFile ? csvTarget : null, true).finally(() => {
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

    const changeSelection = (): void => {
        selectionVersion.current += 1;
        setPlan(null);
    };

    const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setImportFile(event.target.files?.[0] ?? null);
        changeSelection();
        // A replacement file has its own rows, so the table picked for the previous one must not carry over to it.
        setCsvPick(null);
    };

    const onCsvTableChange = (table: string): void => {
        setCsvPick({ shardKey, table });
        changeSelection();
    };

    // A plan is made for one file, one shard and one mode, so changing any of them drops it.
    const onModeChange = (event: ChangeEvent<HTMLSelectElement>): void => {
        setMode(event.target.value as ImportMode);
        changeSelection();
    };

    const onShardChange = (value: string): void => {
        setShardKey(value);
        changeSelection();
    };

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-export-import">
            <Card className="gap-0 py-0 rounded-xl border border-border bg-card shadow-xs">
                <header className="border-b border-border px-4 py-3">
                    <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Export")}</span>
                </header>
                <CardContent className="flex flex-col gap-3 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <ShardInput onChange={onShardChange} testId="ei-shard-input" value={shardKey} />
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

            <ImportCard
                busy={busy}
                csvFile={csvFile}
                csvTarget={csvTarget}
                importReady={importReady}
                importResult={importResult}
                mode={mode}
                onCsvTableChange={onCsvTableChange}
                onFileChange={onFileChange}
                onModeChange={onModeChange}
                plan={plan}
                progress={progress}
                runImport={runImport}
                runPlan={runPlan}
                shardKey={shardKey}
            />

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="ei-error" role="alert">
                    {error}
                </p>
            )}
        </div>
    );
};

export type { ExportImportPanelProps };
