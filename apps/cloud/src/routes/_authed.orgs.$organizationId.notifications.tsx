import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { NotificationsSection } from "../client/NotificationsSection";
import type { OrgId } from "../client/types";

const NotificationsSectionRoute = (): ReactElement => {
    const { organizationId } = Route.useParams();

    return <NotificationsSection organizationId={organizationId as OrgId} />;
};

/**
 * `notifications` tab. No server preload: the channel and delivery lists are
 * read client-side, and secrets never leave the server (see lunora/notifications.ts).
 */
export const Route = createFileRoute("/_authed/orgs/$organizationId/notifications")({
    component: NotificationsSectionRoute,
});
