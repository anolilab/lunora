import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { TracesSection } from "../client/TracesSection";
import type { OrgId } from "../client/types";
import { sectionLoader } from "./-section-loader";

const TracesSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();
    const { traceId } = Route.useSearch();

    // `key` on the trace id so a change to `?traceId=` remounts the section.
    // `focusTraceId` is consumed as a one-shot `useState` seed inside, which only
    // re-runs on mount — and the router remounts on a *route* change, not a
    // search-param change. Without this, navigating from
    // `/orgs/x/traces?traceId=A` to `/orgs/x/traces` (clicking the tab drops the
    // search) left the previous trace filter on screen contradicting the URL.
    return <TracesSection focusTraceId={traceId} key={traceId ?? ""} organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/** `traces` tab — see `-section-loader.ts` for how its data is server-rendered. */
export const Route = createFileRoute("/_authed/orgs/$organizationId/traces")({
    component: TracesSectionRoute,
    validateSearch: (search: Record<string, unknown>): { traceId?: string } => {
        return {
            traceId: typeof search.traceId === "string" ? search.traceId : undefined,
        };
    },
    loader: sectionLoader(api.projects.listByOrg),
});
