import type { ReactElement } from "react";
import { useState } from "react";

// Bundler-inlined shared helper (see CLAUDE.md `shared/` rules) — the same wire
// codec the row editor decodes with, so a tagged value typed here means what it
// means everywhere else in the browser.
import { decodeWire } from "../../../../../shared/wire-codec";
import { ModalShell } from "../../components/ui/modal-shell";
import { useT } from "../../i18n/i18n-context";

/** Shared control-button class for dialog actions. */
const BTN =
    "rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50";

/** Primary action button class. */
const BTN_PRIMARY =
    "rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:bg-primary/90 disabled:pointer-events-none disabled:opacity-50";

const FIELD = "rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus-visible:border-ring";

/** Props for the bulk-patch dialog. */
interface BulkPatchDialogProps {
    /** Editable columns of the active table; the caller has already dropped the meta columns. */
    readonly columns: ReadonlyArray<string>;

    /**
     * Apply the change: shallow-merge `doc` into every row matching the browser's
     * ACTIVE filters/search. The caller drains the bounded server op and surfaces
     * failures on the shared write-error banner, so this returns nothing and the
     * dialog closes straight after.
     */
    readonly onApply: (document_: Record<string, unknown>) => void;
    readonly onClose: () => void;
    /** The table being edited — for display only. */
    readonly table: string;
    /** Rows matching the active view: what the operator is about to write. */
    readonly total: number;
}

/**
 * The "set one column on every matching row" dialog — the write counterpart to
 * the data browser's "Delete N matching". Takes a column and a JSON-typed value
 * and hands the caller a one-field patch document.
 *
 * The value is parsed as JSON rather than taken as text so `true`, `42` and
 * `null` reach the writer as themselves; a string `"true"` would fail a
 * `v.boolean()` validator, which is exactly the confusion a free-text field
 * would create. `decodeWire` then mirrors the row editor, so a `v.bigint()` /
 * `v.bytes()` column can be set with the same tagged form the grid displays.
 *
 * The parse runs on every keystroke rather than on submit: the action stays
 * disabled and names the problem BEFORE the operator commits a write across
 * hundreds of rows.
 */
const BulkPatchDialog = ({ columns, onApply, onClose, table, total }: BulkPatchDialogProps): ReactElement => {
    const t = useT();

    const [column, setColumn] = useState<string>(columns[0] ?? "");
    const [valueText, setValueText] = useState<string>("");

    const onColumnChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
        setColumn(event.target.value);
    };

    const onValueChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        setValueText(event.target.value);
    };

    let value: unknown;
    let parseError: string | undefined;

    if (valueText.trim() === "") {
        parseError = t('Enter a JSON value — for example true, 0, null, or "done".');
    } else {
        try {
            value = decodeWire(JSON.parse(valueText));
        } catch (error) {
            parseError = t("Invalid JSON: {message}", { message: (error as Error).message });
        }
    }

    const canApply = column !== "" && parseError === undefined;

    const onConfirm = (): void => {
        if (!canApply) {
            return;
        }

        onApply({ [column]: value });
        onClose();
    };

    return (
        <ModalShell label={t("Set a column on matching rows")} onClose={onClose} panelTestId="bulk-patch-panel" testId="bulk-patch-overlay" variant="dialog">
            <div className="flex items-start justify-between">
                <div className="flex flex-col gap-0.5">
                    <h3 className="text-base text-foreground" data-testid="bulk-patch-title">
                        {t("Set a column on matching rows")}
                    </h3>
                    <p className="text-xs text-muted-foreground" data-testid="bulk-patch-desc">
                        {t("Writes {total} rows of {table} through the schema-aware writer — validators and indexes apply, exactly like a mutation.", {
                            table,
                            total: total.toString(),
                        })}
                    </p>
                </div>
                <button className="text-xs text-muted-foreground hover:text-foreground" data-testid="bulk-patch-close" onClick={onClose} type="button">
                    {t("Close")}
                </button>
            </div>

            <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-foreground" htmlFor="bulk-patch-column">
                    {t("Column")}
                </label>
                <select className={FIELD} data-testid="bulk-patch-column" id="bulk-patch-column" onChange={onColumnChange} value={column}>
                    {columns.map((name) => (
                        <option key={name} value={name}>
                            {name}
                        </option>
                    ))}
                </select>

                <label className="text-xs font-medium text-foreground" htmlFor="bulk-patch-value">
                    {t("Value")}
                </label>
                <input
                    className={`${FIELD} flex-1 font-mono`}
                    data-testid="bulk-patch-value"
                    id="bulk-patch-value"
                    onChange={onValueChange}
                    placeholder="true"
                    value={valueText}
                />
            </div>

            {parseError === undefined ? (
                <p className="font-mono text-xs text-muted-foreground" data-testid="bulk-patch-preview">
                    {`${column} = ${valueText.trim()}`}
                </p>
            ) : (
                <p className="text-xs text-destructive" data-testid="bulk-patch-error" role="alert">
                    {parseError}
                </p>
            )}

            <div className="flex justify-end gap-2">
                <button className={BTN} data-testid="bulk-patch-cancel" onClick={onClose} type="button">
                    {t("Cancel")}
                </button>
                <button className={BTN_PRIMARY} data-testid="bulk-patch-apply" disabled={!canApply} onClick={onConfirm} type="button">
                    {t("Set on {total} rows", { total: total.toString() })}
                </button>
            </div>
        </ModalShell>
    );
};

export { BulkPatchDialog };
export type { BulkPatchDialogProps };
