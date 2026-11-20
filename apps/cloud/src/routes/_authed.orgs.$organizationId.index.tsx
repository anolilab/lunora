import { createFileRoute, redirect } from "@tanstack/react-router";

/** Bare `/orgs/$organizationId` lands on Projects — the tab bar's first entry. */
export const Route = createFileRoute("/_authed/orgs/$organizationId/")({
    beforeLoad: ({ params }) => {
        throw redirect({ params, to: "/orgs/$organizationId/projects" });
    },
});
