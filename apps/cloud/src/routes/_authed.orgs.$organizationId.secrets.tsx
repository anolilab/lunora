import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { SecretsSection } from "../client/SecretsSection";
import type { OrgId } from "../client/types";
import { sectionLoader } from "./-section-loader";

const SecretsSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { preloaded } = Route.useLoaderData();

    return <SecretsSection organizationId={organizationId as OrgId} preloaded={preloaded} />;
};

/** `secrets` tab — see `-section-loader.ts` for how its data is server-rendered. */
export const Route = createFileRoute("/_authed/orgs/$organizationId/secrets")({
    component: SecretsSectionRoute,
    loader: sectionLoader(api.projects.listByOrg),
});
