import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { BillingSection } from "../client/BillingSection";
import type { OrgId } from "../client/types";
import { sectionLoader } from "./-section-loader";

const BillingSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <BillingSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/**
 * `billing` tab. Preloads the **entitlement gate**, not the table — so the paid/unpaid
 * decision is server-rendered and there is no upsell flash. The list itself is
 * gated behind that entitlement and still arrives client-side.
 */
export const Route = createFileRoute("/_authed/orgs/$organizationId/billing")({
    component: BillingSectionRoute,
    loader: sectionLoader(api.billing.entitlements),
});
