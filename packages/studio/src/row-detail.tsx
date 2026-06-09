import type { CSSProperties, ReactElement } from "react";
import { useCallback } from "react";

import { ModalShell } from "./components/ui/modal-shell";
import { formatCell, formatTimestamp } from "./internal";

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

const HEAD_STYLE: CSSProperties = { alignItems: "center", display: "flex", justifyContent: "space-between", margin: "0 0 12px" };
const TITLE_STYLE: CSSProperties = { fontSize: 14, fontWeight: 600, margin: 0 };
const FIELD_STYLE: CSSProperties = { borderTop: "1px solid #eaeef2", padding: "8px 0" };
const KEY_STYLE: CSSProperties = { color: "#57606a", fontSize: 12, fontWeight: 600, margin: "0 0 2px" };
const VALUE_STYLE: CSSProperties = { margin: 0 };
const NULL_STYLE: CSSProperties = { color: "#8c959f", fontStyle: "italic" };
const PRE_STYLE: CSSProperties = { background: "#f6f8fa", borderRadius: 6, margin: 0, overflow: "auto", padding: 8 };
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
    const onClick = useCallback((): void => {
        if (target !== undefined) {
            onNavigate(target, String(value));
        }
    }, [onNavigate, target, value]);

    if (value === null || value === undefined) {
        return <span style={NULL_STYLE}>null</span>;
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
        return <pre style={PRE_STYLE}>{JSON.stringify(value, null, 2)}</pre>;
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
    const navigateAndClose = useCallback(
        (target: string, id: string): void => {
            onNavigate(target, id);
            onClose();
        },
        [onNavigate, onClose],
    );

    return (
        <ModalShell label="Row detail" onClose={onClose} panelTestId="rd-panel" testId="rd-overlay" variant="drawer">
            <div style={HEAD_STYLE}>
                <h3 style={TITLE_STYLE}>Row detail</h3>
                <button data-testid="rd-close" onClick={onClose} type="button">
                    Close
                </button>
            </div>

            <dl data-testid="rd-fields">
                {columns.map((column) => (
                    <div data-testid={`rd-field-${column}`} key={column} style={FIELD_STYLE}>
                        <dt style={KEY_STYLE}>{column}</dt>
                        <dd style={VALUE_STYLE}>
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
