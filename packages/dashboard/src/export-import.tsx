import { useCirrus } from "@cirrus/react";
import { type ChangeEvent, type ReactElement, useCallback, useState } from "react";

import { ADMIN_FUNCTIONS, type ExportRow, type ImportShardResult } from "./admin.js";
import { adminRef, callOptions, errorMessage } from "./internal.js";

export interface ExportImportPanelProps {
    /** Shard key the panel targets. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const EXPORT_SHARD = adminRef(ADMIN_FUNCTIONS.exportShard);
const IMPORT_SHARD = adminRef(ADMIN_FUNCTIONS.importShard);

/** Serialise export rows to NDJSON — one `{table,doc}` object per line. */
const toNdjson = (rows: ExportRow[]): string => rows.map((row) => JSON.stringify(row)).join("\n");

/**
 * Parse NDJSON back into export rows, skipping blank lines. Throws on the first
 * line that is not a valid `{table, doc}` object so the operator gets a precise
 * failure instead of a partial import.
 */
const parseNdjson = (text: string): ExportRow[] => {
    const rows: ExportRow[] = [];

    const lines = text.split("\n");

    for (const [index, line_] of lines.entries()) {
        const line = (line_ ?? "").trim();

        if (line === "") {
            continue;
        }

        const parsed = JSON.parse(line) as unknown;

        if (typeof parsed !== "object" || parsed === null || typeof (parsed as ExportRow).table !== "string" || typeof (parsed as ExportRow).doc !== "object") {
            throw new Error(`line ${index + 1}: expected a { table, doc } object`);
        }

        rows.push(parsed as ExportRow);
    }

    return rows;
};

/**
 * Snapshot and restore a single shard's data as NDJSON.
 *
 * "Export" reads every shard-local row via `__cirrus_admin__:exportShard` and
 * renders it as NDJSON for download/copy. "Import" parses NDJSON the operator
 * pastes in and replays it through `__cirrus_admin__:importShard`, reporting
 * inserted counts, id conflicts and per-row errors. Globally-scoped (`.global()`)
 * tables live in D1 and are intentionally out of scope here.
 *
 * Both calls travel over the {@link useCirrus} client transport and are gated by
 * the server's `CIRRUS_ADMIN_TOKEN`.
 */
export function ExportImportPanel({ initialShardKey }: ExportImportPanelProps): ReactElement {
    const client = useCirrus();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [ndjson, setNdjson] = useState<string>("");
    const [busy, setBusy] = useState<boolean>(false);
    const [error, setError] = useState<null | string>(null);
    const [importResult, setImportResult] = useState<ImportShardResult | null>(null);
    const [exportCount, setExportCount] = useState<null | number>(null);

    const exportShard = useCallback(async (): Promise<void> => {
        setBusy(true);
        setError(null);
        setImportResult(null);

        try {
            const result = (await client.query(EXPORT_SHARD, {}, callOptions(shardKey))) as { rows: ExportRow[] };

            setNdjson(toNdjson(result.rows));
            setExportCount(result.rows.length);
        } catch (error_) {
            setError(errorMessage(error_));
        } finally {
            setBusy(false);
        }
    }, [client, shardKey]);

    const importShard = useCallback(async (): Promise<void> => {
        setBusy(true);
        setError(null);
        setImportResult(null);
        setExportCount(null);

        let rows: ExportRow[];

        try {
            rows = parseNdjson(ndjson);
        } catch (error_) {
            setError(`Invalid NDJSON: ${errorMessage(error_)}`);
            setBusy(false);

            return;
        }

        try {
            const result = (await client.query(IMPORT_SHARD, { rows }, callOptions(shardKey))) as ImportShardResult;

            setImportResult(result);
        } catch (error_) {
            setError(errorMessage(error_));
        } finally {
            setBusy(false);
        }
    }, [client, ndjson, shardKey]);

    const insertedTotal = importResult === null ? 0 : Object.values(importResult.inserted).reduce((sum, count) => sum + count, 0);

    return (
        <div data-testid="cirrus-export-import">
            <div>
                <input
                    aria-label="Shard key"
                    data-testid="ei-shard-input"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => {
                        setShardKey(event.target.value);
                    }}
                    placeholder="shard key (optional)"
                    value={shardKey}
                />
                <button
                    data-testid="ei-export"
                    disabled={busy}
                    onClick={() => {
                        void exportShard();
                    }}
                    type="button"
                >
                    Export
                </button>
                <button
                    data-testid="ei-import"
                    disabled={busy || ndjson.trim() === ""}
                    onClick={() => {
                        void importShard();
                    }}
                    type="button"
                >
                    Import
                </button>
            </div>

            <textarea
                aria-label="NDJSON"
                data-testid="ei-ndjson"
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                    setNdjson(event.target.value);
                }}
                placeholder='{"table":"messages","doc":{…}}'
                value={ndjson}
            />

            {error !== null && (
                <pre data-testid="ei-error" role="alert">
                    {error}
                </pre>
            )}

            {exportCount !== null && <p data-testid="ei-export-result">Exported {exportCount} rows.</p>}

            {importResult !== null && (
                <div data-testid="ei-import-result">
                    <p>
                        Inserted {insertedTotal}, {importResult.conflicts} conflicts, {importResult.errors.length} errors.
                    </p>
                    {importResult.errors.length > 0 && (
                        <ul data-testid="ei-import-errors">
                            {importResult.errors.map((rowError) => (
                                <li key={`${rowError.table}-${rowError.line}`}>
                                    line {rowError.line} ({rowError.table}): {rowError.message}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}
