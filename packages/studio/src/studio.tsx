import type { I18n } from "@lingui/core";
import {
    createBrowserHistory,
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    RouterProvider,
    useNavigate,
    useRouterState,
    useSearch,
} from "@tanstack/react-router";
import type { ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import ApiTab from "./api-tab";
import { AuditPanel } from "./audit-panel";
import type { CommandItem } from "./command-palette";
import { CommandPalette } from "./command-palette";
import { Skeleton } from "./components/ui/skeleton";
import DashboardsPanel from "./dashboards-panel";
import { DataBrowser } from "./data-browser";
import { ErrorBoundary } from "./error-boundary";
import { ExportImportPanel } from "./export-import";
import { FileBrowser } from "./file-browser";
import { FunctionRunner } from "./function-runner";
import { FunctionStatsPanel } from "./function-stats";
import { GlobalDataBrowser } from "./global-data-browser";
import { HealthPanel } from "./health-panel";
import { HomePanel } from "./home-panel";
import { useT } from "./i18n-context";
import { StudioI18nProvider } from "./i18n-provider";
import { InsightsPanel } from "./insights-panel";
import { fireAndForget } from "./internal";
import { LogsPanel } from "./logs-panel";
import { MetricsPanel } from "./metrics-panel";
import { MigrationsPanel } from "./migrations";
import { OrganizationsPanel } from "./organizations-panel";
import { PitrPanel } from "./pitr-panel";
import type { ScheduledJobsProps } from "./scheduled-jobs";
import { ScheduledJobs } from "./scheduled-jobs";
import { SchemaViewer } from "./schema-viewer";
import SecurityAdvisorPanel from "./security-advisor-panel";
import { SettingsPanel } from "./settings-panel";
import { SqlEditorPanel } from "./sql-editor-panel";
import SubscriptionsPanel from "./subscriptions-panel";
import type { FunctionDescriptor } from "./types";
import { UsersPanel } from "./users-panel";

/** Identifier for each built-in studio tab. */
type StudioTab =
    | "api"
    | "audit"
    | "dashboards"
    | "data"
    | "export"
    | "files"
    | "functions"
    | "globals"
    | "health"
    | "home"
    | "insights"
    | "logs"
    | "metrics"
    | "migrations"
    | "organizations"
    | "pitr"
    | "realtime"
    | "schedule"
    | "schema"
    | "security"
    | "settings"
    | "sql"
    | "users";

interface StudioProps {
    /**
     * URL path prefix the studio is mounted under, passed to the router as its
     * `basepath`. Defaults to `/` (mounted at the origin root). The `@cirrus/vite`
     * dev route serves the studio under `/__cirrus`, so it sets this — without
     * it the router treats `/__cirrus` as unknown and bounces to `/data`, escaping
     * the mount.
     */
    readonly basePath?: string;

    /**
     * Make the data tab editable (insert/edit/delete rows). Off by default so
     * the studio is read-only unless the host opts in; see {@link DataBrowser}.
     */
    readonly dataEditable?: boolean;

    /**
     * Functions exposed in the runner tab. The runner tab only appears when at
     * least one descriptor is supplied (a query/mutation/action's `kind` is
     * compile-time-only, so it must be named here).
     */
    readonly functions?: FunctionDescriptor[];

    /** Reuse an existing Lingui instance (wins over `locale`). */
    readonly i18n?: I18n;

    /** Shard key every shard-scoped panel targets on first load. */
    readonly initialShardKey?: string;

    /** Active locale for the studio's own UI strings. Defaults to `en`. */
    readonly locale?: string;

    /**
     * Inline OpenAPI 3.1 document rendered by the API tab's reference (Scalar)
     * sub-view. Thread the generated `_generated/openapi.json` here to render it
     * without a round-trip. When omitted the reference fetches the worker's
     * admin-gated `GET /_cirrus/admin/openapi` endpoint via the client.
     */
    readonly openApiSpec?: unknown;

    /**
     * Inline OpenRPC 1.x document rendered by the API tab's reference sub-view
     * when the OpenRPC format is selected. Thread the generated
     * `_generated/openrpc.json` here to render it without a round-trip. When
     * omitted the OpenRPC view fetches the worker's admin-gated
     * `GET /_cirrus/admin/openrpc` endpoint via the client.
     */
    readonly openRpcSpec?: unknown;

    /**
     * Override how the schedule tab cancels a job. Defaults to the client's
     * scheduler admin endpoint; see {@link ScheduledJobs}.
     */
    readonly scheduledCancel?: ScheduledJobsProps["cancelJob"];

    /**
     * Override how the schedule tab loads jobs. Defaults to the client's
     * scheduler admin endpoint, so the tab works without extra wiring.
     */
    readonly scheduledLoad?: ScheduledJobsProps["loadJobs"];
}

/** Props the inner shell renders with — everything except the i18n wiring. */
type StudioShellProps = Omit<StudioProps, "i18n" | "locale">;

/**
 * Stable identifier for each icon-rail domain; the display label is localised.
 * Mirrors the Supabase-Studio section model (Home · Table editor · SQL · Database
 * · Auth · Storage · Reports · Advisors · Logs · Settings), the target IA in
 * `STUDIO-REDESIGN-PLAN.md` §2.
 */
type NavGroupKey = "advisors" | "auth" | "database" | "home" | "logs" | "reports" | "settings" | "sql" | "storage" | "tableEditor";

/**
 * 16px line glyphs (drawn at a 24-unit grid) keyed by tab. Inline so the
 * studio ships no icon-font/asset dependency; they inherit `currentColor`
 * from the active/hover nav state in the scoped stylesheet.
 */
const TAB_ICONS: Record<StudioTab, ReactNode> = {
    api: <path d="m9 8-4 4 4 4m6-8 4 4-4 4M13 5l-2 14" />,
    audit: <path d="M7 4h7l4 4v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm6 0v5h5M9 13h6M9 16h6M9 10h2" />,
    dashboards: <path d="M4 5h7v6H4V5Zm9 0h7v4h-7V5ZM4 14h7v5H4v-5Zm9-1h7v6h-7v-6Z" />,
    data: (
        <path d="M5 6c0-1.4 3.1-2.5 7-2.5s7 1.1 7 2.5-3.1 2.5-7 2.5S5 7.4 5 6Zm0 0v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
    ),
    export: <path d="M12 3v11m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />,
    files: <path d="M4 7a2 2 0 0 1 2-2h3l2 2.5h7a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" />,
    functions: <path d="m9 8-4 4 4 4m6-8 4 4-4 4" />,
    globals: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 0c2.5-2 3.8-5.3 3.8-9S14.5 5 12 3M12 21c-2.5-2-3.8-5.3-3.8-9S9.5 5 12 3M3.5 9h17M3.5 15h17" />,
    health: <path d="M3 12h4l2 6 4-14 2 8h6" />,
    home: <path d="M3 11.5 12 4l9 7.5M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" />,
    insights: <path d="M12 3a6 6 0 0 0-3.6 10.8c.5.4.8.9.9 1.5l.2 1.2h5l.2-1.2c.1-.6.4-1.1.9-1.5A6 6 0 0 0 12 3ZM9.5 20.5h5M10 18h4" />,
    logs: <path d="M5 6h14M5 10h14M5 14h9M5 18h11" />,
    metrics: <path d="M5 20V10m6.5 10V4M18 20v-7M3 20h18" />,
    migrations: <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.6L4 16m0 4v-4h4" />,
    organizations: <path d="M3 21V8l6-4 6 4v13M9 21v-5h2v5M15 11h6v10M18 14v.01M18 17v.01M6 9v.01M6 12v.01M6 15v.01" />,
    pitr: <path d="M12 21a9 9 0 1 0-9-9M12 7.5V12l3 2M3 12l-2-2m2 2 2-2" />,
    realtime: <path d="M5 12a7 7 0 0 1 14 0M8 12a4 4 0 0 1 8 0M12 12v8m0-8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />,
    schedule: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.5V12l4 2" />,
    schema: <path d="M4 5h16v14H4V5Zm0 5h16M10 10v9M4 14.5h16" />,
    sql: <path d="M4 5h16v14H4V5Zm3 4 3 3-3 3m6 0h4" />,
    security: <path d="M12 3 5 6v5c0 4.5 3 7.8 7 9 4-1.2 7-4.5 7-9V6l-7-3Zm-2.5 8.5 2 2 4-4" />,
    settings: (
        <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.3 7.3 0 0 0-2-1.2l-.4-2.6H10.5l-.4 2.6a7.3 7.3 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.3 7.3 0 0 0 2 1.2l.4 2.6h3.6l.4-2.6a7.3 7.3 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6a7.4 7.4 0 0 0 .1-1.2Z" />
    ),
    users: (
        <path d="M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm11.5 10v-2a4 4 0 0 0-3-3.85M16 3.13A4 4 0 0 1 16 11" />
    ),
};

/** One icon-rail domain and the sub-pages its secondary nav lists. */
type NavGroup = { readonly key: NavGroupKey; readonly tabs: ReadonlyArray<StudioTab> };

/**
 * Icon-rail domains, top to bottom, each owning the sub-pages its secondary nav
 * lists — the two-level Supabase model (`STUDIO-REDESIGN-PLAN.md` §2). `settings`
 * pins to the bottom of the rail (see {@link StudioLayout}). Typed as a non-empty
 * tuple so the first domain is a guaranteed fallback for the active-domain lookup.
 */
const NAV_GROUPS: readonly [NavGroup, ...NavGroup[]] = [
    { key: "home", tabs: ["home"] },
    { key: "tableEditor", tabs: ["data", "globals"] },
    { key: "sql", tabs: ["sql", "functions", "api"] },
    { key: "database", tabs: ["schema", "migrations", "export", "pitr"] },
    { key: "auth", tabs: ["users", "organizations"] },
    { key: "storage", tabs: ["files"] },
    { key: "reports", tabs: ["dashboards", "metrics", "health"] },
    { key: "advisors", tabs: ["security", "insights"] },
    { key: "logs", tabs: ["logs", "audit", "schedule", "realtime"] },
    { key: "settings", tabs: ["settings"] },
];

/**
 * Which tab's glyph represents each rail domain. The rail shows one icon per
 * domain (Supabase-style); the secondary nav shows a glyph per sub-page. Most
 * domains borrow their first sub-page's icon; `database` uses the schema glyph so
 * it reads distinct from the Table-editor cylinder.
 */
const GROUP_ICON_TAB: Record<NavGroupKey, StudioTab> = {
    advisors: "security",
    auth: "users",
    database: "schema",
    home: "home",
    logs: "logs",
    reports: "metrics",
    settings: "settings",
    sql: "functions",
    storage: "files",
    tableEditor: "data",
};

const TabIcon = ({ tab }: { readonly tab: StudioTab }): ReactElement => (
    <svg
        aria-hidden="true"
        className="size-4 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.6}
        viewBox="0 0 24 24"
    >
        {TAB_ICONS[tab]}
    </svg>
);

/** Flat list of every tab, in sidebar order; drives the route table. */
const TABS = [
    "home",
    "data",
    "globals",
    "sql",
    "functions",
    "api",
    "schema",
    "migrations",
    "export",
    "pitr",
    "users",
    "organizations",
    "files",
    "dashboards",
    "metrics",
    "health",
    "security",
    "insights",
    "logs",
    "realtime",
    "audit",
    "schedule",
    "settings",
] as const;

/**
 * Tabs that own the full panel height (a flush full-height table/query sidebar +
 * an internally-scrolling grid), rather than the default top-aligned, page-scrolled
 * content. The Table editor and SQL editor render as full-height database consoles.
 */
const FULL_HEIGHT_TABS = new Set<StudioTab>(["data", "globals", "sql"]);

/** Resolve the active tab from a router pathname (`/logs` → `logs`); unknown paths fall back to `home`. */
const tabFromPathname = (pathname: string): StudioTab => {
    // Use the last non-empty segment so this holds whether or not the router's
    // pathname still carries a basepath prefix (`/__cirrus/logs` → `logs`).
    const slug = pathname.split("/").findLast(Boolean) ?? "";

    return (TABS as ReadonlyArray<string>).includes(slug) ? (slug as StudioTab) : "home";
};

/**
 * Persistent shell rendered by the router's root route: the top-level grid with
 * the grouped sidebar (a tablist whose buttons navigate) and the routed panel
 * area (`&lt;Outlet />`). The active tab is derived from the URL, so deep links and
 * the browser back/forward buttons drive which panel shows.
 */
const StudioLayout = (): ReactElement => {
    const t = useT();
    const navigate = useNavigate();
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const current = tabFromPathname(pathname);
    const fullHeight = FULL_HEIGHT_TABS.has(current);

    // Memoised on `t` (stable per locale) so the maps re-localise when the active
    // locale changes but aren't rebuilt on every unrelated render.
    const tabLabel = useMemo<Record<StudioTab, string>>(() => {
        return {
            api: t("API"),
            audit: t("Audit"),
            dashboards: t("Dashboards"),
            data: t("Data"),
            export: t("Export / Import"),
            files: t("Files"),
            functions: t("Functions"),
            globals: t("Global Tables"),
            health: t("Health"),
            home: t("Home"),
            insights: t("Performance"),
            logs: t("Logs"),
            metrics: t("Metrics"),
            migrations: t("Migrations"),
            organizations: t("Organizations"),
            pitr: t("Time Travel"),
            realtime: t("Realtime"),
            schedule: t("Scheduled"),
            schema: t("Schema"),
            security: t("Security"),
            settings: t("Settings"),
            sql: t("SQL editor"),
            users: t("Users"),
        };
    }, [t]);

    const groupLabel = useMemo<Record<NavGroupKey, string>>(() => {
        return {
            advisors: t("Advisors"),
            auth: t("Auth"),
            database: t("Database"),
            home: t("Home"),
            logs: t("Logs"),
            reports: t("Reports"),
            settings: t("Settings"),
            sql: t("SQL / Functions"),
            storage: t("Storage"),
            tableEditor: t("Table editor"),
        };
    }, [t]);

    // One-line section descriptions for the page header.
    const tabDescription = useMemo<Record<StudioTab, string>>(() => {
        return {
            api: t("Interactive OpenAPI reference and copy-paste snippets for your functions."),
            audit: t("A durable log of admin state-changing operations."),
            dashboards: t("Chart widgets backed by saved read-only SQL queries."),
            data: t("Browse and edit rows in your shard tables."),
            export: t("Export a shard to NDJSON, or import rows from it."),
            files: t("Browse objects in your R2 storage buckets."),
            functions: t("Run registered queries, mutations, and actions."),
            globals: t("Read-only view of your global D1 tables."),
            health: t("At-a-glance connection, error, and shard signals."),
            home: t("Connection, health, and advisor summary for your deployment."),
            insights: t("Surface slow functions, error spikes, and cache problems."),
            logs: t("A live stream of recent function logs."),
            metrics: t("Per-shard health and aggregate metrics."),
            migrations: t("Review migration status and run them."),
            organizations: t("Browse and manage organizations, members, and invitations."),
            pitr: t("Restore a shard to a point in the last 30 days."),
            realtime: t("Active WebSocket subscriptions on this shard."),
            schedule: t("Inspect and cancel scheduled jobs."),
            schema: t("Inspect each table and its columns."),
            security: t("Review admin gates, credentials, and log redaction."),
            settings: t("Read-only deployment config — vars, secrets, and bindings."),
            sql: t("Run read-only SQL against a shard."),
            users: t("Manage auth users — roles, bans, sessions, and identity."),
        };
    }, [t]);

    const selectTab = useCallback(
        (event: React.MouseEvent<HTMLButtonElement>): void => {
            fireAndForget(navigate({ to: `/${event.currentTarget.dataset.tab ?? ""}` }));
        },
        [navigate],
    );

    // Reflect the active section in the tab title — this is a hostable, routed
    // studio, so each deep-linked panel gets its own document title.
    useEffect(() => {
        if (typeof document !== "undefined") {
            document.title = `${tabLabel[current]} · cirrus`;
        }
    }, [current, tabLabel]);

    // The active rail area is the domain owning the current tab; the secondary
    // nav lists that domain's sub-pages. Selecting a rail icon jumps to the
    // domain's first sub-page. This is the two-zone console (48px icon rail +
    // contextual nav) of `STUDIO-REDESIGN-PLAN.md` §2, modelled on Supabase Studio.
    // `current` always belongs to a group, but `.find` is typed as possibly
    // undefined; fall back to the first domain (defined by the non-empty tuple
    // type) so the shell always has an active area.
    const activeGroup = NAV_GROUPS.find((group) => group.tabs.includes(current)) ?? NAV_GROUPS[0];

    const selectGroup = useCallback(
        (event: React.MouseEvent<HTMLButtonElement>): void => {
            fireAndForget(navigate({ to: `/${event.currentTarget.dataset.tab ?? ""}` }));
        },
        [navigate],
    );

    // Every navigable destination, in rail order, for the ⌘K command palette.
    const commandItems = useMemo<CommandItem[]>(
        () =>
            NAV_GROUPS.flatMap((group) =>
                group.tabs.map((tab) => {
                    return { group: groupLabel[group.key], label: tabLabel[tab], to: `/${tab}` };
                }),
            ),
        [groupLabel, tabLabel],
    );

    // Collapse the 250px secondary nav to just the icon rail (Supabase's bottom
    // rail toggle). In-memory — a fresh session starts expanded.
    const [navCollapsed, setNavCollapsed] = useState<boolean>(false);
    const toggleNav = useCallback((): void => {
        setNavCollapsed((collapsed) => !collapsed);
    }, []);

    return (
        <div
            className={`grid min-h-0 flex-1 ${navCollapsed ? "grid-cols-[3rem_minmax(0,1fr)]" : "grid-cols-[3rem_13.5rem_minmax(0,1fr)]"}`}
            data-testid="cirrus-studio"
        >
            <CommandPalette items={commandItems} />
            {/* Icon rail — one entry per area, settings pinned to the bottom. */}
            <nav aria-label={t("Studio areas")} className="flex flex-col items-center gap-1 border-e border-border bg-sidebar py-2" data-testid="dash-rail">
                {NAV_GROUPS.map((group) => {
                    // The rail icon routes to the group's first sub-page; its glyph
                    // is the domain icon (Supabase-style), not necessarily that page's.
                    const railTab = group.tabs[0] as StudioTab;

                    return (
                        <button
                            aria-current={activeGroup.key === group.key ? "page" : undefined}
                            aria-label={groupLabel[group.key]}
                            className={`flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-foreground${group.key === "settings" ? " mt-auto" : ""}`}
                            data-tab={railTab}
                            data-testid={`dash-rail-${group.key}`}
                            key={group.key}
                            onClick={selectGroup}
                            title={groupLabel[group.key]}
                            type="button"
                        >
                            <TabIcon tab={GROUP_ICON_TAB[group.key]} />
                        </button>
                    );
                })}

                {/* Collapse/expand the secondary nav — Supabase's bottom rail toggle. */}
                <button
                    aria-label={navCollapsed ? t("Expand sidebar") : t("Collapse sidebar")}
                    aria-pressed={navCollapsed}
                    className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent"
                    data-testid="dash-rail-toggle"
                    onClick={toggleNav}
                    title={navCollapsed ? t("Expand sidebar") : t("Collapse sidebar")}
                    type="button"
                >
                    <svg
                        aria-hidden="true"
                        className={`size-4 transition-transform ${navCollapsed ? "rotate-180" : ""}`}
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.6}
                        viewBox="0 0 24 24"
                    >
                        <path d="M15 6 9 12l6 6" />
                    </svg>
                </button>
            </nav>

            {/* Secondary nav — the active area's title + its tabs. Hidden when collapsed. */}
            <div
                aria-label={t("Studio sections")}
                className={`flex flex-col overflow-y-auto border-e border-border bg-sidebar${navCollapsed ? " hidden" : ""}`}
                data-testid="dash-tabs"
                hidden={navCollapsed}
                role="tablist"
            >
                <header className="flex h-12 shrink-0 items-center px-4">
                    <h2 className="text-[15px] font-semibold tracking-tight text-foreground">{groupLabel[activeGroup.key]}</h2>
                </header>
                <div className="flex flex-col gap-px px-2 pb-3">
                    {activeGroup.tabs.map((tab) => (
                        <button
                            aria-selected={current === tab}
                            className="relative flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-start text-[13px] text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground aria-selected:bg-sidebar-accent aria-selected:font-medium aria-selected:text-sidebar-accent-foreground [&_svg]:opacity-70 aria-selected:[&_svg]:opacity-100"
                            data-tab={tab}
                            data-testid={`dash-tab-${tab}`}
                            key={tab}
                            onClick={selectTab}
                            role="tab"
                            type="button"
                        >
                            <TabIcon tab={tab} />
                            {tabLabel[tab]}
                        </button>
                    ))}
                </div>
            </div>

            <div className="flex min-w-0 flex-col overflow-hidden bg-background" data-testid="dash-panel" role="tabpanel">
                {/* Page header per section — a Studio-style title bar. */}
                <header className="flex shrink-0 flex-col gap-0.5 border-b border-border px-6 py-4">
                    <h1 className="text-lg font-semibold tracking-tight text-foreground">{tabLabel[current]}</h1>
                    <p className="text-sm text-muted-foreground">{tabDescription[current]}</p>
                </header>
                {/* Key the boundary by tab so one panel throwing doesn't blank the
                    shell, and switching tabs clears a prior panel's error. Full-height
                    tabs (Table/SQL editor) own the height and scroll internally; the
                    rest get the default padded, page-scrolled content area. */}
                <div className={fullHeight ? "flex min-w-0 flex-1 flex-col overflow-hidden" : "min-w-0 flex-1 overflow-auto p-6"}>
                    <ErrorBoundary
                        fallbackTitle={t("{title} failed", { title: tabLabel[current] })}
                        key={current}
                        label={tabLabel[current]}
                        retryLabel={t("Try again")}
                    >
                        <Outlet />
                    </ErrorBoundary>
                </div>
            </div>
        </div>
    );
};

