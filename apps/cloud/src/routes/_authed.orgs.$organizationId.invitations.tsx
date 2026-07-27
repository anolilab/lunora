import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { InvitationsSection } from "../client/InvitationsSection";
import type { OrgId } from "../client/types";
import { preload } from "../ssr/loader";

const InvitationsSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <InvitationsSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/**
 * `invitations` tab. The section's primary query is resolved on the edge as the
 * signed-in user, so the table is in the first byte; `usePreloadedQuery` inside
 * the section takes it live over the WebSocket once mounted.
 */
export const Route = createFileRoute("/_authed/orgs/$organizationId/invitations")({
    component: InvitationsSectionRoute,
    loader: async ({ params }) => {
        return {
            preloaded: await preload(api.invitations.list, { organizationId: params.organizationId as OrgId }),
        };
    },
});
