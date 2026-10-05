import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { BuildsSection } from "../client/BuildsSection";
import type { OrgId } from "../client/types";
import { sectionLoader } from "./-section-loader";

const BuildsSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <BuildsSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/** `builds` tab — see `-section-loader.ts` for how its data is server-rendered. */
export const Route = createFileRoute("/_authed/orgs/$organizationId/builds")({
    component: BuildsSectionRoute,
    loader: sectionLoader(api.projects.listByOrg),
});
