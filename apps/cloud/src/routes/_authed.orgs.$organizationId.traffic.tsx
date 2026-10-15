import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { TrafficSection } from "../client/TrafficSection";
import type { OrgId } from "../client/types";

const TrafficRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();

    return <TrafficSection organizationId={organizationId as OrgId} />;
};

/**
 * `traffic` tab — loader-free, for the same reason as `metrics`. Its snapshot is
 * keyed on the time range and domain filter held in client state, so there is
 * nothing in the URL for a loader to resolve, and preloading a default window
 * would go stale the moment the picker moved.
 */
export const Route = createFileRoute("/_authed/orgs/$organizationId/traffic")({
    component: TrafficRoute,
});
