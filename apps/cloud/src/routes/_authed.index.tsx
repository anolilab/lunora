import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { OrganizationList } from "../client/OrganizationList";
import { preload } from "../ssr/loader";

const OrganizationsPage = (): ReactElement => {
    const { cells, organizations } = Route.useLoaderData();
    const navigate = useNavigate();

    return (
        <OrganizationList
            onSelect={(organizationId) => {
                void navigate({ params: { organizationId }, to: "/orgs/$organizationId" });
            }}
            preloadedCells={cells}
            preloadedOrganizations={organizations}
        />
    );
};

/**
 * Organization picker — the signed-in landing page. Both queries it renders are
 * resolved on the edge, so the list arrives in the first byte instead of after a
 * WebSocket round trip.
 */
export const Route = createFileRoute("/_authed/")({
    component: OrganizationsPage,
    loader: async () => {
        return {
            cells: await preload(api.cells.list, {}),
            organizations: await preload(api.organizations.list, {}),
        };
    },
});
