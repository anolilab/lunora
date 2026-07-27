import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { BillingSection } from "../client/BillingSection";
import type { OrgId } from "../client/types";
import { preload } from "../ssr/loader";

const BillingSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <BillingSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/**
 * `billing` tab. The section's primary query is resolved on the edge as the
 * signed-in user, so the table is in the first byte; `usePreloadedQuery` inside
 * the section takes it live over the WebSocket once mounted.
 */
export const Route = createFileRoute("/_authed/orgs/$organizationId/billing")({
    component: BillingSectionRoute,
    loader: async ({ params }) => {
        return {
            preloaded: await preload(api.billing.entitlements, { organizationId: params.organizationId as OrgId }),
        };
    },
});
