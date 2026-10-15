import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { LogsSection } from "../client/LogsSection";
import type { OrgId } from "../client/types";
import { sectionLoader } from "./-section-loader";

const LogsSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();
    const { traceId } = Route.useSearch();

    // `key` on the trace id so a change to `?traceId=` remounts the section.
    // `focusTraceId` is consumed as a one-shot `useState` seed inside, which only
    // re-runs on mount — and the router remounts on a *route* change, not a
    // search-param change. Without this, navigating from
    // `/orgs/x/logs?traceId=A` to `/orgs/x/logs` (clicking the tab drops the
    // search) left the previous trace filter on screen contradicting the URL.
    return <LogsSection focusTraceId={traceId} key={traceId ?? ""} organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/** `logs` tab — see `-section-loader.ts` for how its data is server-rendered. */
export const Route = createFileRoute("/_authed/orgs/$organizationId/logs")({
    component: LogsSectionRoute,
    validateSearch: (search: Record<string, unknown>): { traceId?: string } => {
        return {
            traceId: typeof search.traceId === "string" ? search.traceId : undefined,
        };
    },
    loader: sectionLoader(api.projects.listByOrg),
});
