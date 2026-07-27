import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { MembersSection } from "../client/MembersSection";
import type { OrgId } from "../client/types";
import { preload } from "../ssr/loader";

const MembersSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <MembersSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/**
 * `members` tab. The section's primary query is resolved on the edge as the
 * signed-in user, so the table is in the first byte; `usePreloadedQuery` inside
 * the section takes it live over the WebSocket once mounted.
 */
export const Route = createFileRoute("/_authed/orgs/$organizationId/members")({
    component: MembersSectionRoute,
    loader: async ({ params }) => {
        return {
            preloaded: await preload(api.members.list, { organizationId: params.organizationId as OrgId }),
        };
    },
});
