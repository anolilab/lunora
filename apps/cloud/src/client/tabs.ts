import {
    Activity01Icon,
    AlertCircleIcon,
    AlertDiamondIcon,
    Analytics01Icon,
    Chart01Icon,
    Clock01Icon,
    Coins01Icon,
    CreditCardIcon,
    File01Icon,
    Globe02Icon,
    Key01Icon,
    MailAdd01Icon,
    Notification03Icon,
    PackageIcon,
    PackageProcessIcon,
    Pulse01Icon,
    Route01Icon,
    SquareLockPasswordIcon,
    UserMultipleIcon,
} from "@hugeicons/core-free-icons";
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
    { id: "projects", label: "Projects", to: "/orgs/$organizationId/projects", group: "Deploy", icon: PackageIcon },
    { id: "members", label: "Members", to: "/orgs/$organizationId/members", group: "Team", icon: UserMultipleIcon },
    { id: "keys", label: "Deploy keys", to: "/orgs/$organizationId/keys", group: "Deploy", icon: Key01Icon },
    { id: "secrets", label: "Secrets", to: "/orgs/$organizationId/secrets", group: "Deploy", icon: SquareLockPasswordIcon },
    { id: "domains", label: "Domains", to: "/orgs/$organizationId/domains", group: "Deploy", icon: Globe02Icon },
    { id: "builds", label: "Builds", to: "/orgs/$organizationId/builds", group: "Deploy", icon: PackageProcessIcon },
    { id: "logs", label: "Logs", to: "/orgs/$organizationId/logs", group: "Observability", icon: File01Icon },
    { id: "traces", label: "Traces", to: "/orgs/$organizationId/traces", group: "Observability", icon: Route01Icon },
    { id: "sessions", label: "Sessions", to: "/orgs/$organizationId/sessions", group: "Observability", icon: Clock01Icon },
    { id: "metrics", label: "Metrics", to: "/orgs/$organizationId/metrics", group: "Observability", icon: Chart01Icon },
    { id: "dashboards", label: "Dashboards", to: "/orgs/$organizationId/dashboards", group: "Observability", icon: Analytics01Icon },
    { id: "issues", label: "Issues", to: "/orgs/$organizationId/issues", group: "Observability", icon: AlertCircleIcon },
    { id: "incidents", label: "Incidents", to: "/orgs/$organizationId/incidents", group: "Observability", icon: AlertDiamondIcon },
    { id: "uptime", label: "Uptime", to: "/orgs/$organizationId/uptime", group: "Observability", icon: Pulse01Icon },
    { id: "alerts", label: "Alerts", to: "/orgs/$organizationId/alerts", group: "Observability", icon: Notification03Icon },
    { id: "invitations", label: "Invitations", to: "/orgs/$organizationId/invitations", group: "Team", icon: MailAdd01Icon },
    { id: "usage", label: "Usage", to: "/orgs/$organizationId/usage", group: "Account", icon: Analytics01Icon },
    { id: "cloudflare-costs", label: "Cloudflare costs", to: "/orgs/$organizationId/cloudflare-costs", group: "Account", icon: Coins01Icon },
    { id: "billing", label: "Billing", to: "/orgs/$organizationId/billing", group: "Account", icon: CreditCardIcon },
    { id: "activity", label: "Activity", to: "/orgs/$organizationId/activity", group: "Account", icon: Activity01Icon },
] as const;

/** Sidebar section order (top to bottom), from the recovered design. */
export const TAB_GROUPS = ["Deploy", "Observability", "Team", "Account"] as const;

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
