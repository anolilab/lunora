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
    GithubIcon,
    Globe02Icon,
    Key01Icon,
    MailAdd01Icon,
    Notification03Icon,
    PackageIcon,
    PackageProcessIcon,
    Pulse01Icon,
    Route01Icon,
    SatelliteIcon,
    SquareLockPasswordIcon,
    UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import type { Preloaded } from "@lunora/client";
import { useLocation } from "@tanstack/react-router";

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
    { id: "integrations", label: "Integrations", to: "/orgs/$organizationId/integrations", group: "Deploy", icon: GithubIcon },
    { id: "members", label: "Members", to: "/orgs/$organizationId/members", group: "Team", icon: UserMultipleIcon },
    { id: "keys", label: "Deploy keys", to: "/orgs/$organizationId/keys", group: "Deploy", icon: Key01Icon },
    { id: "secrets", label: "Secrets", to: "/orgs/$organizationId/secrets", group: "Deploy", icon: SquareLockPasswordIcon },
    { id: "domains", label: "Domains", to: "/orgs/$organizationId/domains", group: "Deploy", icon: Globe02Icon },
    { id: "builds", label: "Builds", to: "/orgs/$organizationId/builds", group: "Deploy", icon: PackageProcessIcon },
    { id: "traffic", label: "Traffic", to: "/orgs/$organizationId/traffic", group: "Observability", icon: SatelliteIcon },
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
 * {@link TABS} bucketed by `group`, built in one pass. Both inputs are module
 * constants, so the sidebar reads a prepared bucket instead of re-filtering the
 * whole table once per group on every render.
 */
export const TABS_BY_GROUP: Readonly<Record<string, ReadonlyArray<(typeof TABS)[number]>>> = (() => {
    const groups: Record<string, (typeof TABS)[number][]> = {};

    for (const tab of TABS) {
        const bucket = groups[tab.group] ?? [];

        bucket.push(tab);
        groups[tab.group] = bucket;
    }

    return groups;
})();

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

/**
 * Every tab id, as a set, for turning a pathname back into a screen name.
 * Built from {@link TABS} so a new tab is analytics-visible the day it ships.
 */
const TAB_IDS = new Set<string>(TABS.map((tab) => tab.id));

/** The screens that are not org tabs. Anything else at the top level is not a screen we recognise. */
const TOP_LEVEL_SCREENS = new Set(["login"]);

/**
 * The analytics name for a pathname.
 *
 * An **allowlist**, deliberately: it returns a known tab id, a known top-level
 * screen, or the literal `"unknown"` — never a path segment it did not
 * recognise. The `/orgs/:organizationId` segment carries an id, and an unrecognised
 * segment on a route added later could be any id at all, so echoing the URL
 * back is how ids reach the event stream by accident. This way a route nobody
 * taught the table about shows up as an "unknown" bump to investigate rather
 * than as a thousand unique screen names.
 */
export const screenFor = (pathname: string): string => {
    const segments = pathname.split("/").filter(Boolean);

    if (segments.length === 0) {
        return "organizations";
    }

    const [first] = segments;

    if (first !== "orgs") {
        return TOP_LEVEL_SCREENS.has(first) ? first : "unknown";
    }

    // Two segments is the per-organization index route; three or more is a tab and its sub-routes.
    if (segments.length === 2) {
        return "overview";
    }

    const tab = segments[2] ?? "";

    return TAB_IDS.has(tab) ? tab : "unknown";
};

/** Matches the `/orgs/:organizationId` prefix. Static and linear — a literal prefix and one negated class, no backtracking. */
const ORG_PATH = /\/orgs\/[^/]+/u;

/**
 * Replace the organization id in a URL or path with its route parameter.
 *
 * PostHog attaches `$current_url` to every event whether or not we ask, and on
 * this app every URL embeds an organization id. Left alone that breaks the
 * product analytics before it breaks anything else: "Projects" is not one page
 * with a thousand views, it is a thousand pages with one view each, and the
 * Paths and trends views over them say nothing. Collapsing the id back to
 * `:organizationId` makes a screen a screen again — and keeps the id out of a
 * property we never chose to send.
 */
export const redactOrgPath = (value: string): string => value.replace(ORG_PATH, "/orgs/:organizationId");

/**
 * The current screen name, for tagging a product event with WHERE it happened.
 *
 * A hook rather than a prop threaded down: the components that report events —
 * {@link AsyncList}, the time-range picker, the form error line — are shared by
 * every tab and are several levels below the route, and adding a `screen` prop
 * to each would be a fourteen-file edit that the fifteenth caller forgets.
 * `select` narrows the subscription to the derived name, so a search-param
 * change does not re-render them.
 */
export const useScreen = (): string => useLocation({ select: (location) => screenFor(location.pathname) });
