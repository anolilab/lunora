import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { IntegrationsSection } from "../client/IntegrationsSection";
import type { OrgId } from "../client/types";
import { sectionLoader } from "./-section-loader";

const IntegrationsSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <IntegrationsSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/** `integrations` tab — see `-section-loader.ts` for how its data is server-rendered. */
export const Route = createFileRoute("/_authed/orgs/$organizationId/integrations")({
    component: IntegrationsSectionRoute,
    loader: sectionLoader(api.github_installations.list),
});
