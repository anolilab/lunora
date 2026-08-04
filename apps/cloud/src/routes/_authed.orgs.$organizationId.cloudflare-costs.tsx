import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { CloudflareCostsSection } from "../client/CloudflareCostsSection";
import type { OrgId } from "../client/types";
import { sectionLoader } from "./-section-loader";

const CloudflareCostsSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <CloudflareCostsSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/** `cloudflare-costs` tab — see `-section-loader.ts` for how its status query is server-rendered. */
export const Route = createFileRoute("/_authed/orgs/$organizationId/cloudflare-costs")({
    component: CloudflareCostsSectionRoute,
    loader: sectionLoader(api.cloudflare_billing.status),
});
