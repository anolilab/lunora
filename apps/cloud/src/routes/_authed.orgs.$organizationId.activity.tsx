import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { ActivitySection } from "../client/ActivitySection";
import type { OrgId } from "../client/types";
import { sectionLoader } from "./-section-loader";

const ActivitySectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <ActivitySection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/** `activity` tab — see `-section-loader.ts` for how its data is server-rendered. */
export const Route = createFileRoute("/_authed/orgs/$organizationId/activity")({
    component: ActivitySectionRoute,
    loader: sectionLoader(api.audit_log.list),
});
