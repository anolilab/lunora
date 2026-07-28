import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { OrgId } from "../client/types";
import { UsageSection } from "../client/UsageSection";
import { monthStart } from "../client/usage-period";
import { preload } from "../ssr/loader";

const UsageSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <UsageSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/**
 * `usage` tab. The section's primary query is resolved on the edge as the
 * signed-in user, so the table is in the first byte; `usePreloadedQuery` inside
 * the section takes it live over the WebSocket once mounted.
 */
export const Route = createFileRoute("/_authed/orgs/$organizationId/usage")({
    component: UsageSectionRoute,
    loader: async ({ params }) => {
        return {
            preloaded: await preload(api.usage.summary, { organizationId: params.organizationId as OrgId, periodStart: monthStart() }),
        };
    },
});
