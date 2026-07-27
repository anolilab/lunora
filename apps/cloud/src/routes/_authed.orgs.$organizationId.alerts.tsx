import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { AlertsSection } from "../client/AlertsSection";
import type { OrgId } from "../client/types";
import { preload } from "../ssr/loader";

const AlertsSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <AlertsSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/**
 * `alerts` tab. The section's primary query is resolved on the edge as the
 * signed-in user, so the table is in the first byte; `usePreloadedQuery` inside
 * the section takes it live over the WebSocket once mounted.
 */
export const Route = createFileRoute("/_authed/orgs/$organizationId/alerts")({
    component: AlertsSectionRoute,
    loader: async ({ params }) => {
        return {
            preloaded: await preload(api.billing.entitlements, { organizationId: params.organizationId as OrgId }),
        };
    },
});
