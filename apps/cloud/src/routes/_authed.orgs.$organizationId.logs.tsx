import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { LogsSection } from "../client/LogsSection";
import type { OrgId } from "../client/types";
import { preload } from "../ssr/loader";

const LogsSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();
    const { traceId } = Route.useSearch();

    return <LogsSection focusTraceId={traceId} organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/**
 * `logs` tab. The section's primary query is resolved on the edge as the
 * signed-in user, so the table is in the first byte; `usePreloadedQuery` inside
 * the section takes it live over the WebSocket once mounted.
 */
export const Route = createFileRoute("/_authed/orgs/$organizationId/logs")({
    component: LogsSectionRoute,
    validateSearch: (search: Record<string, unknown>): { traceId?: string } => {
        return {
            traceId: typeof search.traceId === "string" ? search.traceId : undefined,
        };
    },
    loader: async ({ params }) => {
        return {
            preloaded: await preload(api.projects.listByOrg, { organizationId: params.organizationId as OrgId }),
        };
    },
});
