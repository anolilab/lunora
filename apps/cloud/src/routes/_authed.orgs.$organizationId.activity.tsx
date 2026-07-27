import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { ActivitySection } from "../client/ActivitySection";
import type { OrgId } from "../client/types";
import { preload } from "../ssr/loader";

const ActivitySectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <ActivitySection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/**
 * `activity` tab. The section's primary query is resolved on the edge as the
 * signed-in user, so the table is in the first byte; `usePreloadedQuery` inside
 * the section takes it live over the WebSocket once mounted.
 */
export const Route = createFileRoute("/_authed/orgs/$organizationId/activity")({
    component: ActivitySectionRoute,
    loader: async ({ params }) => {
        return {
            preloaded: await preload(api.audit_log.list, { organizationId: params.organizationId as OrgId }),
        };
    },
});
