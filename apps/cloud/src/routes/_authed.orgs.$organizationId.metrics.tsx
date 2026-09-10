import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { MetricsSection } from "../client/MetricsSection";
import type { OrgId } from "../client/types";

const MetricsRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();

    return <MetricsSection organizationId={organizationId as OrgId} />;
};

/**
 * `metrics` tab — deliberately loader-free. The series is keyed on the time range
 * held in client state by `TimeRangePicker`, so there is nothing in the URL for a
 * loader to resolve; the section queries it live instead. Every other tab
 * server-renders its primary query.
 */
export const Route = createFileRoute("/_authed/orgs/$organizationId/metrics")({
    component: MetricsRoute,
});
