import { useCirrus } from "@cirrus/react";
import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useState } from "react";

import type { ExportRow, ImportShardResult } from "./admin";
import { ADMIN_FUNCTIONS } from "./admin";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Textarea } from "./components/ui/textarea";
import { ConfirmButton } from "./confirm-button";
import { useT } from "./i18n-context";
import { adminRef, callOptions, errorMessage, fireAndForget } from "./internal";
import { recordShard } from "./shard-history";
import { ShardInput } from "./shard-input";

interface ExportImportPanelProps {
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

    for (const [index, rawLine] of lines.entries()) {
        const line = rawLine.trim();

        if (line === "") {
            continue;
        }

        const parsed = JSON.parse(line) as unknown;

        if (typeof parsed !== "object" || parsed === null) {
            throw new Error(`line ${(index + 1).toString()}: expected a { table, doc } object`);
        }

        const row = parsed as Record<string, unknown>;

        if (typeof row.table !== "string" || typeof row.doc !== "object" || row.doc === null || Array.isArray(row.doc)) {
            throw new Error(`line ${(index + 1).toString()}: expected a { table, doc } object`);
        }

        rows.push(row as unknown as ExportRow);
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
export const ExportImportPanel = ({ initialShardKey }: ExportImportPanelProps): ReactElement => {
    const client = useCirrus();
    const t = useT();

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

            recordShard(shardKey);
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
            setError(t("Invalid NDJSON: {message}", { message: errorMessage(error_) }));
            setBusy(false);

            return;
        }

        try {
            const result = (await client.query(IMPORT_SHARD, { rows }, callOptions(shardKey))) as ImportShardResult;

            recordShard(shardKey);
            setImportResult(result);
        } catch (error_) {
            setError(errorMessage(error_));
        } finally {
            setBusy(false);
        }
    }, [client, ndjson, shardKey, t]);

    const insertedTotal = importResult === null ? 0 : Object.values(importResult.inserted).reduce((sum, count) => sum + count, 0);

    const runExport = useCallback((): void => {
        fireAndForget(exportShard());
    }, [exportShard]);

    const runImport = useCallback((): void => {
        fireAndForget(importShard());
    }, [importShard]);

    const onNdjsonChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>): void => {
        setNdjson(event.target.value);
    }, []);

    return (
        <div className="flex flex-col gap-4" data-testid="cirrus-export-import">
            <Card className="rounded-md">
                <CardHeader>
                    <CardTitle>{t("Export")}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <ShardInput onChange={setShardKey} testId="ei-shard-input" value={shardKey} />
                        <Button data-testid="ei-export" disabled={busy} onClick={runExport} type="button">
                            {t("Export")}
                        </Button>
                    </div>

                    {exportCount !== null && (
                        <p className="text-sm text-muted-foreground" data-testid="ei-export-result">
                            {t("Exported {count} rows.", { count: exportCount })}
                        </p>
                    )}
                </CardContent>
            </Card>

            <Card className="rounded-md">
                <CardHeader>
                    <CardTitle>{t("Import")}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                    <Textarea
                        aria-label="NDJSON"
                        className="font-mono text-xs min-h-40 rounded-md"
                        data-testid="ei-ndjson"
                        onChange={onNdjsonChange}
                        placeholder='{"table":"messages","doc":{…}}'
                        value={ndjson}
                    />

                    <div className="flex flex-wrap items-center gap-2">
                        <ConfirmButton
                            confirmLabel={t("Import (writes rows)?")}
                            disabled={busy || ndjson.trim() === ""}
                            onConfirm={runImport}
                            testId="ei-import"
                        >
                            {t("Import")}
                        </ConfirmButton>
                    </div>

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
