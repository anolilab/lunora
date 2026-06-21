import type { ReactElement } from "react";

import { ModalShell } from "../../components/ui/modal-shell";
import { formatCell, formatTimestamp } from "../../lib/internal";

interface RowDetailDrawerProps {
    /** Column order to display fields in (mirrors the table's columns). */
    readonly columns: string[];
    /** Close the drawer. */
    readonly onClose: () => void;
    /** Follow a foreign-key field to its target table (same as a table ref cell). */
    readonly onNavigate: (target: string, id: string) => void;
    /** Foreign-key map (field → target table) from the page, for linkable fields. */
    readonly refs: Record<string, string> | undefined;
    /** The full document for the inspected row. */
    readonly row: Record<string, unknown>;
}

const TIMESTAMP_RE = /(?:_creationtime|(?:^|[a-z])(?:time|at))$/iu;

/** True when a numeric field reads as an epoch-millis timestamp by its name. */
const looksLikeTimestamp = (column: string, value: unknown): value is number => typeof value === "number" && TIMESTAMP_RE.test(column);

/** Render one field's value: null marker, ref link, readable timestamp, JSON, or text. */
const FieldValue = ({
    column,
    onNavigate,
    target,
    value,
}: {
    readonly column: string;
    readonly onNavigate: (target: string, id: string) => void;
    readonly target: string | undefined;
    readonly value: unknown;
}): ReactElement => {
    const onClick = (): void => {
        if (target !== undefined) {
            onNavigate(target, String(value));
        }
    };

    if (value === null || value === undefined) {
        return <span className="italic text-muted-foreground">null</span>;
    }

    if (target !== undefined && (typeof value === "string" || typeof value === "number") && String(value) !== "") {
        return (
            <button data-testid={`rd-ref-${column}`} onClick={onClick} title={`Open ${target} ${String(value)}`} type="button">
                {String(value)} ↗
            </button>
        );
    }

    if (looksLikeTimestamp(column, value)) {
        return (
            <span data-testid={`rd-ts-${column}`} title={value.toString()}>
                {formatTimestamp(value)}
            </span>
        );
    }

    if (typeof value === "object") {
        return <pre className="m-0 overflow-auto rounded-md bg-muted/50 p-2 text-xs">{JSON.stringify(value, null, 2)}</pre>;
    }

    return <span>{formatCell(value)}</span>;
};

/**
 * A right-hand drawer showing the full document for one row — every field
 * labelled, with foreign-key fields linking to their target table, numeric
 * timestamps rendered as readable dates, and nested objects pretty-printed.
 * Complements the table view (a wide row is hard to scan) without bloating it.
 *
 * Dismisses on a backdrop click (the overlay swallows clicks bubbling out of the
 * panel via the `target === currentTarget` check), on Escape, or via the Close
 * button — so it's keyboard-accessible without a click handler on the panel.
 */
const RowDetailDrawer = ({ columns, onClose, onNavigate, refs, row }: RowDetailDrawerProps): ReactElement => {
    // A ref field followed from the drawer should also dismiss it, so the table
    // view's navigation lands on a clean screen.
    const navigateAndClose = (target: string, id: string): void => {
        onNavigate(target, id);
        onClose();
    };

    return (
        <ModalShell label="Row detail" onClose={onClose} panelTestId="rd-panel" testId="rd-overlay" variant="drawer">
            <div className="mb-3 flex items-center justify-between">
                <h3 className="m-0 text-base text-foreground">Row detail</h3>
                <button data-testid="rd-close" onClick={onClose} type="button">
                    Close
                </button>
            </div>

            <dl data-testid="rd-fields">
                {columns.map((column) => (
                    <div className="border-t border-border py-2 first:border-t-0" data-testid={`rd-field-${column}`} key={column}>
                        <dt className="mb-0.5 text-xs font-semibold text-muted-foreground">{column}</dt>
                        <dd className="m-0">
                            <FieldValue column={column} onNavigate={navigateAndClose} target={refs?.[column]} value={row[column]} />
                        </dd>
                    </div>
                ))}
            </dl>
        </ModalShell>
    );
};

export { RowDetailDrawer };
export type { RowDetailDrawerProps };
