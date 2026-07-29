import type { ReactElement, ReactNode } from "react";

import { useT } from "../../i18n/i18n-context";
import { cn } from "../../lib/utils";
import { EDITOR_TEXT_CLASS, toSpans } from "./editor-spans";
import type { DiagnosticSource, SqlDiagnostic } from "./sql-diagnostics";

/**
 * A transparent mirror of the editor text that draws a wavy underline beneath
 * each diagnostic span.
 *
 * This is the same alignment trick the line-number gutter already relies on: an
 * element that shares the textarea's font metrics and scroll offset, so
 * character N sits at the same pixel in both. The text here is fully
 * transparent — only the `text-decoration` is visible — and the whole layer is
 * `aria-hidden` + `pointer-events-none`, because it is pure decoration. The
 * accessible, always-correct rendering of the same information is
 * {@link DiagnosticsRow} below; if this overlay ever misaligns, the feature
 * degrades to that rather than breaking.
 */
const DiagnosticsOverlay = ({
    diagnostics,
    draft,
    scrollRef,
}: {
    readonly diagnostics: ReadonlyArray<SqlDiagnostic>;
    readonly draft: string;
    readonly scrollRef: React.RefObject<HTMLDivElement | null>;
}): ReactElement | null => {
    const spans = toSpans(diagnostics, draft.length);

    if (spans.length === 0) {
        return null;
    }

    const parts: ReactNode[] = [];
    let cursor = 0;

    for (const [index, span] of spans.entries()) {
        if (span.start > cursor) {
            parts.push(draft.slice(cursor, span.start));
        }

        parts.push(
            <span
                className={cn("decoration-wavy underline underline-offset-4", span.severity === "error" ? "decoration-destructive" : "decoration-amber-500")}
                key={`${span.start.toString()}-${index.toString()}`}
            >
                {draft.slice(span.start, span.end)}
            </span>,
        );
        cursor = span.end;
    }

    parts.push(draft.slice(cursor));

    return (
        <div
            aria-hidden="true"
            className={cn("pointer-events-none absolute inset-0 overflow-hidden text-transparent", EDITOR_TEXT_CLASS)}
            data-testid="sql-diagnostics-overlay"
            ref={scrollRef}
        >
            {parts}
        </div>
    );
};

/**
 * Human-readable label per diagnostic source, so a row says where the finding
 * came from. A record rather than a branch chain: adding a source to the union
 * without a label here is then a compile error.
 */
const SOURCE_LABEL: Readonly<Record<DiagnosticSource, string>> = {
    gate: "read-only",
    plan: "plan",
    schema: "schema",
    syntax: "syntax",
};

/**
 * The textual rendering of the same diagnostics, under the editor.
 *
 * Not a fallback that only appears when the overlay fails — it is always shown,
 * because a wavy underline is invisible to a screen reader and unreadable
 * without the message. Clicking a row selects the offending span in the editor.
 */
const DiagnosticsRow = ({
    diagnostics,
    onSelect,
}: {
    readonly diagnostics: ReadonlyArray<SqlDiagnostic>;
    readonly onSelect: (diagnostic: SqlDiagnostic) => void;
}): ReactElement | null => {
    const t = useT();

    if (diagnostics.length === 0) {
        return null;
    }

    return (
        <ul aria-label={t("SQL problems")} className="max-h-24 shrink-0 overflow-y-auto border-t border-border bg-muted/30" data-testid="sql-problems">
            {diagnostics.map((diagnostic, index) => (
                <li key={`${diagnostic.source}-${(diagnostic.offset ?? index).toString()}-${index.toString()}`}>
                    <button
                        className="flex w-full items-start gap-2 px-3 py-1 text-start text-xs outline-none hover:bg-accent focus-visible:bg-accent"
                        data-testid="sql-problem"
                        onClick={() => {
                            onSelect(diagnostic);
                        }}
                        type="button"
                    >
                        <span
                            className={cn(
                                "mt-px shrink-0 rounded px-1 font-mono text-[10px] uppercase",
                                diagnostic.severity === "error" ? "bg-destructive/15 text-destructive" : "bg-amber-500/15 text-amber-600",
                            )}
                        >
                            {SOURCE_LABEL[diagnostic.source]}
                        </span>
                        <span className="min-w-0 text-muted-foreground">{diagnostic.message}</span>
                    </button>
                </li>
            ))}
        </ul>
    );
};

export { DiagnosticsOverlay, DiagnosticsRow };
