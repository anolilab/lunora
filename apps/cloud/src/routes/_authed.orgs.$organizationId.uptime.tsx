import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { OrgId } from "../client/types";
import { UptimeSection } from "../client/UptimeSection";
import { sectionLoader } from "./-section-loader";

const UptimeSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <UptimeSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/**
 * `uptime` tab. Preloads the **entitlement gate**, not the table — so the paid/unpaid
 * decision is server-rendered and there is no upsell flash. The list itself is
 * gated behind that entitlement and still arrives client-side.
 */
export const Route = createFileRoute("/_authed/orgs/$organizationId/uptime")({
    component: UptimeSectionRoute,
    loader: sectionLoader(api.billing.entitlements),
});
