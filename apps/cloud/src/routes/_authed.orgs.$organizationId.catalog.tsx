import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { CatalogSection } from "../client/CatalogSection";
import type { OrgId } from "../client/types";

const CatalogSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();

    return <CatalogSection organizationId={organizationId as OrgId} />;
};

/** `catalog` tab. No server preload: the catalog and the install form are read client-side. */
export const Route = createFileRoute("/_authed/orgs/$organizationId/catalog")({
    component: CatalogSectionRoute,
});