/**
 * Skeleton shown while a route resolves — the brief first paint after mount and
 * any future panel with a router loader — so the content area never flashes
 * empty. Renders inside the layout's panel region during navigation.
 */
const RoutePending = (): ReactElement => (
    <div className="space-y-4" data-testid="dash-pending">
        <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-8 w-24" />
        </div>
        <Skeleton className="h-72 w-full" />
    </div>
);

/**
 * Schema tab wrapper that lifts the optional `?table=&lt;name>` search param off
 * the URL and forwards it to {@link SchemaViewer} as `initialTable`. This is the
 * landing target of the Insights "add the index" deep-link: navigating to
 * `/schema?table=posts` auto-expands `posts`'s index list. Read with
 * `strict: false` because the generic tab routes don't declare a typed search
 * schema; the param is coerced to a string or dropped.
 */
const SchemaRoutePanel = ({ initialShardKey }: { readonly initialShardKey?: string }): ReactElement => {
    const search: Record<string, unknown> = useSearch({ strict: false });
    const { table } = search;
    const initialTable = typeof table === "string" ? table : undefined;

    return <SchemaViewer initialShardKey={initialShardKey} initialTable={initialTable} />;
};

/** Sends unknown paths back to the Home overview. */
const NotFoundRedirect = (): null => {
    const navigate = useNavigate();

    useEffect(() => {
        fireAndForget(navigate({ replace: true, to: "/home" }));
    }, [navigate]);

    return null;
};

