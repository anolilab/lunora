import { LunoraError } from "@lunora/errors";
import { useLunora } from "@lunora/react";
import { decodeWire, encodeWire } from "@lunora/wire";
import type { ChangeEvent, ReactElement } from "react";
import { useState } from "react";

import { ConfirmButton } from "../../components/confirm-button";
import { ShardInput } from "../../components/shard-input";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { useInvalidateAdmin } from "../../hooks/use-admin-query";
import { useT } from "../../i18n/i18n-context";
import type { ExportRow, ImportShardResult, TableInfo } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget } from "../../lib/internal";
import { recordShard } from "../../lib/shard-history";
import { downloadFile } from "../data/grid-features";

interface ExportImportPanelProps {
    /** Shard key the panel targets. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const EXPORT_SHARD = adminRef(ADMIN_FUNCTIONS.exportShard);
const IMPORT_SHARD = adminRef(ADMIN_FUNCTIONS.importShard);
const LIST_TABLES = adminRef(ADMIN_FUNCTIONS.listTables);

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
const NDJSON_PIECE_BYTES = 1024 * 1024;

/**
 * Yield a file's lines one at a time, 1-based, reading it in pieces so the whole
 * file is never held as one string. A piece can end mid-line, and mid-character:
 * the decoder keeps a partial character for the next piece and the carry keeps
 * a partial line whole.
 */
const ndjsonLines = async function* (file: Blob): AsyncGenerator<{ line: string; lineNumber: number }> {
    // fatal: a non-UTF-8 file fails validation instead of importing U+FFFD in place of its characters.
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let carry = "";
    let lineNumber = 0;

    for (let offset = 0; offset < file.size; offset += NDJSON_PIECE_BYTES) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- a piece can only be decoded after the one before it, so the reads are serial by design
        const bytes = await file.slice(offset, offset + NDJSON_PIECE_BYTES).arrayBuffer(); // eslint-disable-line no-await-in-loop -- pieces are read in file order; each decode depends on the one before
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

/** Lines of an export shown inline; the full export is only ever a download. */
const PREVIEW_LINES = 50;

/** Rows sent per `importShard` call at most. The byte cap below is what keeps wide rows under the body limit. */
const IMPORT_CHUNK_ROWS = 500;

/**
 * Encoded bytes sent per `importShard` call at most, below the runtime's 1 MiB body cap with room for the request envelope. The CLI
 * importer uses the same ceiling: `--batch-size` counts rows, which says nothing about how wide they are.
 */
const IMPORT_CHUNK_BYTES = 900_000;

const lineBytes = (line: string): number => new TextEncoder().encode(line).byteLength;

const NDJSON_MIME = "application/x-ndjson";

/**
 * Count the rows in an NDJSON file, validating every line on the way; throws on the first malformed line, and on a row too wide to send
 * alone, so nothing is written for a file that cannot be imported whole.
 */
const countNdjsonRows = async (file: Blob): Promise<number> => {
    let rows = 0;

    for await (const { line, lineNumber } of ndjsonLines(file)) {
        if (parseNdjsonLine(line, lineNumber) !== undefined) {
            if (lineBytes(line) > IMPORT_CHUNK_BYTES) {
                throw new LunoraError("INTERNAL", `line ${lineNumber.toString()}: a single row is over the ${IMPORT_CHUNK_BYTES.toString()}-byte import limit`);
            }

            rows += 1;
        }
    }

    return rows;
};

/**
 * Hand an NDJSON file to `onChunk` in batches of at most {@link IMPORT_CHUNK_ROWS} rows and {@link IMPORT_CHUNK_BYTES} bytes, in file order,
 * reading it as it goes.
 */
const forEachNdjsonChunk = async (file: Blob, onChunk: (rows: ExportRow[], startLine: number) => Promise<void>): Promise<void> => {
    let chunk: ExportRow[] = [];
    let chunkBytes = 0;
    let chunkStart = 0;
    let previousLine = 0;

    for await (const { line, lineNumber } of ndjsonLines(file)) {
        const row = parseNdjsonLine(line, lineNumber);

        if (row === undefined) {
            continue;
        }

        const bytes = lineBytes(line);

        // The server numbers a chunk's rows from its first line, so a blank line in between must end the chunk.
        const gap = lineNumber !== previousLine + 1;

        if (chunk.length > 0 && (gap || chunk.length === IMPORT_CHUNK_ROWS || chunkBytes + bytes > IMPORT_CHUNK_BYTES)) {
            await onChunk(chunk, chunkStart);

            chunk = [];
            chunkBytes = 0;
        }

        if (chunk.length === 0) {
            chunkStart = lineNumber;
        }

        chunk.push(row);
        chunkBytes += bytes;
        previousLine = lineNumber;
    }

    if (chunk.length > 0) {
        await onChunk(chunk, chunkStart);
    }
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

/**
 * Snapshot and restore a single shard's data as NDJSON.
 *
 * "Export" walks the shard's tables one `__lunora_admin__:exportShard` call at a
 * time (`tables: [name]`), appending each page's NDJSON to a `Blob` the operator
 * downloads; only the first {@link PREVIEW_LINES} lines are rendered, so a large
 * shard never lands in one textarea. "Import" reads an NDJSON file and replays it
 * through `__lunora_admin__:importShard` in chunks of {@link IMPORT_CHUNK_ROWS}
 * rows, reporting progress and then the summed inserted counts, id conflicts and
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
    const [busy, setBusy] = useState<boolean>(false);
    const [error, setError] = useState<null | string>(null);
    const [importResult, setImportResult] = useState<ImportShardResult | null>(null);
    const [progress, setProgress] = useState<null | string>(null);
    const [exported, setExported] = useState<ExportedShard | null>(null);

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

    /**
     * Stream a file into the shard. Resolves `undefined` when every chunk landed; otherwise the message to show and how many rows were
     * written before it stopped. The file is read twice: the first pass validates every line and counts the rows, so a malformed line is
     * rejected before anything is written; the second sends the rows in chunks as they stream in, so the file is never held whole.
     */
    const sendImport = async (file: File): Promise<{ failure: { message: string; rows: number } | undefined; total: ImportShardResult }> => {
        const total: ImportShardResult = { conflicts: 0, errors: [], inserted: {} };
        let rowCount: number;

        try {
            rowCount = await countNdjsonRows(file);
        } catch (error_) {
            return { failure: { message: t("Invalid NDJSON: {message}", { message: errorMessage(error_) }), rows: 0 }, total };
        }

        let sent = 0;

        const sendChunk = async (rows: ExportRow[], startLine: number): Promise<void> => {
            setProgress(
                t("Importing rows {from}–{to} of {total}…", {
                    from: sent + 1,
                    to: sent + rows.length,
                    total: rowCount,
                }),
            );

            const result = (await client.query(IMPORT_SHARD, { rows, startLine }, callOptions(shardKey))) as ImportShardResult;

            total.conflicts += result.conflicts;
            total.errors.push(...result.errors);

            for (const [table, count] of Object.entries(result.inserted)) {
                total.inserted[table] = (total.inserted[table] ?? 0) + count;
            }

            sent += rows.length;
        };

        try {
            await forEachNdjsonChunk(file, sendChunk);

            return { failure: undefined, total };
        } catch (error_) {
            // Chunks sent before the failure may already have written rows; the caller shows their counts next to the error.
            return { failure: { message: errorMessage(error_), rows: sent }, total };
        }
    };

    const importShard = async (file: File): Promise<void> => {
        setBusy(true);
        setError(null);
        setImportResult(null);
        setExported(null);

        const { failure, total } = await sendImport(file);

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
        if (importFile !== null) {
            fireAndForget(
                importShard(importFile).finally(() => {
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
                        accept=".ndjson,.jsonl,application/x-ndjson"
                        aria-label="NDJSON"
                        className="text-sm"
                        data-testid="ei-file"
                        onChange={onFileChange}
                        type="file"
                    />

                    <div className="flex flex-wrap items-center gap-2">
                        <ConfirmButton
                            confirmLabel={t("Import (writes rows)?")}
                            disabled={busy || importFile === null}
                            onConfirm={runImport}
                            testId="ei-import"
                        >
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
