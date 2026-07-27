import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { OrgId } from "../client/types";
import { UptimeSection } from "../client/UptimeSection";
import { preload } from "../ssr/loader";

const UptimeSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <UptimeSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/**
 * `uptime` tab. The section's primary query is resolved on the edge as the
 * signed-in user, so the table is in the first byte; `usePreloadedQuery` inside
 * the section takes it live over the WebSocket once mounted.
 */
export const Route = createFileRoute("/_authed/orgs/$organizationId/uptime")({
    component: UptimeSectionRoute,
    loader: async ({ params }) => {
        return {
            preloaded: await preload(api.billing.entitlements, { organizationId: params.organizationId as OrgId }),
        };
    },
});
