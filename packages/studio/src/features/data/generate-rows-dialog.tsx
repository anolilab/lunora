import type { ReactElement } from "react";
import { useState } from "react";

import { ModalShell } from "../../components/ui/modal-shell";
import { useT } from "../../i18n/i18n-context";
import type { ColumnMeta } from "../../lib/admin";
import { fireAndForget } from "../../lib/internal";
import { collectUnresolvableFkColumns, MAX_GENERATE_ROWS, requestSeedRows } from "../../lib/seed-data";
import type { InsertBatchOutcome } from "./hooks/use-generate-rows";

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
     * them through the bulk `importShard` admin RPC in one call. The returned
     * {@link InsertBatchOutcome} carries the REAL inserted/conflict counts —
     * `error === undefined` does not mean every requested row landed (a
     * conflict-only batch also has no `error`).
     */
    readonly onInsertRows: (rows: ReadonlyArray<Record<string, unknown>>) => Promise<InsertBatchOutcome>;
    /** The name of the table being seeded — for display only. */
    readonly table: string;
}

/**
 * A dialog that generates N dummy rows for the active table, then inserts them
 * through the schema-aware `writeRow` path. Generation runs server-side in the
 * dev host (`@lunora/seed` over `@faker-js/faker`) so faker stays out of the
 * browser bundle; the dialog fetches the rows from the local seed endpoint and
 * then sends them to the worker in batch.
 *
 * A column whose parent table has no rows BLOCKS generation: there is no id to
 * point it at, and the endpoint refuses rather than fabricate a parent row it
 * would then drop — which is how children carrying foreign keys to rows that do
 * not exist used to get inserted while the dialog reported the column "skipped".
 * Those columns are listed and the generate button is disabled until their
 * parents are seeded.
 */
