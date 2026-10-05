import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { MembersSection } from "../client/MembersSection";
import type { OrgId } from "../client/types";
import { sectionLoader } from "./-section-loader";

const MembersSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <MembersSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/** `members` tab — see `-section-loader.ts` for how its data is server-rendered. */
export const Route = createFileRoute("/_authed/orgs/$organizationId/members")({
    component: MembersSectionRoute,
    loader: sectionLoader(api.members.list),
});
