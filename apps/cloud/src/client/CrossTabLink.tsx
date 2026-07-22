import type { ReactElement, ReactNode } from "react";

interface CrossTabLinkProps {
    children: ReactNode;
    /** Deep-link to another tab, carrying an optional trace id for it to focus. */
    onOpenTab: (tab: "logs" | "traces", context?: { traceId?: string }) => void;
    /** The tab to open. */
    target: "logs" | "traces";
    /** The trace to focus in the target tab (omit to just switch tabs). */
    traceId?: string;
    /** `inline` sits within a text line (e.g. a log line); `standalone` stands on its own. */
    variant?: "inline" | "standalone";
}

/**
 * The shared cross-tab deep-link button — Issue → trace, trace → logs, log line →
 * trace. One element and one style, so the three call sites can't drift apart (the
 * finding that motivated this: near-duplicate `.trace-link`/`.log-trace-link` markup
 * + CSS). The dashboard's `onOpenTab` bumps the focus seq and remounts the target.
 */
export const CrossTabLink = ({ children, onOpenTab, target, traceId, variant = "standalone" }: CrossTabLinkProps): ReactElement => (
    <button
        className={variant === "inline" ? "cross-tab-link cross-tab-link-inline" : "cross-tab-link"}
        onClick={() => onOpenTab(target, { traceId })}
        type="button"
    >
        {children}
    </button>
);
