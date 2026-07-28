import {
    Activity01Icon,
    AlertCircleIcon,
    AlertDiamondIcon,
    Analytics01Icon,
    Chart01Icon,
    Clock01Icon,
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

/**
 * The organization dashboard's tabs. Each `id` is also the URL segment under
 * `/orgs/$orgId/`, so this list is the single source for the sidebar nav, the
 * command palette's "Go to" entries, and the routes themselves. `group` places
 * each tab under a sidebar section ({@link TAB_GROUPS} fixes the section order);
 * `icon` is its sidebar glyph.
 */
export const TABS = [
    { group: "Deploy", icon: PackageIcon, id: "projects", label: "Projects" },
    { group: "Deploy", icon: Globe02Icon, id: "domains", label: "Domains" },
    { group: "Deploy", icon: Key01Icon, id: "keys", label: "Deploy keys" },
    { group: "Deploy", icon: SquareLockPasswordIcon, id: "secrets", label: "Secrets" },
    { group: "Deploy", icon: PackageProcessIcon, id: "builds", label: "Builds" },
    { group: "Observability", icon: File01Icon, id: "logs", label: "Logs" },
    { group: "Observability", icon: Route01Icon, id: "traces", label: "Traces" },
    { group: "Observability", icon: Chart01Icon, id: "metrics", label: "Metrics" },
    { group: "Observability", icon: Pulse01Icon, id: "uptime", label: "Uptime" },
    { group: "Observability", icon: Clock01Icon, id: "sessions", label: "Sessions" },
    { group: "Observability", icon: Analytics01Icon, id: "dashboards", label: "Dashboards" },
    { group: "Observability", icon: AlertCircleIcon, id: "issues", label: "Issues" },
    { group: "Observability", icon: AlertDiamondIcon, id: "incidents", label: "Incidents" },
    { group: "Observability", icon: Notification03Icon, id: "alerts", label: "Alerts" },
    { group: "Team", icon: UserMultipleIcon, id: "members", label: "Members" },
    { group: "Team", icon: MailAdd01Icon, id: "invitations", label: "Invitations" },
    { group: "Account", icon: Analytics01Icon, id: "usage", label: "Usage" },
    { group: "Account", icon: CreditCardIcon, id: "billing", label: "Billing" },
    { group: "Account", icon: Activity01Icon, id: "activity", label: "Activity" },
] as const satisfies ReadonlyArray<{ group: string; icon: typeof PackageIcon; id: string; label: string }>;

/** Sidebar section order (top to bottom). */
export const TAB_GROUPS = ["Deploy", "Observability", "Team", "Account"] as const;

export type Tab = (typeof TABS)[number]["id"];
