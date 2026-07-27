import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { DashboardsSection } from "../client/DashboardsSection";
import type { OrgId } from "../client/types";
import { preload } from "../ssr/loader";

const DashboardsSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <DashboardsSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/**
 * `dashboards` tab. The section's primary query is resolved on the edge as the
 * signed-in user, so the table is in the first byte; `usePreloadedQuery` inside
 * the section takes it live over the WebSocket once mounted.
 */
export const Route = createFileRoute("/_authed/orgs/$organizationId/dashboards")({
    component: DashboardsSectionRoute,
    loader: async ({ params }) => {
        return {
            preloaded: await preload(api.dashboards.list, { organizationId: params.organizationId as OrgId }),
        };
    },
});
