import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { ProjectsSection } from "../client/ProjectsSection";
import type { OrgId } from "../client/types";
import { sectionLoader } from "./-section-loader";

const ProjectsSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <ProjectsSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/** `projects` tab — see `-section-loader.ts` for how its data is server-rendered. */
export const Route = createFileRoute("/_authed/orgs/$organizationId/projects")({
    component: ProjectsSectionRoute,
    loader: sectionLoader(api.projects.listByOrg),
});
