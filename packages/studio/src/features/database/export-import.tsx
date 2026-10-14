import { LunoraError } from "@lunora/errors";
import { useLunora } from "@lunora/react";
import type { ChangeEvent, ReactElement } from "react";
import { useState } from "react";

import { decodeWire, encodeWire } from "../../../../../shared/wire-codec";
import { ConfirmButton } from "../../components/confirm-button";
import { ShardInput } from "../../components/shard-input";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Textarea } from "../../components/ui/textarea";
import { useInvalidateAdmin } from "../../hooks/use-admin-query";
import { useT } from "../../i18n/i18n-context";
import type { ExportRow, ImportShardResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget } from "../../lib/internal";
import { recordShard } from "../../lib/shard-history";

interface ExportImportPanelProps {
    /** Shard key the panel targets. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const EXPORT_SHARD = adminRef(ADMIN_FUNCTIONS.exportShard);
const IMPORT_SHARD = adminRef(ADMIN_FUNCTIONS.importShard);

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

/**
 * Snapshot and restore a single shard's data as NDJSON.
 *
 * "Export" reads every shard-local row via `__lunora_admin__:exportShard` and
 * renders it as NDJSON for download/copy. "Import" parses NDJSON the operator
 * pastes in and replays it through `__lunora_admin__:importShard`, reporting
 * inserted counts, id conflicts and per-row errors. Globally-scoped (`.global()`)
 * tables live in D1 and are intentionally out of scope here.
 *
 * Both calls travel over the {@link useLunora} client transport and are gated by
 * the server's `LUNORA_ADMIN_TOKEN`.
 */
export const ExportImportPanel = ({ initialShardKey }: ExportImportPanelProps): ReactElement => {
    const client = useLunora();
    const invalidateAdmin = useInvalidateAdmin();
    const t = useT();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [ndjson, setNdjson] = useState<string>("");
    const [busy, setBusy] = useState<boolean>(false);
    const [error, setError] = useState<null | string>(null);
    const [importResult, setImportResult] = useState<ImportShardResult | null>(null);
    const [exportCount, setExportCount] = useState<null | number>(null);

    const exportShard = async (): Promise<void> => {
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
        }

        setBusy(false);
    };

    const importShard = async (): Promise<void> => {
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
            // The import wrote rows to this shard, so the data browser's cached reads
            // are now stale across every page/filter variant — drop them (path-only,
            // all args) so they re-fetch on next view.
            invalidateAdmin(ADMIN_FUNCTIONS.readTablePage);
            invalidateAdmin(ADMIN_FUNCTIONS.listTables);
        } catch (error_) {
            setError(errorMessage(error_));
        }

        setBusy(false);
    };

    const insertedTotal = importResult === null ? 0 : Object.values(importResult.inserted).reduce((sum, count) => sum + count, 0);

    const runExport = (): void => {
        fireAndForget(exportShard());
    };

    const runImport = (): void => {
        fireAndForget(importShard());
    };

    const onNdjsonChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
        setNdjson(event.target.value);
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

                    {exportCount !== null && (
                        <p className="text-sm text-muted-foreground" data-testid="ei-export-result">
                            {t("Exported {count} rows.", { count: exportCount })}
                        </p>
                    )}
                </CardContent>
            </Card>

            <Card className="gap-0 py-0 rounded-xl border border-border bg-card shadow-xs">
                <header className="border-b border-border px-4 py-3">
                    <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Import")}</span>
                </header>
                <CardContent className="flex flex-col gap-3 p-4">
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
