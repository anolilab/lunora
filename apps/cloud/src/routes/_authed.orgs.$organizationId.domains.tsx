import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { DomainsSection } from "../client/DomainsSection";
import type { OrgId } from "../client/types";
import { sectionLoader } from "./-section-loader";

const DomainsSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <DomainsSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/** `domains` tab — see `-section-loader.ts` for how its data is server-rendered. */
export const Route = createFileRoute("/_authed/orgs/$organizationId/domains")({
    component: DomainsSectionRoute,
    loader: sectionLoader(api.projects.listByOrg),
});