const GenerateRowsDialog = ({ columns, fkPools, onClose, onInsertRows, table }: GenerateRowsDialogProps): ReactElement => {
    const t = useT();

    const [count, setCount] = useState<number>(10);
    const [inserting, setInserting] = useState<boolean>(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const [inserted, setInserted] = useState<number | undefined>(undefined);
    /** Rows skipped as id conflicts on the last successful (`error === undefined`) insert — surfaced alongside `inserted` so "0 inserted, 200 conflicts" never reads as "200 inserted". */
    const [conflicts, setConflicts] = useState<number>(0);

    const onCountChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        const next = Number(event.target.value);

        if (!Number.isNaN(next) && next >= 1) {
            setCount(Math.min(next, MAX_GENERATE_ROWS));
        }
    };

    const handleGenerate = async (): Promise<void> => {
        setError(undefined);
        setInserted(undefined);
        setConflicts(0);
        setInserting(true);

        // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower `try` without `catch`; the `finally` must still clear the busy flag on the throw path, and adding a catch just to satisfy the compiler would swallow the error
        try {
            // Vary the seed per click so repeated generations don't collide on
            // the deterministic `_id` the planner derives from (seed, index).
            const generated = await requestSeedRows({ count, existingIds: fkPools, seed: Date.now(), table });

            if (generated.kind === "error") {
                setError(generated.message);

                return;
            }

            const { rows } = generated;

            if (rows.length === 0) {
                setError(t("No rows generated — all columns were skipped."));

                return;
            }

            const outcome = await onInsertRows(rows);

            if (outcome.error !== undefined) {
                setError(outcome.error);

                return;
            }

            // `outcome.inserted` is the count that ACTUALLY landed — never
            // `rows.length` (the requested count), which a conflict-only batch
            // (every planned `_id` already existed) would overstate as if
            // nothing had been skipped.
            setInserted(outcome.inserted);
            setConflicts(outcome.conflicts);
        } finally {
            setInserting(false);
        }
    };

    const onGenerate = (): void => {
        fireAndForget(handleGenerate());
    };

    // Editable columns excluding the PK for the preview list.
    const editableColumns = columns.filter((column) => column.pk !== true);
    // FK columns with nothing to link to. The endpoint refuses the request, so
    // the button is disabled rather than left to fail after a round trip.
    const blockedFkColumns = collectUnresolvableFkColumns(columns, fkPools);

    return (
        <ModalShell label={t("Generate dummy rows")} onClose={onClose} panelTestId="gen-rows-panel" testId="gen-rows-overlay" variant="dialog">
            <div className="flex items-start justify-between">
                <div className="flex flex-col gap-0.5">
                    <h3 className="text-base text-foreground" data-testid="gen-rows-title">
                        {t("Generate dummy rows")}
                    </h3>
                    <p className="text-xs text-muted-foreground" data-testid="gen-rows-desc">
                        {t("Seed {table} with Faker-generated rows. Existing rows are not affected.", { table })}
                    </p>
                </div>
                <button className="text-xs text-muted-foreground hover:text-foreground" data-testid="gen-rows-close" onClick={onClose} type="button">
                    {t("Close")}
                </button>
            </div>

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
                    <p className="font-mono text-[11px] tracking-wide uppercase text-muted-foreground">{t("Columns to seed")}</p>
                    <ul className="flex flex-col gap-0.5" data-testid="gen-rows-columns">
                        {editableColumns.map((column) => {
                            const hasFk = column.ref !== undefined && column.type === "id";
                            const fkEmpty = hasFk && (fkPools[column.ref ?? ""] ?? []).length === 0;
                            const fkBadgeClass = fkEmpty ? "rounded bg-destructive/10 px-1 text-destructive" : "rounded bg-muted px-1 text-muted-foreground";
                            const fkBadgeTestId = fkEmpty ? `gen-rows-fk-empty-${column.name}` : `gen-rows-fk-ok-${column.name}`;
                            const fkBadgeText = fkEmpty
                                ? t("FK: no rows in {ref} — seed it first", { ref: column.ref ?? "" })
                                : t("→ {ref}", { ref: column.ref ?? "" });

                            return (
                                <li className="flex items-center gap-1.5 font-mono text-xs" key={column.name}>
                                    <span className="text-foreground">{column.name}</span>
                                    <span className="text-muted-foreground">({column.type})</span>
                                    {column.optional && <span className="rounded bg-muted px-1 font-mono text-[10px] tracking-wide uppercase">optional</span>}
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

            {blockedFkColumns.length > 0 && (
                <p className="text-xs text-destructive" data-testid="gen-rows-blocked" role="alert">
                    {t("Cannot generate rows: {cols} reference tables with no rows. Seed those tables first.", { cols: blockedFkColumns.join(", ") })}
                </p>
            )}

            {error !== undefined && (
                <p className="text-xs text-destructive" data-testid="gen-rows-error" role="alert">
                    {error}
                </p>
            )}

            {inserted !== undefined && error === undefined && (
                <p className="text-xs text-success" data-testid="gen-rows-success">
                    {conflicts > 0
                        ? t("Inserted {inserted} of {total} rows — {conflicts} skipped as id conflicts.", {
                              conflicts: conflicts.toString(),
                              inserted: inserted.toString(),
                              total: (inserted + conflicts).toString(),
                          })
                        : t("Inserted {count} rows successfully.", { count: inserted.toString() })}
                </p>
            )}

            <div className="flex justify-end gap-2">
                <button className={BTN} data-testid="gen-rows-cancel" onClick={onClose} type="button">
                    {t("Cancel")}
                </button>
                <button
                    className={BTN_DESTRUCTIVE}
                    data-testid="gen-rows-generate"
                    disabled={inserting || blockedFkColumns.length > 0}
                    onClick={onGenerate}
                    type="button"
                >
                    {inserting ? t("Inserting…") : t("Generate & insert")}
                </button>
            </div>
        </ModalShell>
    );
};

export { GenerateRowsDialog };
export type { GenerateRowsDialogProps };
