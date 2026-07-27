import type { Preloaded } from "@lunora/client";

import type { OrgId } from "./types";

/**
 * The organization dashboard's tabs. Each is a real route under
 * `/orgs/$organizationId/…` — the id doubles as the URL segment, so this table is
 * both the nav bar and the command palette's "Go to" list. `to` is spelled out
 * per entry rather than templated so it stays a literal the router can type-check.
 *
 * Before the TanStack Start migration these were a `Tab` union switched by
 * `useState`; the ids are unchanged so the labels and ordering carry over.
 */
export const TABS = [
    { id: "projects", label: "Projects", to: "/orgs/$organizationId/projects" },
    { id: "members", label: "Members", to: "/orgs/$organizationId/members" },
    { id: "keys", label: "Deploy keys", to: "/orgs/$organizationId/keys" },
    { id: "secrets", label: "Secrets", to: "/orgs/$organizationId/secrets" },
    { id: "domains", label: "Domains", to: "/orgs/$organizationId/domains" },
    { id: "builds", label: "Builds", to: "/orgs/$organizationId/builds" },
    { id: "logs", label: "Logs", to: "/orgs/$organizationId/logs" },
    { id: "traces", label: "Traces", to: "/orgs/$organizationId/traces" },
    { id: "sessions", label: "Sessions", to: "/orgs/$organizationId/sessions" },
    { id: "metrics", label: "Metrics", to: "/orgs/$organizationId/metrics" },
    { id: "dashboards", label: "Dashboards", to: "/orgs/$organizationId/dashboards" },
    { id: "issues", label: "Issues", to: "/orgs/$organizationId/issues" },
    { id: "incidents", label: "Incidents", to: "/orgs/$organizationId/incidents" },
    { id: "uptime", label: "Uptime", to: "/orgs/$organizationId/uptime" },
    { id: "alerts", label: "Alerts", to: "/orgs/$organizationId/alerts" },
    { id: "invitations", label: "Invitations", to: "/orgs/$organizationId/invitations" },
    { id: "usage", label: "Usage", to: "/orgs/$organizationId/usage" },
    { id: "billing", label: "Billing", to: "/orgs/$organizationId/billing" },
    { id: "activity", label: "Activity", to: "/orgs/$organizationId/activity" },
] as const;

/**
 * What every dashboard section receives.
 *
 * `onOpenTab` is gone: cross-tab deep links are now plain router navigation
 * through {@link CrossTabLink}, which reads the org from the route params, so
 * nothing has to be threaded down. `focusTraceId` survives as the `?traceId=`
 * search param on the logs and traces routes — the same one-shot focus, but now
 * shareable as a URL.
 */
export interface SectionProps<T = unknown> {
    focusTraceId?: string;
    organizationId: OrgId;
    /** The section's primary query, resolved by its route loader on the edge. */
    preloaded: Preloaded<T>;
}
