import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { DashboardsSection } from "../client/DashboardsSection";
import type { OrgId } from "../client/types";
import { sectionLoader } from "./-section-loader";

const DashboardsSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <DashboardsSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/** `dashboards` tab — see `-section-loader.ts` for how its data is server-rendered. */
export const Route = createFileRoute("/_authed/orgs/$organizationId/dashboards")({
    component: DashboardsSectionRoute,
    loader: sectionLoader(api.dashboards.list),
});
