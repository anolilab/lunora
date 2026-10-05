import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { SessionsSection } from "../client/SessionsSection";
import type { OrgId } from "../client/types";
import { sectionLoader } from "./-section-loader";

const SessionsSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <SessionsSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/** `sessions` tab — see `-section-loader.ts` for how its data is server-rendered. */
export const Route = createFileRoute("/_authed/orgs/$organizationId/sessions")({
    component: SessionsSectionRoute,
    loader: sectionLoader(api.sessions.list),
});
