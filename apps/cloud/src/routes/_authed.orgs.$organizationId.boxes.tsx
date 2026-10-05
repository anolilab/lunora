import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { BoxesSection } from "../client/BoxesSection";
import type { OrgId } from "../client/types";
import { sectionLoader } from "./-section-loader";

const BoxesSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <BoxesSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/** `boxes` tab — the org's own servers (plan 458 W9); see `-section-loader.ts` for how its data is server-rendered. */
export const Route = createFileRoute("/_authed/orgs/$organizationId/boxes")({
    component: BoxesSectionRoute,
    loader: sectionLoader(api.boxes.list),
});
