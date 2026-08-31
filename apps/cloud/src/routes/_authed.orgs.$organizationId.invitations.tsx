import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { InvitationsSection } from "../client/InvitationsSection";
import type { OrgId } from "../client/types";
import { sectionLoader } from "./-section-loader";

const InvitationsSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <InvitationsSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/** `invitations` tab — see `-section-loader.ts` for how its data is server-rendered. */
export const Route = createFileRoute("/_authed/orgs/$organizationId/invitations")({
    component: InvitationsSectionRoute,
    loader: sectionLoader(api.invitations.list),
});