/**
 * Builds a self-contained TanStack Router whose root route renders
 * {@link StudioLayout} and whose child routes render one panel each. Path
 * routing (`/data`, `/logs`, …) over the browser History API makes every tab a
 * real, shareable URL with working back/forward; a memory history is used when
 * there's no DOM (SSR). The panels close over the shell props, so the router is
 * rebuilt only when those change.
 */
const buildRouter = ({
    basePath,
    dataEditable = false,
    functions,
    initialShardKey,
    openApiSpec,
    openRpcSpec,
    scheduledCancel,
    scheduledLoad,
}: StudioShellProps) => {
    const rootRoute = createRootRoute({ component: StudioLayout });

    const panels: Record<StudioTab, ReactElement> = {
        api: <ApiTab functions={functions} initialShardKey={initialShardKey} openApiSpec={openApiSpec} openRpcSpec={openRpcSpec} />,
        audit: <AuditPanel initialShardKey={initialShardKey} />,
        dashboards: <DashboardsPanel initialShardKey={initialShardKey} />,
        data: <DataBrowser editable={dataEditable} initialShardKey={initialShardKey} />,
        export: <ExportImportPanel initialShardKey={initialShardKey} />,
        files: <FileBrowser />,
        functions: (
            <div className="space-y-8">
                <FunctionStatsPanel functions={functions} initialShardKey={initialShardKey} />
                <FunctionRunner functions={functions} />
            </div>
        ),
        globals: <GlobalDataBrowser />,
        health: <HealthPanel initialShardKey={initialShardKey} />,
        home: <HomePanel initialShardKey={initialShardKey} />,
        insights: <InsightsPanel initialShardKey={initialShardKey} />,
        logs: <LogsPanel initialShardKey={initialShardKey} />,
        metrics: <MetricsPanel initialShardKey={initialShardKey} />,
        migrations: <MigrationsPanel initialShardKey={initialShardKey} />,
        organizations: <OrganizationsPanel />,
        pitr: <PitrPanel initialShardKey={initialShardKey} />,
        realtime: <SubscriptionsPanel initialShardKey={initialShardKey} />,
        schedule: <ScheduledJobs cancelJob={scheduledCancel} loadJobs={scheduledLoad} />,
        schema: <SchemaRoutePanel initialShardKey={initialShardKey} />,
        security: <SecurityAdvisorPanel />,
        settings: <SettingsPanel initialShardKey={initialShardKey} />,
        sql: <SqlEditorPanel initialShardKey={initialShardKey} />,
        users: <UsersPanel />,
    };

    // `/` renders the Home overview directly (no async redirect, so the first
    // paint is synchronous); `/home` renders it too, so both URLs are valid.
    const indexRoute = createRoute({
        component: () => panels.home,
        getParentRoute: () => rootRoute,
        path: "/",
    });

    const tabRoutes = TABS.map((tab) =>
        createRoute({
            component: () => panels[tab],
            getParentRoute: () => rootRoute,
            path: `/${tab}`,
        }),
    );

    const routeTree = rootRoute.addChildren([indexRoute, ...tabRoutes]);
    // Browser when a DOM `window` exists; an in-memory history under SSR/tests.
    // `"window" in globalThis` sidesteps both the typeof-undefined and the
    // always-defined-type lints that a `=== undefined` check trips.
    const history = "window" in globalThis ? createBrowserHistory() : createMemoryHistory({ initialEntries: ["/home"] });

    return createRouter({
        // When mounted under a prefix (e.g. the `/__cirrus` dev route), the router
        // works in that subtree: `/__cirrus` matches the index route and every
        // `navigate({ to: "/logs" })` resolves to `/__cirrus/logs`, so navigation
        // never escapes the mount. Omitted for a root mount.
        ...(basePath === undefined || basePath === "/" ? {} : { basepath: basePath }),
        defaultNotFoundComponent: NotFoundRedirect,
        defaultPendingComponent: RoutePending,
        defaultPendingMinMs: 0,
        defaultPendingMs: 0,
        history,
        routeTree,
    });
};

