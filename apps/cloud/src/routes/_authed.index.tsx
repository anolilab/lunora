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
    // `Promise.all`, not two sequential awaits: the queries are independent, and on a
    // client navigation each `preload` is its own server-function round trip — so
    // serializing them made the page wait for one after the other.
    loader: async () => {
        const [cells, organizations] = await Promise.all([preload(api.cells.list, {}), preload(api.organizations.list, {})]);

        return { cells, organizations };
    },
});
