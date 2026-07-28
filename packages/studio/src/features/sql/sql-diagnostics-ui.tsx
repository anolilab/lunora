import type { ReactElement, ReactNode } from "react";

import { useT } from "../../i18n/i18n-context";
import { cn } from "../../lib/utils";
import type { SqlDiagnostic } from "./sql-diagnostics";

/**
 * Typography the underline overlay MUST share with the editor textarea for the
 * squiggles to land under the right characters. Kept as one constant next to the
 * textarea's own class list (`sql-editor-panel.tsx`) so the two can't drift
 * silently — if you change padding, font, or leading in one, change both.
 */
const EDITOR_TEXT_CLASS = "p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words";

/** Split points for one diagnostic's span, clamped into the draft. */
interface Span {
    readonly end: number;
    readonly severity: SqlDiagnostic["severity"];
    readonly start: number;
}

/**
 * Turn diagnostics into non-overlapping, ordered spans. Overlaps are resolved by
 * dropping the later span rather than nesting decorations — two wavy underlines
 * on the same characters read as one smear, and the problems row below carries
 * both messages anyway.
 */
const toSpans = (diagnostics: ReadonlyArray<SqlDiagnostic>, length: number): Span[] => {
    const spans: Span[] = [];

    for (const diagnostic of diagnostics) {
        if (diagnostic.offset === undefined || diagnostic.length === undefined || diagnostic.length <= 0) {
            continue;
        }

        const start = Math.max(0, Math.min(diagnostic.offset, length));
        const end = Math.max(start, Math.min(diagnostic.offset + diagnostic.length, length));

        if (start !== end) {
            spans.push({ end, severity: diagnostic.severity, start });
        }
    }

    spans.sort((a, b) => a.start - b.start);

    return spans.filter((span, index) => index === 0 || span.start >= (spans[index - 1]?.end ?? 0));
};

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

/** Human-readable label per diagnostic source, so a row says where the finding came from. */
const sourceLabel = (source: SqlDiagnostic["source"]): string => {
    if (source === "gate") {
        return "read-only";
    }

    if (source === "plan") {
        return "plan";
    }

    return source === "syntax" ? "syntax" : "schema";
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
                            {sourceLabel(diagnostic.source)}
                        </span>
                        <span className="min-w-0 text-muted-foreground">{diagnostic.message}</span>
                    </button>
                </li>
            ))}
        </ul>
    );
};

export { DiagnosticsOverlay, DiagnosticsRow, EDITOR_TEXT_CLASS, toSpans };
