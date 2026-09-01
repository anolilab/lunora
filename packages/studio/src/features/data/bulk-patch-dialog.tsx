import type { ReactElement } from "react";
import { useState } from "react";

// Bundler-inlined shared helper (see CLAUDE.md `shared/` rules) — the same wire
// codec the row editor decodes with, so a tagged value typed here means what it
// means everywhere else in the browser.
import { decodeWire } from "../../../../../shared/wire-codec";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { ModalShell } from "../../components/ui/modal-shell";
import { useT } from "../../i18n/i18n-context";

/** Props for the bulk-patch dialog. */
interface BulkPatchDialogProps {
    /** Editable columns of the active table; the caller has already dropped the meta columns. */
    readonly columns: ReadonlyArray<string>;

    /**
     * Apply the change: shallow-merge `doc` into every row matching the browser's
     * ACTIVE filters/search. The caller drains the bounded server op and surfaces
     * both the written-row count and any failure on the shared banners, so this
     * returns nothing and the dialog closes straight after.
     */
    readonly onApply: (document_: Record<string, unknown>) => void;
    readonly onClose: () => void;

    /**
     * The shard these rows live in — the write reaches THIS shard only. The data
     * browser is shard-addressed, so on a `.shardBy()` table "every matching row"
     * means "every matching row here", and an operator who typed a shard key to
     * get to this view should be told the write inherits it. Empty ⇒ root.
     */
    readonly shardKey: string;
    /** The table being edited — for display only. */
    readonly table: string;
    /** Rows matching the active view: what the operator is about to write. */
    readonly total: number;
    /** Columns carrying a single-column UNIQUE index — setting one to a constant across rows cannot succeed. */
    readonly uniqueColumns: ReadonlySet<string>;
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
const BulkPatchDialog = ({ columns, onApply, onClose, shardKey, table, total, uniqueColumns }: BulkPatchDialogProps): ReactElement => {
    const t = useT();

    const [column, setColumn] = useState<string>(columns[0] ?? "");
    const [valueText, setValueText] = useState<string>("");

    const onColumnChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
        setColumn(event.target.value);
    };

    const onValueChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        setValueText(event.target.value);
    };

    // Three states, not two: PRISTINE (nothing typed yet) is a hint, not a
    // failure. Collapsing it into `parseError` would open the dialog showing a
    // red `role="alert"` before the operator has touched anything.
    const pristine = valueText.trim() === "";

    let value: unknown;
    let parseError: string | undefined;

    if (!pristine) {
        try {
            value = decodeWire(JSON.parse(valueText));
        } catch (error) {
            parseError = t("Invalid JSON: {message}", { message: (error as Error).message });
        }
    }

    // A single-column unique index cannot hold the same value twice, so setting
    // one across two or more matching rows is guaranteed to fail partway — after
    // the first row has already committed. Blocked rather than warned: there is no
    // input the operator could add that would make it work.
    const uniqueBlocked = uniqueColumns.has(column) && total > 1;

    const canApply = column !== "" && !pristine && parseError === undefined && !uniqueBlocked;

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
                    <p className="text-xs text-muted-foreground" data-testid="bulk-patch-shard">
                        {shardKey === "" ? t("Shard: root") : t("Shard: {shardKey} — rows in other shards are not touched.", { shardKey })}
                    </p>
                </div>
                <Button data-testid="bulk-patch-close" onClick={onClose} size="xs" variant="ghost">
                    {t("Close")}
                </Button>
            </div>

            <div className="flex items-center gap-2">
                <Label htmlFor="bulk-patch-column">{t("Column")}</Label>
                {/*
                 * A native `<select>`, not `components/ui/select`: that one is a Base UI
                 * listbox, and the data browser's other column pickers (`DataFilters`)
                 * are native for the same reason — `fireEvent.change` drives them
                 * directly in the component tests. Styled to match the shared `Input`
                 * beside it so the row doesn't read as half-designed.
                 */}
                <select
                    aria-label={t("Column")}
                    className="h-8 rounded-md border border-input bg-transparent px-2 py-1 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
                    data-testid="bulk-patch-column"
                    id="bulk-patch-column"
                    onChange={onColumnChange}
                    value={column}
                >
                    {columns.map((name) => (
                        <option key={name} value={name}>
                            {name}
                        </option>
                    ))}
                </select>

                <Label htmlFor="bulk-patch-value">{t("Value")}</Label>
                <Input
                    className="flex-1 font-mono"
                    data-testid="bulk-patch-value"
                    id="bulk-patch-value"
                    onChange={onValueChange}
                    placeholder="true"
                    value={valueText}
                />
            </div>

            {parseError !== undefined && (
                <p className="text-xs text-destructive" data-testid="bulk-patch-error" role="alert">
                    {parseError}
                </p>
            )}

            {uniqueBlocked && (
                <p className="text-xs text-destructive" data-testid="bulk-patch-unique" role="alert">
                    {t("{column} has a unique index — the same value cannot be set on {total} rows.", { column, total: total.toString() })}
                </p>
            )}

            {pristine && !uniqueBlocked && (
                <p className="text-xs text-muted-foreground" data-testid="bulk-patch-hint">
                    {t('Enter a JSON value — for example true, 0, null, or "done".')}
                </p>
            )}

            {canApply && (
                <p className="font-mono text-xs text-muted-foreground" data-testid="bulk-patch-preview">
                    {`${column} = ${valueText.trim()}`}
                </p>
            )}

            <div className="flex justify-end gap-2">
                <Button data-testid="bulk-patch-cancel" onClick={onClose} size="xs" variant="outline">
                    {t("Cancel")}
                </Button>
                <Button data-testid="bulk-patch-apply" disabled={!canApply} onClick={onConfirm} size="xs">
                    {t("Set on {total} rows", { total: total.toString() })}
                </Button>
            </div>
        </ModalShell>
    );
};

export { BulkPatchDialog };
export type { BulkPatchDialogProps };
