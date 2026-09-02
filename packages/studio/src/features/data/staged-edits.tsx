import type { ReactElement } from "react";
import { useState } from "react";

import { useT } from "../../i18n/i18n-context";
import { formatCell } from "../../lib/internal";

/** Pending edits, keyed `rowId → column → new value`. */
type StagedEdits = Record<string, Record<string, unknown>>;

/** One pending cell change, resolved against the loaded page for its `old` value. */
interface StagedChange {
    readonly column: string;
    readonly newValue: unknown;
    readonly oldValue: unknown;
    readonly rowId: string;
}

interface StagedEditsModel {
    /** Drop every pending edit. */
    readonly clear: () => void;
    /** Total number of staged (row, column) cells. */
    readonly count: number;

    /**
     * Drop the cells one row's patch just wrote — used as each row commits, so a
     * mid-batch failure leaves only the rows still unwritten staged. `committed`
     * is the snapshot the patch was built from: a cell restaged since then was
     * NOT written and stays pending.
     */
    readonly drop: (rowId: string, committed: Readonly<Record<string, unknown>>) => void;
    /** Stage (or overwrite) one cell's pending value. */
    readonly stage: (rowId: string, column: string, value: unknown) => void;
    /** The raw buffer, for commit. */
    readonly staged: StagedEdits;
    /** The staged value for a cell, or `undefined` when that cell isn't edited. */
    readonly stagedValue: (rowId: string, column: string) => undefined | { value: unknown };
}

/**
 * The Outerbase-style staged-edit buffer: inline cell edits accumulate here
 * instead of writing immediately, so an operator can review every change as a
 * diff and commit (or discard) them as a batch. Pure client state — the buffer
 * is keyed by row primary key + column and holds the pending value; the data
 * browser resolves the `old` value against the loaded page when rendering the
 * diff and patches each row on commit.
 */
const useStagedEdits = (): StagedEditsModel => {
    const [staged, setStaged] = useState<StagedEdits>({});

    const stage = (rowId: string, column: string, value: unknown): void => {
        setStaged((previous) => {
            return { ...previous, [rowId]: { ...previous[rowId], [column]: value } };
        });
    };

    const clear = (): void => {
        setStaged({});
    };

    const drop = (rowId: string, committed: Readonly<Record<string, unknown>>): void => {
        setStaged((previous) => {
            const row = previous[rowId];

            if (row === undefined) {
                return previous;
            }

            // Only the cells whose staged value is still the one that was
            // written leave the buffer. The grid stays editable while a commit
            // is in flight and `commitStaged` iterates a snapshot, so dropping
            // the whole row entry silently discarded any edit made since —
            // an edit the writer never saw.
            const pending = Object.fromEntries(Object.entries(row).filter(([column, value]) => !Object.is(value, committed[column])));

            if (Object.keys(pending).length === 0) {
                return Object.fromEntries(Object.entries(previous).filter(([id]) => id !== rowId));
            }

            // Overwrite in place. Deleting the key and re-adding it moved the row
            // to the END of the buffer, and insertion order is what `commitStaged`
            // iterates and the diff panel renders — so a partly-committed row
            // jumped to the bottom of a list the operator was reading, and the
            // retry ran out of the order the writes were made in.
            return { ...previous, [rowId]: pending };
        });
    };

    const stagedValue = (rowId: string, column: string): undefined | { value: unknown } => {
        const row = staged[rowId];

        return row !== undefined && column in row ? { value: row[column] } : undefined;
    };

    const count = Object.values(staged).reduce((sum, columns) => sum + Object.keys(columns).length, 0);

    return { clear, count, drop, stage, staged, stagedValue };
};

/**
 * Coerce an edited cell's raw input text back to the original value's type, so a
 * numeric column stays numeric and a boolean stays boolean. Unparseable numbers
 * and non-`true`/`false` booleans fall back to the raw string rather than
 * silently corrupting the value; everything else stays a string.
 */
const coerceCellValue = (raw: string, original: unknown): unknown => {
    if (typeof original === "number") {
        const parsed = Number(raw);

        return raw.trim() === "" || Number.isNaN(parsed) ? raw : parsed;
    }

    if (typeof original === "boolean") {
        if (raw === "true") {
            return true;
        }

        if (raw === "false") {
            return false;
        }
    }

    return raw;
};

interface StagedDiffPanelProps {
    readonly changes: ReadonlyArray<StagedChange>;
    readonly committing: boolean;
    readonly onCommit: () => void;
    readonly onDiscard: () => void;
}

/**
 * The review-and-commit panel for staged edits: a per-cell `old → new` diff with
 * Commit and Discard actions. Mirrors Outerbase Studio's stage-then-commit flow
 * so a batch of inline edits is auditable before it ever hits the writer.
 */
const StagedDiffPanel = ({ changes, committing, onCommit, onDiscard }: StagedDiffPanelProps): ReactElement => {
    const t = useT();

    return (
        <div className="flex flex-col gap-2 border border-warning/40 bg-warning/5 p-3" data-testid="db-staged">
            <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] tracking-wide uppercase text-warning" data-testid="db-staged-count">
                    {t("{count} pending changes", { count: changes.length })}
                </span>
                <button
                    className="ms-auto rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
                    data-testid="db-staged-commit"
                    disabled={committing}
                    onClick={onCommit}
                    type="button"
                >
                    {committing ? t("Committing…") : t("Commit")}
                </button>
                <button
                    className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50"
                    data-testid="db-staged-discard"
                    disabled={committing}
                    onClick={onDiscard}
                    type="button"
                >
                    {t("Discard")}
                </button>
            </div>
            <ul className="flex flex-col gap-1" data-testid="db-staged-list">
                {changes.map((change) => (
                    <li className="flex flex-wrap items-center gap-2 font-mono text-xs" key={`${change.rowId}:${change.column}`}>
                        <span className="text-muted-foreground">
                            {change.rowId}.{change.column}
                        </span>
                        <span className="text-destructive line-through">{formatCell(change.oldValue)}</span>
                        <span aria-hidden="true" className="text-muted-foreground">
                            →
                        </span>
                        <span className="text-foreground">{formatCell(change.newValue)}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
};

export { coerceCellValue, StagedDiffPanel, useStagedEdits };
export type { StagedChange, StagedEdits, StagedEditsModel };
