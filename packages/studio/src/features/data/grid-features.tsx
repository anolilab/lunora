import type { Column, Table } from "@tanstack/react-table";
import type { ReactElement } from "react";
import { useState } from "react";

import { ConfirmButton } from "../../components/confirm-button";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { ModalShell } from "../../components/ui/modal-shell";
import { useT } from "../../i18n/i18n-context";
import { copyToClipboard, formatCell } from "../../lib/internal";

/** A loaded grid row keyed by column name. */
type GridRow = Record<string, unknown>;

/** Shared Supabase-style control-button class (mirrors the data-browser toolbar). */
const CONTROL_BTN =
    "inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50";

// ── Export ───────────────────────────────────────────────────────────────────

/** Characters that force a CSV field to be quoted (comma, quote, newline), per RFC 4180. */
const CSV_QUOTE_RE = /["\n,]/u;

/** Leading characters a spreadsheet treats as a formula trigger (OWASP CSV-injection / CWE-1236). */
const CSV_FORMULA_RE = /^[=+\-@\t\r]/u;

/**
 * Render one value for a CSV cell: empty for null/undefined, the raw text for
 * strings/numbers/booleans, JSON for anything structured. The field is quoted
 * (and embedded quotes doubled) only when it contains a comma, quote, or newline —
 * so simple values stay unquoted and diff-friendly.
 */
const csvCell = (value: unknown): string => {
    if (value === null || value === undefined) {
        return "";
    }

    let text: string;

    if (typeof value === "string") {
        // Neutralize spreadsheet formula injection (OWASP CSV-injection / CWE-1236):
        // a field starting with = + - @ TAB or CR is prefixed with a tab so
        // Excel/Sheets/LibreOffice treat it as text, not a formula.
        text = CSV_FORMULA_RE.test(value) ? `\t${value}` : value;
    } else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        text = String(value);
    } else {
        text = JSON.stringify(value);
    }

    return CSV_QUOTE_RE.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** Serialize the given columns + rows to an RFC-4180 CSV string (header row + one row per record). */
const toCsv = (columns: ReadonlyArray<string>, rows: ReadonlyArray<GridRow>): string => {
    const header = columns.map((column) => csvCell(column)).join(",");
    const body = rows.map((row) => columns.map((column) => csvCell(row[column])).join(","));

    return [header, ...body].join("\n");
};

/** Serialize the given rows to a pretty-printed JSON array string. */
const toJson = (rows: ReadonlyArray<GridRow>): string => JSON.stringify(rows, null, 2);

/** Rows per generated `INSERT` statement — chunked so a large export stays valid under statement-size limits and stays diff-friendly. */
const SQL_INSERT_BATCH = 500;

/** Quote a SQL identifier (table/column) with double quotes, doubling any embedded quote — handles names like `query-result` that aren't bare identifiers. */
const sqlIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * Render one value as a SQL literal for an `INSERT`: `NULL` for null/undefined,
 * a bare numeral for finite numbers/bigints, `1`/`0` for booleans (SQLite has no
 * boolean type), a single-quoted string (embedded quotes doubled) for text, and
 * single-quoted JSON for anything structured. A non-finite number (`NaN`/`±∞`,
 * which SQLite can't represent) degrades to `NULL`.
 */
const sqlLiteral = (value: unknown): string => {
    if (value === null || value === undefined) {
        return "NULL";
    }

    if (typeof value === "number") {
        return Number.isFinite(value) ? String(value) : "NULL";
    }

    if (typeof value === "bigint") {
        return String(value);
    }

    if (typeof value === "boolean") {
        return value ? "1" : "0";
    }

    const text = typeof value === "string" ? value : JSON.stringify(value);

    return `'${text.replaceAll("'", "''")}'`;
};

/**
 * Serialize the given columns + rows to a SQL dump: one or more multi-row
 * `INSERT INTO "…" (...) VALUES ...;` statements, batched at
 * {@link SQL_INSERT_BATCH} rows each. `name` is the target table (the selected
 * table, or the SQL console's `query-result` placeholder). Mirrors the CSV/JSON
 * exports — the loaded page only.
 */
const toSql = (name: string, columns: ReadonlyArray<string>, rows: ReadonlyArray<GridRow>): string => {
    if (columns.length === 0 || rows.length === 0) {
        return "";
    }

    const columnList = columns.map((column) => sqlIdentifier(column)).join(", ");
    const statements: string[] = [];

    for (let start = 0; start < rows.length; start += SQL_INSERT_BATCH) {
        const values = rows
            .slice(start, start + SQL_INSERT_BATCH)
            .map((row) => `  (${columns.map((column) => sqlLiteral(row[column])).join(", ")})`)
            .join(",\n");

        statements.push(`INSERT INTO ${sqlIdentifier(name)} (${columnList}) VALUES\n${values};`);
    }

    return statements.join("\n\n");
};

/**
 * Trigger a client-side file download of `content`. No-op outside the browser
 * (SSR / tests). Builds an object URL from a Blob, clicks a transient anchor, and
 * revokes the URL — the canonical "save text as a file" without a server. Browser
 * globals are reached through `globalThis` so the module stays import-safe under
 * Node, mirroring the rest of the studio.
 */
const downloadFile = (filename: string, content: string, mime: string): void => {
    if (!("document" in globalThis)) {
        return;
    }

    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- browser-only file download; guarded by the "document" in globalThis check above
    const url = globalThis.URL.createObjectURL(new globalThis.Blob([content], { type: mime }));
    const anchor = globalThis.document.createElement("a");

    anchor.href = url;
    anchor.download = filename;
    globalThis.document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- browser-only; pairs with the createObjectURL above
    globalThis.URL.revokeObjectURL(url);
};

/**
 * Export menu: downloads the loaded rows as CSV, JSON, or SQL. Exports exactly
 * what's loaded (the current page passed in by the parent), named after the
 * table, mirroring Supabase's "Export" affordance.
 */
const ExportMenu = ({
    columns,
    name,
    rows,
}: {
    readonly columns: ReadonlyArray<string>;
    readonly name: string;
    readonly rows: ReadonlyArray<GridRow>;
}): ReactElement => {
    const t = useT();

    const onCsv = (): void => {
        downloadFile(`${name}.csv`, toCsv(columns, rows), "text/csv;charset=utf-8");
    };

    const onJson = (): void => {
        downloadFile(`${name}.json`, toJson(rows), "application/json");
    };

    const onSql = (): void => {
        downloadFile(`${name}.sql`, toSql(name, columns, rows), "application/sql;charset=utf-8");
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                className={CONTROL_BTN}
                data-testid="grid-export"
                disabled={rows.length === 0}
                title="Exports only the rows loaded on the current page, not the whole table"
            >
                {/* Make the page scope explicit: this exports the loaded page, not the full table.
                    Hardcoded English (not via `t()`) so no new en.ts catalog id is required. */}
                Export page
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuLabel>Export loaded rows</DropdownMenuLabel>
                <DropdownMenuItem data-testid="grid-export-csv" onClick={onCsv}>
                    {t("CSV")}
                </DropdownMenuItem>
                <DropdownMenuItem data-testid="grid-export-json" onClick={onJson}>
                    {t("JSON")}
                </DropdownMenuItem>
                <DropdownMenuItem data-testid="grid-export-sql" onClick={onSql}>
                    {t("SQL")}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

// ── Column visibility ──────────────────────────────────────────────────────────

/**
 * One column row in the Columns menu. Extracted so each binds its toggle through
 * a stable `useCallback` closing over its column rather than a fresh inline arrow.
 */
const ColumnToggle = ({ column }: { readonly column: Column<GridRow> }): ReactElement => {
    const onCheckedChange = (): void => {
        column.toggleVisibility();
    };

    return (
        <DropdownMenuCheckboxItem
            checked={column.getIsVisible()}
            closeOnClick={false}
            data-testid={`grid-column-${column.id}`}
            onCheckedChange={onCheckedChange}
        >
            {column.id}
        </DropdownMenuCheckboxItem>
    );
};

/**
 * Column-visibility menu: a checkbox per data column to show/hide it. Backed by
 * the TanStack `columnVisibility` state, so toggling a column hides its header and
 * cells everywhere the grid reads `getVisibleCells()`.
 */
/** Hoisted empty list so the default prop is a stable reference across renders. */
const NO_BACK_RELATIONS: ReadonlyArray<{ column: string; table: string }> = [];

const ColumnsMenu = ({
    backRelations = NO_BACK_RELATIONS,
    enabledBackRelations,
    onToggleBackRelation,
    table,
}: {
    /** Reverse edges available for the open table — offered as opt-in extra columns. */
    readonly backRelations?: ReadonlyArray<{ column: string; table: string }>;
    readonly enabledBackRelations?: ReadonlySet<string>;
    readonly onToggleBackRelation?: (key: string) => void;
    readonly table: Table<GridRow>;
}): ReactElement => {
    const t = useT();
    const allVisible = table.getIsAllColumnsVisible();
    const onToggleAll = (): void => {
        table.toggleAllColumnsVisible(!allVisible);
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger className={CONTROL_BTN} data-testid="grid-columns">
                {t("Columns")}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
                <DropdownMenuGroup>
                    <DropdownMenuLabel>{t("Columns")}</DropdownMenuLabel>
                    {/* Show-all / hide-all toggle so a wide table's columns flip in one click. */}
                    <DropdownMenuCheckboxItem checked={allVisible} closeOnClick={false} data-testid="grid-columns-all" onCheckedChange={onToggleAll}>
                        {allVisible ? t("Hide all") : t("Show all")}
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuSeparator />
                    {table
                        .getAllLeafColumns()
                        // Reverse-relation columns are toggled below, in their own
                        // group — listing them here too would offer two switches
                        // for one column.
                        .filter((column) => !column.id.startsWith("__back__:"))
                        .map((column) => (
                            <ColumnToggle column={column} key={column.id} />
                        ))}
                </DropdownMenuGroup>
                {backRelations.length > 0 && onToggleBackRelation !== undefined && (
                    <DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>{t("Related")}</DropdownMenuLabel>
                        {backRelations.map((relation) => {
                            const key = `${relation.table}.${relation.column}`;

                            return (
                                <DropdownMenuCheckboxItem
                                    checked={enabledBackRelations?.has(key) === true}
                                    closeOnClick={false}
                                    data-testid={`grid-back-relation-${key}`}
                                    key={key}
                                    onCheckedChange={() => {
                                        onToggleBackRelation(key);
                                    }}
                                >
                                    {`← ${relation.table}.${relation.column}`}
                                </DropdownMenuCheckboxItem>
                            );
                        })}
                    </DropdownMenuGroup>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

// ── Selection bar ──────────────────────────────────────────────────────────────

/**
 * The bulk-action bar shown above the grid when one or more rows are selected:
 * the selected count, a "clear", and — when the browser is editable — a confirmed
 * bulk delete of the selected rows.
 */
const SelectionBar = ({
    count,
    editable,
    onClear,
    onDelete,
}: {
    readonly count: number;
    readonly editable: boolean;
    readonly onClear: () => void;
    readonly onDelete: () => void;
}): ReactElement => {
    const t = useT();

    return (
        <div className="flex items-center gap-2 rounded-md border border-border bg-accent/40 px-3 py-1.5 text-xs" data-testid="grid-selection-bar">
            <span className="font-medium tabular-nums" data-testid="grid-selection-count">
                {t("{count} selected", { count })}
            </span>
            <button className={CONTROL_BTN} data-testid="grid-selection-clear" onClick={onClear} type="button">
                {t("Clear")}
            </button>
            {editable && (
                <ConfirmButton confirmLabel={t("Delete {count} rows?", { count })} onConfirm={onDelete} testId="grid-selection-delete">
                    {t("Delete {count}", { count })}
                </ConfirmButton>
            )}
        </div>
    );
};

// ── Cell detail (expand + copy) ─────────────────────────────────────────────────

/**
 * A modal panel showing a single cell's full value (the column name as title, the
 * value in a scrollable code block) with a Copy button — the "expand cell" action
 * a dense grid needs so a truncated value is fully readable and copyable. The
 * backdrop/Escape dismiss is owned by {@link ModalShell}.
 */
const CellDetailDialog = ({ column, onClose, value }: { readonly column: string; readonly onClose: () => void; readonly value: unknown }): ReactElement => {
    const t = useT();
    const [copied, setCopied] = useState<boolean>(false);
    const text = formatCell(value);

    const onCopy = (): void => {
        if (copyToClipboard(text)) {
            setCopied(true);
        }
    };

    return (
        <ModalShell
            className="max-h-[70vh] w-[min(40rem,90vw)]"
            label={t("Cell value")}
            onClose={onClose}
            panelTestId="grid-cell-dialog"
            testId="grid-cell-dialog-overlay"
            variant="dialog"
        >
            <div className="flex items-center justify-between">
                <h2 className="truncate font-mono text-sm font-semibold text-foreground">{column}</h2>
                <div className="flex items-center gap-1.5">
                    <button className={CONTROL_BTN} data-testid="grid-cell-copy" onClick={onCopy} type="button">
                        {copied ? t("Copied") : t("Copy")}
                    </button>
                    <button className={CONTROL_BTN} data-testid="grid-cell-close" onClick={onClose} type="button">
                        {t("Close")}
                    </button>
                </div>
            </div>
            <pre
                className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap"
                data-testid="grid-cell-value"
            >
                {text}
            </pre>
        </ModalShell>
    );
};

// ── Grid actions bar ─────────────────────────────────────────────────────────

/**
 * The grid's action bar: Export + Columns menus, plus a selection bar when rows
 * are checked. Driven by the live TanStack table — selected row ids come straight
 * from `row.id` (the model's `getRowId` is the row's primary key), so bulk delete
 * needs no extra id plumbing. Composed here so the data browser's toolbar stays a
 * one-liner.
 */
const GridActionsBar = ({
    backRelations,
    enabledBackRelations,
    onToggleBackRelation,
    columns,
    editable,
    name,
    onBulkDelete,
    onToggleTranspose,
    rows,
    table,
    transposed,
}: {
    /** Reverse edges available for the open table — offered as opt-in extra columns. */
    readonly backRelations?: ReadonlyArray<{ column: string; table: string }>;
    readonly columns: ReadonlyArray<string>;
    readonly editable: boolean;
    readonly enabledBackRelations?: ReadonlySet<string>;
    readonly name: string;
    readonly onBulkDelete: (ids: ReadonlyArray<string>) => void;
    readonly onToggleBackRelation?: (key: string) => void;
    readonly onToggleTranspose: () => void;
    readonly rows: ReadonlyArray<GridRow>;
    readonly table: Table<GridRow>;
    readonly transposed: boolean;
}): ReactElement => {
    const t = useT();
    const selected = table.getSelectedRowModel().rows;

    const onClear = (): void => {
        table.resetRowSelection();
    };

    const onDelete = (): void => {
        onBulkDelete(selected.map((row) => row.id));
        table.resetRowSelection();
    };

    return (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="grid-actions">
            <ExportMenu columns={columns} name={name} rows={rows} />
            <ColumnsMenu backRelations={backRelations} enabledBackRelations={enabledBackRelations} onToggleBackRelation={onToggleBackRelation} table={table} />
            <button
                aria-pressed={transposed}
                className={CONTROL_BTN}
                data-testid="grid-transpose"
                onClick={onToggleTranspose}
                title={t("Swap rows and columns")}
                type="button"
            >
                {t("Transpose")}
            </button>
            {selected.length > 0 && <SelectionBar count={selected.length} editable={editable} onClear={onClear} onDelete={onDelete} />}
        </div>
    );
};

export { CellDetailDialog, ColumnsMenu, ExportMenu, GridActionsBar, SelectionBar, toCsv, toJson, toSql };
export type { GridRow };
