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
} from "@tanstack/react-router";
import type { ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useMemo } from "react";

import { Skeleton } from "./components/ui/skeleton.js";
import { DataBrowser } from "./data-browser.js";
import { ErrorBoundary } from "./error-boundary.js";
import { ExportImportPanel } from "./export-import.js";
import { FileBrowser } from "./file-browser.js";
import { FunctionRunner } from "./function-runner.js";
import { FunctionStatsPanel } from "./function-stats.js";
import { GlobalDataBrowser } from "./global-data-browser.js";
import { HealthPanel } from "./health-panel.js";
import { useT } from "./i18n-context.js";
import { DashboardI18nProvider } from "./i18n-provider.js";
import { fireAndForget } from "./internal.js";
import { LogsPanel } from "./logs-panel.js";
import { MetricsPanel } from "./metrics-panel.js";
import { MigrationsPanel } from "./migrations.js";
import type { ScheduledJobsProps } from "./scheduled-jobs.js";
import { ScheduledJobs } from "./scheduled-jobs.js";
import { SchemaViewer } from "./schema-viewer.js";
import type { FunctionDescriptor } from "./types.js";
import { UsersPanel } from "./users-panel.js";

/** Identifier for each built-in dashboard tab. */
type DashboardTab = "data" | "export" | "files" | "functions" | "globals" | "health" | "logs" | "metrics" | "migrations" | "schedule" | "schema" | "users";

interface DashboardProps {
    /**
     * URL path prefix the dashboard is mounted under, passed to the router as its
     * `basepath`. Defaults to `/` (mounted at the origin root). The `@cirrus/vite`
     * dev route serves the dashboard under `/__cirrus`, so it sets this — without
     * it the router treats `/__cirrus` as unknown and bounces to `/data`, escaping
     * the mount.
     */
    readonly basePath?: string;

