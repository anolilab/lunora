import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { DeployKeysSection } from "../client/DeployKeysSection";
import type { OrgId } from "../client/types";
import { sectionLoader } from "./-section-loader";

const DeployKeysSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <DeployKeysSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/** `keys` tab — see `-section-loader.ts` for how its data is server-rendered. */
export const Route = createFileRoute("/_authed/orgs/$organizationId/keys")({
    component: DeployKeysSectionRoute,
    loader: sectionLoader(api.deploy_keys.list),
});