/**
 * Inner shell: owns the router instance and renders it. The router is rebuilt
 * only when a panel-affecting prop changes (not on the unstable `props` object),
 * so navigation state survives unrelated re-renders.
 */
const StudioShell = ({
    basePath,
    dataEditable,
    functions,
    initialShardKey,
    openApiSpec,
    openRpcSpec,
    scheduledCancel,
    scheduledLoad,
}: StudioShellProps): ReactElement => {
    // Rebuild the router only when a panel-affecting prop changes (keyed on the
    // individual props, not the unstable `props` identity), so navigation state
    // survives unrelated re-renders.
    const router = useMemo(
        () => buildRouter({ basePath, dataEditable, functions, initialShardKey, openApiSpec, openRpcSpec, scheduledCancel, scheduledLoad }),
        [basePath, dataEditable, functions, initialShardKey, openApiSpec, openRpcSpec, scheduledCancel, scheduledLoad],
    );

    return <RouterProvider router={router} />;
};

/**
 * The composable studio. {@link StudioShell} reads its strings from `useT`,
 * which needs a `StudioI18nProvider` above it.
 *
 * When an `i18n` instance or a `locale` is supplied, this owns a provider so the
 * studio localises itself standalone. When neither is given it renders the
 * shell bare and inherits whatever provider is already in scope — the host app's
 * (`StudioApp` owns one for the top bar too) or the shared default — instead
 * of nesting a second, redundant provider.
 */
export const Studio = ({
    basePath,
    dataEditable,
    functions,
    i18n,
    initialShardKey,
    locale,
    openApiSpec,
    openRpcSpec,
    scheduledCancel,
    scheduledLoad,
}: StudioProps): ReactElement => {
    const shell = (
        <StudioShell
            basePath={basePath}
            dataEditable={dataEditable}
            functions={functions}
            initialShardKey={initialShardKey}
            openApiSpec={openApiSpec}
            openRpcSpec={openRpcSpec}
            scheduledCancel={scheduledCancel}
            scheduledLoad={scheduledLoad}
        />
    );

    if (i18n === undefined && locale === undefined) {
        return shell;
    }

    return (
        <StudioI18nProvider i18n={i18n} locale={locale}>
            {shell}
        </StudioI18nProvider>
    );
};

export type { StudioProps, StudioTab };
