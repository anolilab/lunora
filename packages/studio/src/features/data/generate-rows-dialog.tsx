import type { ReactElement } from "react";
import { useCallback, useState } from "react";

import { ModalShell } from "../../components/ui/modal-shell";
import { useT } from "../../i18n/i18n-context";
import type { ColumnMeta } from "../../lib/admin";
import { fireAndForget } from "../../lib/internal";
import { generateRows, MAX_GENERATE_ROWS } from "./faker-generator";

/** Shared control-button class for dialog actions. */
const BTN =
    "rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50";

/** Destructive action button class. */
const BTN_DESTRUCTIVE =
    "rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:bg-primary/90 disabled:pointer-events-none disabled:opacity-50";

/** Props for the generate-rows dialog. */
interface GenerateRowsDialogProps {
    /** Table column metadata (from `describeTable`). Required to build the generator. */
    readonly columns: ReadonlyArray<ColumnMeta>;
    /** FK pools: column.ref → existing row ids for FK columns. Pass `{}` when no FK resolution is needed. */
    readonly fkPools: Readonly<Record<string, ReadonlyArray<string>>>;
    /** Dismiss without inserting. */
    readonly onClose: () => void;

    /**
     * Called with the generated row documents. The caller (data browser) routes
     * them through the schema-aware `writeRow` insert path one by one. Returns
     * `undefined` on success or an error message string on failure.
     */
    readonly onInsertRows: (rows: ReadonlyArray<Record<string, unknown>>) => Promise<string | undefined>;
    /** The name of the table being seeded — for display only. */
    readonly table: string;
}

/**
 * A dialog that generates N dummy rows for the active table via `@faker-js/faker`,
 * then inserts them through the schema-aware `writeRow` path. Generates rows
 * locally (no server round-trip for generation), then sends them in batch.
 *
 * Columns with empty FK pools are skipped and listed in the dialog so the
 * operator knows which relations were not populated.
 */
const GenerateRowsDialog = ({ columns, fkPools, onClose, onInsertRows, table }: GenerateRowsDialogProps): ReactElement => {
    const t = useT();

    const [count, setCount] = useState<number>(10);
    const [inserting, setInserting] = useState<boolean>(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const [inserted, setInserted] = useState<number | undefined>(undefined);

    const onCountChange = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
        const next = Number(event.target.value);

        if (!Number.isNaN(next) && next >= 1) {
            setCount(Math.min(next, MAX_GENERATE_ROWS));
        }
    }, []);

    const handleGenerate = useCallback(async (): Promise<void> => {
        setError(undefined);
        setInserted(undefined);
        setInserting(true);

        try {
            const { rows, skippedFkColumns } = generateRows(columns, count, fkPools);

            if (rows.length === 0) {
                setError(t("No rows generated — all columns were skipped."));

                return;
            }

            const result = await onInsertRows(rows);

            if (result !== undefined) {
                setError(result);

                return;
            }

            setInserted(rows.length);

            if (skippedFkColumns.length > 0) {
                setError(t("Inserted {count} rows. Skipped FK columns: {cols}", { cols: skippedFkColumns.join(", "), count: rows.length.toString() }));
            }
        } finally {
            setInserting(false);
        }
    }, [columns, count, fkPools, onInsertRows, t]);

    const onGenerate = useCallback((): void => {
        fireAndForget(handleGenerate());
    }, [handleGenerate]);

    // Editable columns excluding the PK for the preview list.
    const editableColumns = columns.filter((column) => column.pk !== true);

    return (
        <ModalShell label={t("Generate dummy rows")} onClose={onClose} panelTestId="gen-rows-panel" testId="gen-rows-overlay" variant="dialog">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground" data-testid="gen-rows-title">
                    {t("Generate dummy rows")}
                </h3>
                <button className="text-xs text-muted-foreground hover:text-foreground" data-testid="gen-rows-close" onClick={onClose} type="button">
                    {t("Close")}
                </button>
            </div>

            <p className="text-xs text-muted-foreground" data-testid="gen-rows-desc">
                {t("Seed {table} with Faker-generated rows. Existing rows are not affected.", { table })}
            </p>

            <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-foreground" htmlFor="gen-rows-count">
                    {t("Row count")}
                </label>
                <input
                    className="w-20 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus-visible:border-ring"
                    data-testid="gen-rows-count"
                    id="gen-rows-count"
                    max={MAX_GENERATE_ROWS}
                    min={1}
                    onChange={onCountChange}
                    type="number"
                    value={count}
                />
                <span className="text-xs text-muted-foreground">{t("(max {max})", { max: MAX_GENERATE_ROWS.toString() })}</span>
            </div>

            {editableColumns.length > 0 && (
                <div className="flex flex-col gap-1">
                    <p className="text-xs font-medium text-muted-foreground">{t("Columns to seed")}</p>
                    <ul className="flex flex-col gap-0.5" data-testid="gen-rows-columns">
                        {editableColumns.map((column) => {
                            const hasFk = column.ref !== undefined && column.type === "id";
                            const fkEmpty = hasFk && (fkPools[column.ref ?? ""] ?? []).length === 0;
                            const fkBadgeClass = fkEmpty ? "rounded bg-destructive/10 px-1 text-destructive" : "rounded bg-muted px-1 text-muted-foreground";
                            const fkBadgeTestId = fkEmpty ? `gen-rows-fk-empty-${column.name}` : `gen-rows-fk-ok-${column.name}`;
                            const fkBadgeText = fkEmpty
                                ? t("FK: no rows in {ref} — will skip", { ref: column.ref ?? "" })
                                : t("→ {ref}", { ref: column.ref ?? "" });

                            return (
                                <li className="flex items-center gap-1.5 font-mono text-xs" key={column.name}>
                                    <span className="text-foreground">{column.name}</span>
                                    <span className="text-muted-foreground">({column.type})</span>
                                    {column.optional && <span className="rounded bg-muted px-1 text-[10px] tracking-wide uppercase">optional</span>}
                                    {hasFk && (
                                        <span className={fkBadgeClass} data-testid={fkBadgeTestId}>
                                            {fkBadgeText}
                                        </span>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}

            {error !== undefined && (
                <p className="text-xs text-destructive" data-testid="gen-rows-error" role="alert">
                    {error}
                </p>
            )}

            {inserted !== undefined && error === undefined && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400" data-testid="gen-rows-success">
                    {t("Inserted {count} rows successfully.", { count: inserted.toString() })}
                </p>
            )}

            <div className="flex justify-end gap-2">
                <button className={BTN} data-testid="gen-rows-cancel" onClick={onClose} type="button">
                    {t("Cancel")}
                </button>
                <button className={BTN_DESTRUCTIVE} data-testid="gen-rows-generate" disabled={inserting} onClick={onGenerate} type="button">
                    {inserting ? t("Inserting…") : t("Generate & insert")}
                </button>
            </div>
        </ModalShell>
    );
};

export { GenerateRowsDialog };
export type { GenerateRowsDialogProps };