    /**
     * Make the data tab editable (insert/edit/delete rows). Off by default so
     * the dashboard is read-only unless the host opts in; see {@link DataBrowser}.
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

    /** Active locale for the dashboard's own UI strings. Defaults to `en`. */
    readonly locale?: string;

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
type DashboardShellProps = Omit<DashboardProps, "i18n" | "locale">;

/** Stable identifier for each sidebar section; the display label is localised. */
type NavGroupKey = "auth" | "database" | "logic" | "observability" | "storage";

/**
 * 16px line glyphs (drawn at a 24-unit grid) keyed by tab. Inline so the
 * dashboard ships no icon-font/asset dependency; they inherit `currentColor`
 * from the active/hover nav state in the scoped stylesheet.
 */
const TAB_ICONS: Record<DashboardTab, ReactNode> = {
    data: (
        <path d="M5 6c0-1.4 3.1-2.5 7-2.5s7 1.1 7 2.5-3.1 2.5-7 2.5S5 7.4 5 6Zm0 0v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
    ),
    export: <path d="M12 3v11m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />,
    files: <path d="M4 7a2 2 0 0 1 2-2h3l2 2.5h7a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" />,
    functions: <path d="m9 8-4 4 4 4m6-8 4 4-4 4" />,
    globals: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 0c2.5-2 3.8-5.3 3.8-9S14.5 5 12 3M12 21c-2.5-2-3.8-5.3-3.8-9S9.5 5 12 3M3.5 9h17M3.5 15h17" />,
    health: <path d="M3 12h4l2 6 4-14 2 8h6" />,
    logs: <path d="M5 6h14M5 10h14M5 14h9M5 18h11" />,
    metrics: <path d="M5 20V10m6.5 10V4M18 20v-7M3 20h18" />,
    migrations: <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.6L4 16m0 4v-4h4" />,
    schedule: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.5V12l4 2" />,
    schema: <path d="M4 5h16v14H4V5Zm0 5h16M10 10v9M4 14.5h16" />,
    users: (
        <path d="M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm11.5 10v-2a4 4 0 0 0-3-3.85M16 3.13A4 4 0 0 1 16 11" />
    ),
};

/** Sidebar sections — grouped like a studio console, top to bottom. */
const NAV_GROUPS: ReadonlyArray<{ readonly key: NavGroupKey; readonly tabs: ReadonlyArray<DashboardTab> }> = [
    { key: "database", tabs: ["data", "globals", "schema"] },
    { key: "logic", tabs: ["functions", "migrations", "schedule"] },
    { key: "storage", tabs: ["files", "export"] },
    { key: "auth", tabs: ["users"] },
    { key: "observability", tabs: ["health", "metrics", "logs"] },
];

const TabIcon = ({ tab }: { readonly tab: DashboardTab }): ReactElement => (
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
const TABS = ["data", "globals", "schema", "functions", "migrations", "export", "files", "schedule", "users", "health", "metrics", "logs"] as const;

/** Resolve the active tab from a router pathname (`/logs` → `logs`); unknown paths fall back to `data`. */
const tabFromPathname = (pathname: string): DashboardTab => {
    // Use the last non-empty segment so this holds whether or not the router's
    // pathname still carries a basepath prefix (`/__cirrus/logs` → `logs`).
    const slug = pathname.split("/").findLast(Boolean) ?? "";

    return (TABS as ReadonlyArray<string>).includes(slug) ? (slug as DashboardTab) : "data";
};

/**
 * Persistent shell rendered by the router's root route: the top-level grid with
 * the grouped sidebar (a tablist whose buttons navigate) and the routed panel
 * area (`&lt;Outlet />`). The active tab is derived from the URL, so deep links and
 * the browser back/forward buttons drive which panel shows.
 */
const DashboardLayout = (): ReactElement => {
    const t = useT();
    const navigate = useNavigate();
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const current = tabFromPathname(pathname);

    // Memoised on `t` (stable per locale) so the maps re-localise when the active
    // locale changes but aren't rebuilt on every unrelated render.
    const tabLabel = useMemo<Record<DashboardTab, string>>(() => {
        return {
            data: t("Data"),
            export: t("Export / Import"),
            files: t("Files"),
            functions: t("Functions"),
            globals: t("Global Tables"),
            health: t("Health"),
            logs: t("Logs"),
            metrics: t("Metrics"),
            migrations: t("Migrations"),
            schedule: t("Scheduled"),
            schema: t("Schema"),
            users: t("Users"),
        };
    }, [t]);

    const groupLabel = useMemo<Record<NavGroupKey, string>>(() => {
        return {
            auth: t("Auth"),
            database: t("Database"),
            logic: t("Logic"),
            observability: t("Observability"),
            storage: t("Storage"),
        };
    }, [t]);

    // One-line section descriptions for the page header.
    const tabDescription = useMemo<Record<DashboardTab, string>>(() => {
        return {
            data: t("Browse and edit rows in your shard tables."),
            export: t("Export a shard to NDJSON, or import rows from it."),
            files: t("Browse objects in your R2 storage buckets."),
            functions: t("Run registered queries, mutations, and actions."),
            globals: t("Read-only view of your global D1 tables."),
            health: t("At-a-glance connection, error, and shard signals."),
            logs: t("A live stream of recent function logs."),
            metrics: t("Per-shard health and aggregate metrics."),
            migrations: t("Review migration status and run them."),
            schedule: t("Inspect and cancel scheduled jobs."),
            schema: t("Inspect each table and its columns."),
            users: t("Browse auth users and their active sessions."),
        };
    }, [t]);

    const selectTab = useCallback(
        (event: React.MouseEvent<HTMLButtonElement>): void => {
            fireAndForget(navigate({ to: `/${event.currentTarget.dataset.tab ?? ""}` }));
        },
        [navigate],
    );

    // Reflect the active section in the tab title — this is a hostable, routed
    // dashboard, so each deep-linked panel gets its own document title.
    useEffect(() => {
        if (typeof document !== "undefined") {
            document.title = `${tabLabel[current]} · cirrus`;
        }
    }, [current, tabLabel]);

    return (
        <div className="grid min-h-0 flex-1 grid-cols-[13rem_minmax(0,1fr)]" data-testid="cirrus-dashboard">
            <div
                aria-label={t("Dashboard sections")}
                className="flex flex-col gap-px overflow-y-auto border-e border-border bg-sidebar px-2 py-3"
                data-testid="dash-tabs"
                role="tablist"
            >
                {NAV_GROUPS.map((group) => (
                    // role="presentation" so the tablist exposes only its tab
                    // buttons to assistive tech, not the grouping wrappers/labels.
                    <div className="flex flex-col gap-px pt-3 first:pt-0" key={group.key} role="presentation">
                        <span aria-hidden="true" className="px-2 pb-1 text-[10px] font-medium tracking-wider text-muted-foreground/70 uppercase">
                            {groupLabel[group.key]}
                        </span>
                        {group.tabs.map((tab) => (
                            <button
                                aria-selected={current === tab}
                                className="relative flex w-full items-center gap-2.5 px-2 py-1.5 text-start text-[13px] text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground aria-selected:bg-sidebar-accent aria-selected:font-medium aria-selected:text-sidebar-accent-foreground aria-selected:before:absolute aria-selected:before:inset-y-1 aria-selected:before:start-0 aria-selected:before:w-0.5 aria-selected:before:rounded-full aria-selected:before:bg-primary [&_svg]:opacity-70 aria-selected:[&_svg]:opacity-100"
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
                ))}
            </div>

            <div className="flex min-w-0 flex-col overflow-auto bg-background" data-testid="dash-panel" role="tabpanel">
                {/* Page header per section — a Studio-style title bar. */}
                <header className="flex shrink-0 flex-col gap-0.5 border-b border-border px-6 py-4">
                    <h1 className="text-base font-semibold text-foreground">{tabLabel[current]}</h1>
                    <p className="text-sm text-muted-foreground">{tabDescription[current]}</p>
                </header>
                {/* Key the boundary by tab so one panel throwing doesn't blank the
                    shell, and switching tabs clears a prior panel's error. */}
                <div className="min-w-0 flex-1 p-6">
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

/** Sends unknown paths back to the default tab. */
const NotFoundRedirect = (): null => {
    const navigate = useNavigate();

    useEffect(() => {
        fireAndForget(navigate({ replace: true, to: "/data" }));
    }, [navigate]);

    return null;
};

/**
 * Builds a self-contained TanStack Router whose root route renders
 * {@link DashboardLayout} and whose child routes render one panel each. Path
 * routing (`/data`, `/logs`, …) over the browser History API makes every tab a
 * real, shareable URL with working back/forward; a memory history is used when
 * there's no DOM (SSR). The panels close over the shell props, so the router is
 * rebuilt only when those change.
 */
const buildRouter = ({ basePath, dataEditable = false, functions, initialShardKey, scheduledCancel, scheduledLoad }: DashboardShellProps) => {
    const rootRoute = createRootRoute({ component: DashboardLayout });

    const panels: Record<DashboardTab, ReactElement> = {
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
        logs: <LogsPanel initialShardKey={initialShardKey} />,
        metrics: <MetricsPanel initialShardKey={initialShardKey} />,
        migrations: <MigrationsPanel initialShardKey={initialShardKey} />,
        schedule: <ScheduledJobs cancelJob={scheduledCancel} loadJobs={scheduledLoad} />,
        schema: <SchemaViewer initialShardKey={initialShardKey} />,
        users: <UsersPanel />,
    };

    // `/` renders the default panel directly (no async redirect, so the first
    // paint is synchronous); `/data` renders it too, so both URLs are valid.
    const indexRoute = createRoute({
        component: () => panels.data,
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
    const history = "window" in globalThis ? createBrowserHistory() : createMemoryHistory({ initialEntries: ["/data"] });

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
const DashboardShell = ({ basePath, dataEditable, functions, initialShardKey, scheduledCancel, scheduledLoad }: DashboardShellProps): ReactElement => {
    // Rebuild the router only when a panel-affecting prop changes (keyed on the
    // individual props, not the unstable `props` identity), so navigation state
    // survives unrelated re-renders.
    const router = useMemo(
        () => buildRouter({ basePath, dataEditable, functions, initialShardKey, scheduledCancel, scheduledLoad }),
        [basePath, dataEditable, functions, initialShardKey, scheduledCancel, scheduledLoad],
    );

    return <RouterProvider router={router} />;
};

/**
 * The composable dashboard. {@link DashboardShell} reads its strings from `useT`,
 * which needs a `DashboardI18nProvider` above it.
 *
 * When an `i18n` instance or a `locale` is supplied, this owns a provider so the
 * dashboard localises itself standalone. When neither is given it renders the
 * shell bare and inherits whatever provider is already in scope — the host app's
 * (`DashboardApp` owns one for the top bar too) or the shared default — instead
 * of nesting a second, redundant provider.
 */
export const Dashboard = ({
    basePath,
    dataEditable,
    functions,
    i18n,
    initialShardKey,
    locale,
    scheduledCancel,
    scheduledLoad,
}: DashboardProps): ReactElement => {
    const shell = (
        <DashboardShell
            basePath={basePath}
            dataEditable={dataEditable}
            functions={functions}
            initialShardKey={initialShardKey}
            scheduledCancel={scheduledCancel}
            scheduledLoad={scheduledLoad}
        />
    );

    if (i18n === undefined && locale === undefined) {
        return shell;
    }

    return (
        <DashboardI18nProvider i18n={i18n} locale={locale}>
            {shell}
        </DashboardI18nProvider>
    );
};

export type { DashboardProps, DashboardTab };
