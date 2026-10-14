import type { ReactElement } from "react";

import { Button } from "../../components/ui/button";
import { useT } from "../../i18n/i18n-context";

/** Which form is open, if any. `destructive` is the migration-handoff notice. */
type Mode = "addColumn" | "addIndex" | "addTable" | "destructive" | null;

interface SchemaEditorModeBarProps {
    /** Disables everything but "Add table" — the other edits need a table to target. */
    readonly hasTables: boolean;
    readonly mode: Mode;
    readonly onAddColumn: () => void;
    readonly onAddIndex: () => void;
    readonly onAddTable: () => void;
    readonly onDestructive: () => void;
}

/**
 * The overlay's mode strip: which kind of edit is being composed.
 *
 * Its own component because it is a closed set of choices whose only state is
 * "which one is active" — the four buttons differ solely in label, testid, and
 * handler, so keeping them inline made the parent's markup four near-identical
 * twenty-line blocks. Every edit but "Add table" needs an existing table, hence
 * the shared `hasTables` gate.
 */
const SchemaEditorModeBar = ({ hasTables, mode, onAddColumn, onAddIndex, onAddTable, onDestructive }: SchemaEditorModeBarProps): ReactElement => {
    const t = useT();

    return (
        <div className="flex flex-wrap gap-2">
            <Button data-testid="sc-editor-add-table" onClick={onAddTable} size="xs" type="button" variant={mode === "addTable" ? "default" : "outline"}>
                {t("Add table")}
            </Button>
            <Button
                data-testid="sc-editor-add-column"
                disabled={!hasTables}
                onClick={onAddColumn}
                size="xs"
                type="button"
                variant={mode === "addColumn" ? "default" : "outline"}
            >
                {t("Add column")}
            </Button>
            <Button
                data-testid="sc-editor-add-index"
                disabled={!hasTables}
                onClick={onAddIndex}
                size="xs"
                type="button"
                variant={mode === "addIndex" ? "default" : "outline"}
            >
                {t("Add index")}
            </Button>
            <Button
                data-testid="sc-editor-destructive"
                disabled={!hasTables}
                onClick={onDestructive}
                size="xs"
                type="button"
                variant={mode === "destructive" ? "default" : "ghost"}
            >
                {t("Rename / drop / change type…")}
            </Button>
        </div>
    );
};

export { SchemaEditorModeBar };
export type { Mode };
