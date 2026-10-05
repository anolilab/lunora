import { Link, useParams } from "@tanstack/react-router";
import type { ReactElement, ReactNode } from "react";

interface CrossTabLinkProps {
    children: ReactNode;
    /** The tab to open. */
    target: "logs" | "traces";
    /** The trace to focus in the target tab (omit to just switch tabs). */
    traceId?: string;
    /** `inline` sits within a text line (e.g. a log line); `standalone` stands on its own. */
    variant?: "inline" | "standalone";
}

/**
 * The shared cross-tab deep-link — Issue → trace, trace → logs, log line → trace.
 * One element and one style, so the call sites can't drift apart (the finding that
 * motivated it: near-duplicate `.trace-link`/`.log-trace-link` markup + CSS).
 *
 * Now a real router `Link` rather than a `&lt;button>`: the target tab is a route and
 * the focused trace is its `?traceId=` search param, so these links are
 * middle-clickable, shareable and back-button-aware. The old version took an
 * `onOpenTab` callback threaded down from the dashboard, which bumped a `seq`
 * counter to force-remount the target section; the organization now comes from the
 * route params, so nothing needs passing in at all.
 */
export const CrossTabLink = ({ children, target, traceId, variant = "standalone" }: CrossTabLinkProps): ReactElement => {
    const { organizationId } = useParams({ from: "/_authed/orgs/$organizationId" });

    return (
        <Link
            className={variant === "inline" ? "cross-tab-link cross-tab-link-inline" : "cross-tab-link"}
            params={{ organizationId }}
            search={traceId === undefined ? {} : { traceId }}
            to={target === "logs" ? "/orgs/$organizationId/logs" : "/orgs/$organizationId/traces"}
        >
            {children}
        </Link>
    );
};
