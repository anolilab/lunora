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
 * {@link parseNdjson} decodes symmetrically so the round trip restores types.
 */
const toNdjson = (rows: ExportRow[]): string => rows.map((row) => JSON.stringify(encodeWire(row))).join("\n");

/**
 * Parse NDJSON back into export rows, skipping blank lines. Throws on the first
 * line that is not a valid `{table, doc}` object so the operator gets a precise
 * failure instead of a partial import.
 *
 * Each line is `decodeWire`d — the inverse of {@link toNdjson} — so a bigint /
 * bytes cell is a native value again before `client.query` re-encodes it for the
 * wire. Decoding is identity for pure JSON, so hand-written NDJSON still imports.
 */
const parseNdjson = (text: string): ExportRow[] => {
    const rows: ExportRow[] = [];

    const lines = text.split("\n");

    for (const [index, rawLine] of lines.entries()) {
        const line = rawLine.trim();

        if (line === "") {
            continue;
        }

        const parsed = decodeWire(JSON.parse(line));

        if (typeof parsed !== "object" || parsed === null) {
            throw new LunoraError("INTERNAL", `line ${(index + 1).toString()}: expected a { table, doc } object`);
        }

        const row = parsed as Record<string, unknown>;

        if (typeof row.table !== "string" || typeof row.doc !== "object" || row.doc === null || Array.isArray(row.doc)) {
            throw new LunoraError("INTERNAL", `line ${(index + 1).toString()}: expected a { table, doc } object`);
        }

        rows.push(row as unknown as ExportRow);
    }

    return rows;
};

/** Lines of an export shown inline; the full export is only ever a download. */
const PREVIEW_LINES = 50;

/** Rows sent per `importShard` call, so a large file is never one oversized request. */
const IMPORT_CHUNK_ROWS = 500;

const NDJSON_MIME = "application/x-ndjson";

/** A finished export: the NDJSON as one Blob (never a string in the DOM), its row count and the first lines for display. */
interface ExportedShard {
    blob: Blob;
    count: number;
    preview: string;
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
        setBusy(true);
        setError(null);
        setImportResult(null);
        setExported(null);

        try {
            const tables = (await client.query(LIST_TABLES, {}, callOptions(shardKey))) as ReadonlyArray<TableInfo>;
            let blob = new Blob([], { type: NDJSON_MIME });
            let count = 0;
            const preview: string[] = [];

            for (const { name } of tables) {
                // eslint-disable-next-line no-await-in-loop -- one table per call, appended in order, so the whole shard is never one response
                const { rows } = (await client.query(EXPORT_SHARD, { tables: [name] }, callOptions(shardKey))) as { rows: ExportRow[] };

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

            recordShard(shardKey);
            setExported({ blob, count, preview: preview.join("\n") });
        } catch (error_) {
            setError(errorMessage(error_));
        }

        setBusy(false);
    };

    const importShard = async (file: File): Promise<void> => {
        setBusy(true);
        setError(null);
        setImportResult(null);
        setExported(null);

        let rows: ExportRow[];

        try {
            // ponytail: the file is read and parsed whole; stream it by line if multi-GB imports matter.
            rows = parseNdjson(await file.text());
        } catch (error_) {
            setError(t("Invalid NDJSON: {message}", { message: errorMessage(error_) }));
            setBusy(false);

            return;
        }

        const total: ImportShardResult = { conflicts: 0, errors: [], inserted: {} };

        try {
            for (let offset = 0; offset < rows.length; offset += IMPORT_CHUNK_ROWS) {
                setProgress(
                    t("Importing rows {from}–{to} of {total}…", {
                        from: offset + 1,
                        to: Math.min(offset + IMPORT_CHUNK_ROWS, rows.length),
                        total: rows.length,
                    }),
                );

                // eslint-disable-next-line no-await-in-loop -- chunks go in file order, so error line numbers and id conflicts match a single import
                const result = (await client.query(
                    IMPORT_SHARD,
                    { rows: rows.slice(offset, offset + IMPORT_CHUNK_ROWS), startLine: offset + 1 },
                    callOptions(shardKey),
                )) as ImportShardResult;

                total.conflicts += result.conflicts;
                total.errors.push(...result.errors);

                for (const [table, count] of Object.entries(result.inserted)) {
                    total.inserted[table] = (total.inserted[table] ?? 0) + count;
                }
            }

            recordShard(shardKey);
            setImportResult(total);
        } catch (error_) {
            setError(errorMessage(error_));
        }

        // The import wrote rows to this shard (possibly only some chunks), so the data
        // browser's cached reads are now stale across every page/filter variant — drop
        // them (path-only, all args) so they re-fetch on next view.
        invalidateAdmin(ADMIN_FUNCTIONS.readTablePage);
        invalidateAdmin(ADMIN_FUNCTIONS.listTables);
        setProgress(null);
        setBusy(false);
    };

    const insertedTotal = importResult === null ? 0 : Object.values(importResult.inserted).reduce((sum, count) => sum + count, 0);

    const runExport = (): void => {
        fireAndForget(exportShard());
    };

    const runImport = (): void => {
        if (importFile !== null) {
            fireAndForget(importShard(importFile));
        }
    };

    const download = (): void => {
        if (exported !== null) {
            downloadFile(`${shardKey.trim() === "" ? "shard" : shardKey.trim()}.ndjson`, exported.blob, NDJSON_MIME);
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
