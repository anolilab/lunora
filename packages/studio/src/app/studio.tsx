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
import type { ComponentType, ReactElement, ReactNode } from "react";
import { createContext, lazy, Suspense, use, useEffect } from "react";

import BrandMark from "../components/brand-mark";
import { ErrorBoundary } from "../components/error-boundary";
import { OperationConsoleProvider, useOperationConsole } from "../components/operation-console-provider";
import RulesBanner from "../components/rules-banner";
import { EnsureThemeProvider } from "../components/theme-provider";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarInset,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarProvider,
    useSidebar,
} from "../components/ui/sidebar";
import { Skeleton } from "../components/ui/skeleton";
// Home stays a static (eager) import so the landing route paints synchronously;
// every other feature panel is a route-level `React.lazy` boundary defined below
// so it — and its heavy deps (`@xyflow/react`, `recharts`, the SQL editor, the
// data grid) — loads in its own on-demand `chunk-*.js`, not in Home's first load.
import type { AnalyticsPanelProps } from "../features/analytics/analytics-panel";
import { HomePanel } from "../features/home/home-panel";
import OperationConsole from "../features/logs/operation-console";
import type { SchedulePanelProps } from "../features/logs/schedule-panel";
import useStudioFeatures from "../hooks/use-studio-features";
import { useT } from "../i18n/i18n-context";
import { StudioI18nProvider } from "../i18n/i18n-provider";
import type { StudioFeaturesResult } from "../lib/admin";
import { validateDataViewSearch, validateSchemaVersionSearch } from "../lib/data-view-params";
import { fireAndForget } from "../lib/internal";
import type { FunctionDescriptor } from "../lib/types";
import { cn } from "../lib/utils";
import { CommandPalette, openCommandPalette } from "./command-palette";
import { useNavLabels } from "./nav-labels";
import type { NavGroup, NavGroupKey, StudioTab } from "./nav-types";
import StudioHeader from "./studio-header";
import useConsoleShortcut from "./use-console-shortcut";

// Route-level lazy panels. Each becomes its own on-demand `chunk-*.js` under
// `dist/standalone/` (esbuild `splitting` in `scripts/build-standalone.mjs`),
// so a user landing on Home never downloads the SQL editor, the data grid, the
// schema diagram (`@xyflow/react`), the reports charts (`recharts`), or the
// other ~30 panels — they load only when their tab is visited. The `React.lazy`
// identities live at module scope so they stay stable across router rebuilds;
// the routed `<Outlet>` is wrapped in `<Suspense>` (see {@link StudioLayout}).
//
// `React.lazy` wants a `{ default }` module; {@link lazyNamed} unwraps a named
// export to that shape (preserving the component's props), so the many
// named-export panels stay one-liners. Default-exporting panels pass straight to
// `lazy`. The literal `import("…")` specifier MUST stay inline in the loader —
// esbuild's code-splitting keys off the static string, so never hoist it to a
// variable.
const lazyNamed = <P, K extends string>(load: () => Promise<Record<K, ComponentType<P>>>, key: K) =>
    lazy(() =>
        load().then((loaded) => {
            return { default: loaded[key] };
        }),
    );

const InsightsPanel = lazyNamed(() => import("../features/advisors/insights-panel"), "InsightsPanel");
const RlsPanel = lazy(() => import("../features/advisors/rls-panel"));
const AdvisorHealthPanel = lazy(() => import("../features/advisors/advisor-health-panel"));
const SecurityAdvisorPanel = lazy(() => import("../features/advisors/security-advisor-panel"));
const AgentsPanel = lazy(() => import("../features/agents/agents-panel"));
const AnalyticsPanel = lazyNamed(() => import("../features/analytics/analytics-panel"), "AnalyticsPanel");
const ApiTab = lazy(() => import("../features/api/api-tab"));
const AuthAuditPanel = lazy(() => import("../features/auth/auth-audit-panel"));
const AuthConfigPanel = lazy(() => import("../features/auth/auth-config-panel"));
const AuthSessionsPanel = lazy(() => import("../features/auth/auth-sessions-panel"));
const OrganizationsPanel = lazy(() => import("../features/auth/organizations-panel"));
const UsersPanel = lazyNamed(() => import("../features/auth/users-panel"), "UsersPanel");
const ContainersPanel = lazy(() => import("../features/containers/containers-panel"));
const DeploymentHealthPanel = lazyNamed(() => import("../features/health/deployment-health-panel"), "DeploymentHealthPanel");
const TableEditor = lazyNamed(() => import("../features/data/table-editor"), "TableEditor");
const ExportImportPanel = lazyNamed(() => import("../features/database/export-import"), "ExportImportPanel");
const MigrationsRoutePanel = lazy(() => import("../features/database/migrations-route"));

/**
 * Per-route search-param validators. A route absent from this map takes no typed
 * search params; `createRoute` accepts `undefined` for `validateSearch`.
 *
 * `/data` carries the whole data-browser view (table / tier / shard / search /
 * sort / filters); `/migrations` carries the selected schema version, so a
 * specific diff is a shareable link. A lookup rather than a branch per route:
 * adding one is a one-line data change, and it sidesteps the
 * route-property-order lint that blocked a spread.
 */
const SEARCH_VALIDATORS: Partial<Record<StudioTab, (search: Record<string, unknown>) => unknown>> = {
    data: validateDataViewSearch,
    migrations: validateSchemaVersionSearch,
};
const PitrPanel = lazyNamed(() => import("../features/database/pitr-panel"), "PitrPanel");
const FlagsPanel = lazy(() => import("../features/flags/flags-panel"));
const ReactorsPanel = lazy(() => import("../features/reactors/reactors-panel"));
const FunctionRunner = lazyNamed(() => import("../features/functions/function-runner"), "FunctionRunner");
const FunctionStatsPanel = lazyNamed(() => import("../features/functions/function-stats"), "FunctionStatsPanel");
const IssuesPanel = lazy(() => import("../features/issues/issues-panel"));
const AuditPanel = lazyNamed(() => import("../features/logs/audit-panel"), "AuditPanel");
const LogDrainsPanel = lazy(() => import("../features/logs/log-drains-panel"));
// `logs-panel` re-exports several types alongside the component, which trips the
// generic prop inference in `lazyNamed` (it mis-infers the panel's props). The
// explicit unwrap keeps `LogsPanel`'s exact props type.
const LogsPanel = lazy(() =>
    import("../features/logs/logs-panel").then((m) => {
        return { default: m.LogsPanel };
    }),
);
const MailPanel = lazyNamed(() => import("../features/logs/mail-panel"), "MailPanel");
const SchedulePanel = lazyNamed(() => import("../features/logs/schedule-panel"), "SchedulePanel");
const SubscriptionsPanel = lazy(() => import("../features/logs/subscriptions-panel"));
const SyncClientPanel = lazy(() => import("../features/logs/sync-client-panel"));
const KvBrowser = lazyNamed(() => import("../features/kv/kv-browser"), "KvBrowser");
const NotificationsPanel = lazy(() => import("../features/notifications/notifications-panel"));
const PaymentsPanel = lazyNamed(() => import("../features/payments/payments-panel"), "PaymentsPanel");
const PermissionsPanel = lazyNamed(() => import("../features/permissions/permissions-panel"), "PermissionsPanel");
const QueuesPanel = lazy(() => import("../features/queues/queues-panel"));
const DashboardsPanel = lazy(() => import("../features/reports/dashboards-panel"));
const FanoutPanel = lazy(() => import("../features/reports/fanout-panel"));
const HealthPanel = lazyNamed(() => import("../features/reports/health-panel"), "HealthPanel");
const MetricsPanel = lazyNamed(() => import("../features/reports/metrics-panel"), "MetricsPanel");
const SchemaViewer = lazyNamed(() => import("../features/schema/schema-viewer"), "SchemaViewer");
const SettingsPanel = lazyNamed(() => import("../features/settings/settings-panel"), "SettingsPanel");
const SqlEditorPanel = lazyNamed(() => import("../features/sql/sql-editor-panel"), "SqlEditorPanel");
const FileBrowser = lazyNamed(() => import("../features/storage/file-browser"), "FileBrowser");
const StorageRulesPanel = lazy(() => import("../features/storage/storage-rules-panel"));
const TracesPanel = lazy(() => import("../features/traces/traces-panel"));
const EvalsPanel = lazy(() => import("../features/evals/evals-panel"));
const VectorBrowser = lazyNamed(() => import("../features/vectors/vector-browser"), "VectorBrowser");
const WorkflowsPanel = lazy(() => import("../features/workflows/workflows-panel"));

interface StudioProps {
    /**
     * Run one Analytics Engine SQL statement for the Analytics tab. There is no
     * default: the AE SQL API authenticates with an account-scoped Cloudflare API
     * token, and inlining one into this browser bundle would leak it to anyone who
     * views source. Supply a runner that proxies the statement through your own
     * worker (which holds the token server-side). Without it the Analytics tab
     * renders an empty state and issues no request.
     *
     * Pass a STABLE reference — a module-level function, or one held in a
     * `useCallback`/ref. It is read while building the tab router, so a fresh
     * inline arrow on every render rebuilds the router and remounts the panel
     * tree, losing in-progress query state. The same holds for `scheduledLoad`,
     * `scheduledCancel` and `scheduledCron`.
     */
    readonly analyticsQuery?: AnalyticsPanelProps["runQuery"];

    /**
     * URL path prefix the studio is mounted under, passed to the router as its
     * `basepath`. Defaults to `/` (mounted at the origin root). The `@lunora/vite`
     * dev route serves the studio under `/__lunora`, so it sets this — without
     * it the router treats `/__lunora` as unknown and bounces to `/data`, escaping
     * the mount.
     */
    readonly basePath?: string;

    /**
     * App-owned top-bar + sidebar-footer chrome (theme toggle, admin-token
     * popover, rules banner). The batteries-included `StudioApp` supplies
     * this; composing `<Studio>` bare omits those affordances. See {@link StudioChrome}.
     */
    readonly chrome?: StudioChrome;

    /**
     * Show the data tab's write controls (insert/edit/delete rows). Off by
     * default; see {@link TableEditor}.
     *
     * **This HIDES THE CONTROLS. It does not make anything read-only.** The
     * write RPCs are gated server-side by `LUNORA_ADMIN_TOKEN` alone — one
     * all-or-nothing check in `handleAdminRpc`, with no read/write scoping — and
     * `renderStudioHtml({ adminToken })` already ships that bearer to the
     * browser. So a viewer handed a studio deployed with `dataEditable: false`
     * still holds a credential that can write; the buttons are simply absent
     * from the page. Treat it as an affordance switch for a trusted operator,
     * never as an authorization boundary. The same holds for
     * {@link StudioProps.schemaEditable} and {@link StudioProps.runAsIdentity}.
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
     * Inline OpenAPI 3.1 document rendered by the API tab's reference sub-view.
     * Thread the generated `_generated/openapi.json` here to render it
     * without a round-trip. When omitted the reference fetches the worker's
     * admin-gated `GET /_lunora/admin/openapi` endpoint via the client.
     */
    readonly openApiSpec?: unknown;

    /**
     * Inline OpenRPC 1.x document rendered by the API tab's reference sub-view
     * when the OpenRPC format is selected. Thread the generated
     * `_generated/openrpc.json` here to render it without a round-trip. When
     * omitted the OpenRPC view fetches the worker's admin-gated
     * `GET /_lunora/admin/openrpc` endpoint via the client.
     */
    readonly openRpcSpec?: unknown;

    /**
     * Allow the function runner to execute a function AS a chosen authenticated
     * identity (the "Run as identity" tool), so an operator can test auth + RLS
     * behavior. Security-sensitive: it forges identity on an admin-gated RPC, so
     * the host MUST set this only on a trusted loopback-dev gate (the same gate
     * as `dataEditable`) — never in a production/static deploy. Off by default;
     * see {@link FunctionRunner}.
     *
     * Like {@link StudioProps.dataEditable}, leaving it off only hides the tool.
     * The RPC behind it stays reachable to anyone holding the admin token the
     * page already carries — the gate is the token, not this flag.
     */
    readonly runAsIdentity?: boolean;

    /**
     * Override how the schedule tab cancels a job. Defaults to the client's
     * scheduler admin endpoint; see {@link SchedulePanel}.
     */
    readonly scheduledCancel?: SchedulePanelProps["scheduledCancel"];

    /**
     * Override how the schedule tab's Cron triggers sub-view loads triggers.
     * Defaults to the client's `/_lunora/admin/cron-jobs` endpoint; see
     * {@link SchedulePanel}.
     */
    readonly scheduledCron?: SchedulePanelProps["loadCronJobs"];

    /**
     * Override how the schedule tab loads jobs. Defaults to the client's
     * scheduler admin endpoint, so the tab works without extra wiring.
     */
    readonly scheduledLoad?: SchedulePanelProps["scheduledLoad"];

    /**
     * Show the visual schema editor overlay on the schema diagram (add table /
     * column / index, written back to `lunora/schema.ts` + codegen). Off by
     * default. Only the loopback-only dev hosts set this — the write path needs
     * the project's filesystem + toolchain, so a static deploy leaves it off.
     *
     * Like {@link StudioProps.dataEditable}, it hides the overlay rather than
     * making the diagram read-only: what actually stops a schema write in a
     * static deploy is that the host has no filesystem to write to, not this
     * flag.
     */
    readonly schemaEditable?: boolean;
}

/** Props the inner shell renders with — everything except the i18n wiring. */
type StudioShellProps = Omit<StudioProps, "i18n" | "locale">;

/**
 * Top-bar + sidebar-footer chrome the `StudioApp` owns (theme + admin
 * token state, the rules banner) but which renders *inside* the router-owned
 * {@link StudioLayout} (the header and sidebar footer). The layout is a route
 * component with no props, so it reads this from context rather than threading
 * it through the router. Absent (composing `<Studio>` bare) the layout simply
 * omits those affordances.
 */
interface StudioChrome {
    readonly clearToken: () => void;
    readonly onTokenChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    readonly rulesInstalled?: boolean;
    readonly token: string;
}

const StudioChromeContext = createContext<StudioChrome | null>(null);

/**
 * 16px line glyphs (drawn at a 24-unit grid) keyed by tab. Inline so the
 * studio ships no icon-font/asset dependency; they inherit `currentColor`
 * from the active/hover nav state in the scoped stylesheet.
 */
const TAB_ICONS: Record<StudioTab, ReactNode> = {
    analytics: <path d="M5 20V10m6.5 10V4M18 20v-7M3 20h18" />,
    api: <path d="m9 8-4 4 4 4m6-8 4 4-4 4M13 5l-2 14" />,
    audit: <path d="M7 4h7l4 4v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm6 0v5h5M9 13h6M9 16h6M9 10h2" />,
    authAudit: <path d="M12 3 5 6v5c0 4.5 3 7.8 7 9 4-1.2 7-4.5 7-9V6l-7-3Zm-3 8h6m-6 3h6" />,
    authConfig: (
        <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.3 7.3 0 0 0-2-1.2l-.4-2.6h-3.6l-.4 2.6a7.3 7.3 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.3 7.3 0 0 0 2 1.2l.4 2.6h3.6l.4-2.6a7.3 7.3 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6a7.4 7.4 0 0 0 .1-1.2Z" />
    ),
    agents: (
        <path d="M12 8V5m0 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM6 8h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Zm3 5h.01M15 13h.01M9 21h6" />
    ),
    authSessions: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.5V12l4 2" />,
    containers: <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9Zm0 0 9 4.5m0 0 9-4.5m-9 4.5V21" />,
    dashboards: <path d="M4 5h7v6H4V5Zm9 0h7v4h-7V5ZM4 14h7v5H4v-5Zm9-1h7v6h-7v-6Z" />,
    deploymentHealth: <path d="M12 3 5 6v5c0 4.5 3 7.8 7 9 4-1.2 7-4.5 7-9V6l-7-3Zm-3 8 2 3 4-5" />,
    drains: <path d="M5 5h14M7 5v6a5 5 0 0 0 10 0V5M10 16h4v3h-4zM12 19v2" />,
    data: (
        <path d="M5 6c0-1.4 3.1-2.5 7-2.5s7 1.1 7 2.5-3.1 2.5-7 2.5S5 7.4 5 6Zm0 0v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
    ),
    export: <path d="M12 3v11m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />,
    fanout: (
        <path d="M12 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm-7 16a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm14 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM12 7v3.5M12 10.5 6 17m6-6.5 6 6.5" />
    ),
    files: <path d="M4 7a2 2 0 0 1 2-2h3l2 2.5h7a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" />,
    flags: <path d="M6 21V4m0 0h11l-2 3 2 3H6" />,
    functions: <path d="m9 8-4 4 4 4m6-8 4 4-4 4" />,
    evals: <path d="M4 19V5m0 14h16M8 15l3-4 3 3 4-6M8 15v.01" />,
    health: <path d="M3 12h4l2 6 4-14 2 8h6" />,
    home: <path d="M3 11.5 12 4l9 7.5M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" />,
    insights: <path d="M12 3a6 6 0 0 0-3.6 10.8c.5.4.8.9.9 1.5l.2 1.2h5l.2-1.2c.1-.6.4-1.1.9-1.5A6 6 0 0 0 12 3ZM9.5 20.5h5M10 18h4" />,
    issues: <path d="M10.3 4.3 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0ZM12 9v4m0 3v.01" />,
    kv: <path d="M5 5h14v4H5V5Zm0 5h14v4H5v-4Zm0 5h14v4H5v-4Z" />,
    logs: <path d="M5 6h14M5 10h14M5 14h9M5 18h11" />,
    mail: <path d="M4 5h16v14H4V5Zm0 1.5 8 6 8-6" />,
    payments: <path d="M3 7h18v10H3V7Zm0 3h18M7 14h4" />,
    metrics: <path d="M5 20V10m6.5 10V4M18 20v-7M3 20h18" />,
    migrations: <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.6L4 16m0 4v-4h4" />,
    notifications: (
        <path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 0 0-4-5.7V5a2 2 0 1 0-4 0v.3A6 6 0 0 0 6 11v3.2a2 2 0 0 1-.6 1.4L4 17h5m6 0v1a3 3 0 1 1-6 0v-1m6 0H9" />
    ),
    organizations: <path d="M3 21V8l6-4 6 4v13M9 21v-5h2v5M15 11h6v10M18 14v.01M18 17v.01M6 9v.01M6 12v.01M6 15v.01" />,
    permissions: <path d="M12 3 5 6v5c0 4.5 3 7.8 7 9 4-1.2 7-4.5 7-9V6l-7-3Zm-3 8 2.2 2.2L15 9.5M8.5 16h7" />,
    pitr: <path d="M12 21a9 9 0 1 0-9-9M12 7.5V12l3 2M3 12l-2-2m2 2 2-2" />,
    queues: <path d="M4 6h16M4 10h16M4 14h10M4 18h10m4-2 3 2-3 2v-4Z" />,
    reactors: <path d="M4 4v6h6M20 20v-6h-6M20 9a8 8 0 0 0-14.7-3M4 15a8 8 0 0 0 14.7 3" />,
    realtime: <path d="M5 12a7 7 0 0 1 14 0M8 12a4 4 0 0 1 8 0M12 12v8m0-8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />,
    rls: <path d="M12 3 5 6v5c0 4.5 3 7.8 7 9 4-1.2 7-4.5 7-9V6l-7-3ZM8.5 10h7M8.5 13h7" />,
    schedule: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.5V12l4 2" />,
    schema: <path d="M4 5h16v14H4V5Zm0 5h16M10 10v9M4 14.5h16" />,
    sql: <path d="M4 5h16v14H4V5Zm3 4 3 3-3 3m6 0h4" />,
    storageRules: <path d="M7 10V7a5 5 0 0 1 10 0v3m-11 0h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Zm6 4v2" />,
    advisorHealth: <path d="M3 12h4l2-5 3 10 2-5h5" />,
    security: <path d="M12 3 5 6v5c0 4.5 3 7.8 7 9 4-1.2 7-4.5 7-9V6l-7-3Zm-2.5 8.5 2 2 4-4" />,
    traces: <path d="M3 6h9M6 12h12M10 18h7" />,
    settings: (
        <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.3 7.3 0 0 0-2-1.2l-.4-2.6H10.5l-.4 2.6a7.3 7.3 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.3 7.3 0 0 0 2 1.2l.4 2.6h3.6l.4-2.6a7.3 7.3 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6a7.4 7.4 0 0 0 .1-1.2Z" />
    ),
    users: (
        <path d="M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm11.5 10v-2a4 4 0 0 0-3-3.85M16 3.13A4 4 0 0 1 16 11" />
    ),
    vectors: <path d="M4 7l8-4 8 4-8 4-8-4Zm0 5 8 4 8-4M4 17l8 4 8-4" />,
    workflows: <path d="M5 5h5v5H5V5Zm9 9h5v5h-5v-5ZM7.5 10v2a2 2 0 0 0 2 2H14m2.5-4V8a2 2 0 0 0-2-2H10" />,
};

/**
 * Icon-rail domains, top to bottom, each owning the sub-pages its secondary nav
 * lists — the two-level Supabase model (`STUDIO-REDESIGN-PLAN.md` §2). `settings`
 * pins to the bottom of the rail (see {@link StudioLayout}). Typed as a non-empty
 * tuple so the first domain is a guaranteed fallback for the active-domain lookup.
 */
const NAV_GROUPS: readonly [NavGroup, ...NavGroup[]] = [
    { key: "overview", tabs: ["home", "dashboards"] },
    { key: "database", tabs: ["data", "sql", "schema", "migrations", "vectors", "pitr", "export"] },
    { key: "functions", tabs: ["functions", "api", "workflows", "agents", "queues"] },
    { key: "auth", tabs: ["users", "organizations", "authSessions", "authAudit", "authConfig"] },
    { key: "storage", tabs: ["files", "storageRules", "kv"] },
    {
        key: "observability",
        tabs: [
            "issues",
            "logs",
            "traces",
            "evals",
            "audit",
            "realtime",
            "reactors",
            "fanout",
            "containers",
            "metrics",
            "analytics",
            "health",
            "deploymentHealth",
        ],
    },
    { key: "advisors", tabs: ["advisorHealth", "security", "rls", "permissions", "insights"] },
    { key: "operations", tabs: ["schedule", "mail", "drains", "notifications", "payments", "flags"] },
    { key: "settings", tabs: ["settings"] },
];

/**
 * Optional, package-backed tabs and the feature flag that gates each. A tab
 * listed here is hidden from the nav (and its panel made unreachable) when the
 * deployment doesn't wire up the backing package — so an app with no
 * `@lunora/payment` never shows the Payments page, the way auth panels gate on
 * capabilities. Tabs absent from this map are always shown (core surfaces). The
 * flags come from `useStudioFeatures` (the `__lunora_admin__:studioFeatures` RPC,
 * statically discovered by codegen). `storage` gates both the file browser and
 * the access-rules view; `scheduler` gates the scheduled-jobs view; `auth` gates
 * all five auth pages — including the audit trail, whose `getAuthAuditLog` RPC
 * answers `AUTH_AUDIT_NOT_CONFIGURED` without `@lunora/auth`'s reader wired.
 */
const TAB_FEATURE: Partial<Record<StudioTab, keyof StudioFeaturesResult>> = {
    analytics: "analytics",
    authAudit: "auth",
    authConfig: "auth",
    authSessions: "auth",
    containers: "containers",
    files: "storage",
    flags: "flags",
    kv: "kv",
    mail: "mail",
    notifications: "notifications",
    organizations: "auth",
    payments: "payments",
    queues: "queues",
    schedule: "scheduler",
    storageRules: "storage",
    users: "auth",
    vectors: "vectors",
    workflows: "workflows",
};

/** True when a tab is shown for the given feature flags: always, unless its gating flag is off. */
const isTabVisible = (tab: StudioTab, features: StudioFeaturesResult): boolean => {
    const feature = TAB_FEATURE[tab];

    return feature === undefined || features[feature];
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

/**
 * Compile-time route-coverage guard: the identity call typechecks only when
 * `tabs` contains every {@link StudioTab}. The route table is built from
 * {@link TABS} while the sidebar renders from {@link NAV_GROUPS}, so a tab
 * missing from `TABS` still shows its nav link but the click falls through to
 * {@link NotFoundRedirect} and bounces to Home (how `/fanout` regressed). A
 * missing tab now fails `tsc` at the `TABS` declaration instead.
 */
const exhaustiveRouteTabs = <const T extends ReadonlyArray<StudioTab>>(tabs: ([StudioTab] extends [T[number]] ? unknown : never) & T): T => tabs;

/** Flat list of every tab, in sidebar order; drives the route table. */
const TABS = exhaustiveRouteTabs([
    "home",
    "data",
    "sql",
    "functions",
    "api",
    "workflows",
    "agents",
    "queues",
    "containers",
    "schema",
    "migrations",
    "vectors",
    "export",
    "pitr",
    "users",
    "organizations",
    "authSessions",
    "authAudit",
    "authConfig",
    "files",
    "storageRules",
    "kv",
    "dashboards",
    "metrics",
    "analytics",
    "health",
    "deploymentHealth",
    "advisorHealth",
    "security",
    "rls",
    "permissions",
    "insights",
    "issues",
    "logs",
    "traces",
    "evals",
    "reactors",
    "realtime",
    "fanout",
    "mail",
    "notifications",
    "payments",
    "audit",
    "schedule",
    "drains",
    "flags",
    "settings",
]);

/**
 * Tabs that own the full panel height (a flush full-height table/query sidebar +
 * an internally-scrolling grid), rather than the default top-aligned, page-scrolled
 * content. The Table editor and SQL editor render as full-height database consoles.
 */
const FULL_HEIGHT_TABS = new Set<StudioTab>(["api", "data", "migrations", "sql"]);

/** Resolve the active tab from a router pathname (`/logs` → `logs`); unknown paths fall back to `home`. */
const tabFromPathname = (pathname: string): StudioTab => {
    // Use the last non-empty segment so this holds whether or not the router's
    // pathname still carries a basepath prefix (`/__lunora/logs` → `logs`).
    const slug = pathname.split("/").findLast(Boolean) ?? "";

    return (TABS as ReadonlyArray<string>).includes(slug) ? (slug as StudioTab) : "home";
};

/** The admin-token form shown in the footer connect popover — shared by the expanded card and the collapsed avatar trigger. */
const ConnectPopoverContent = ({ chrome, connected }: { readonly chrome: StudioChrome; readonly connected: boolean }): ReactElement => {
    const t = useT();

    return (
        <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-foreground" htmlFor="dash-app-token">
                {t("admin token")}
            </label>
            <Input
                className="h-8"
                data-testid="dash-app-token"
                id="dash-app-token"
                onChange={chrome.onTokenChange}
                placeholder="LUNORA_ADMIN_TOKEN"
                type="password"
                value={chrome.token}
            />
            {connected && (
                <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground" data-testid="dash-app-token-warning" role="note">
                    <span aria-hidden="true" className="text-warning">
                        ⚠
                    </span>
                    {t("Token rides the WebSocket URL — it can surface in browser DevTools and server logs. Use a dev-only token.")}
                </p>
            )}
            {connected && (
                <button
                    className="self-start rounded-md border border-border px-2.5 py-1 text-xs font-medium outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                    data-testid="dash-app-clear-token"
                    onClick={chrome.clearToken}
                    type="button"
                >
                    {t("Clear")}
                </button>
            )}
        </div>
    );
};

interface StudioSidebarProps {
    readonly chrome: StudioChrome | null;
    readonly connected: boolean;
    readonly current: StudioTab;
    readonly groupLabel: Record<NavGroupKey, string>;
    readonly groups: ReadonlyArray<{ readonly key: NavGroupKey; readonly tabs: ReadonlyArray<StudioTab> }>;
    readonly selectTab: (event: React.MouseEvent<HTMLButtonElement>) => void;
    readonly tabDescription: Record<StudioTab, string>;
    readonly tabLabel: Record<StudioTab, string>;
}

/**
 * One domain in the **collapsed** icon rail: a single icon that opens a hover
 * flyout listing that domain's pages. The icon itself never navigates — only the
 * flyout rows do — so every page stays reachable from the narrow rail. Extracted
 * from {@link StudioSidebar} to keep that component's branching shallow.
 */
const CollapsedGroupNav = ({
    current,
    group,
    groupLabel,
    selectTab,
    tabDescription,
    tabLabel,
}: {
    readonly current: StudioTab;
    readonly group: { readonly key: NavGroupKey; readonly tabs: ReadonlyArray<StudioTab> };
    readonly groupLabel: Record<NavGroupKey, string>;
    readonly selectTab: (event: React.MouseEvent<HTMLButtonElement>) => void;
    readonly tabDescription: Record<StudioTab, string>;
    readonly tabLabel: Record<StudioTab, string>;
}): ReactElement => (
    <Popover>
        <PopoverTrigger
            aria-current={group.tabs.includes(current) ? "page" : undefined}
            aria-label={groupLabel[group.key]}
            className="mx-auto flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent data-[popup-open]:text-sidebar-accent-foreground data-[popup-open]:shadow-xs aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground aria-[current=page]:shadow-xs"
            delay={120}
            openOnHover
        >
            <TabIcon tab={group.tabs[0] as StudioTab} />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-1" side="right" sideOffset={8}>
            <div className="px-2 py-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{groupLabel[group.key]}</div>
            {group.tabs.map((tab) => (
                <button
                    aria-current={current === tab ? "page" : undefined}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-[13px] text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent aria-[current=page]:bg-accent aria-[current=page]:font-medium [&_svg]:opacity-70 aria-[current=page]:[&_svg]:opacity-100"
                    data-tab={tab}
                    data-testid={`dash-tab-${tab}`}
                    key={tab}
                    onClick={selectTab}
                    title={tabDescription[tab]}
                    type="button"
                >
                    <TabIcon tab={tab} />
                    <span>{tabLabel[tab]}</span>
                </button>
            ))}
        </PopoverContent>
    </Popover>
);

/**
 * The bottom-pinned profile / connection card. Without app-owned `chrome`
 * (composing `<Studio>` bare) it's a static avatar; with it, it's the trigger
 * for the admin-token popover. Extracted from {@link StudioSidebar} to keep that
 * component's branching shallow.
 */
const SidebarFooterProfile = ({
    chrome,
    collapsed,
    connected,
}: {
    readonly chrome: StudioChrome | null;
    readonly collapsed: boolean;
    readonly connected: boolean;
}): ReactElement => {
    const t = useT();

    if (chrome === null) {
        return (
            <SidebarMenuButton className="data-active:bg-transparent" size="lg" tooltip={t("Admin")}>
                <span className="flex size-8 items-center justify-center rounded-full bg-sidebar-accent text-[11px] font-medium">C</span>
                <span className="grid flex-1 text-start leading-tight">
                    <span className="truncate text-[13px] font-medium">{t("Admin")}</span>
                    <span className="truncate text-[11px] text-muted-foreground">{t("Studio")}</span>
                </span>
            </SidebarMenuButton>
        );
    }

    return (
        <Popover>
            <PopoverTrigger
                className={cn(
                    "flex items-center gap-2 rounded-md text-start outline-none transition-colors hover:bg-sidebar-accent focus-visible:bg-sidebar-accent",
                    collapsed ? "mx-auto size-8 justify-center" : "w-full p-2",
                )}
                data-testid="dash-app-connect"
                title={connected ? t("Connected") : t("Not connected")}
            >
                <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-[11px] font-medium">
                    C
                    <span
                        aria-hidden="true"
                        className={cn(
                            "absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-sidebar",
                            connected ? "bg-success" : "bg-muted-foreground/50",
                        )}
                    />
                </span>
                {!collapsed && (
                    <>
                        <span className="grid flex-1 text-start leading-tight">
                            <span className="truncate text-[13px] font-medium">{t("Admin")}</span>
                            <span className="truncate text-[11px] text-muted-foreground">{connected ? t("Connected") : t("Not connected")}</span>
                        </span>
                        <svg
                            aria-hidden="true"
                            className="size-4 text-muted-foreground"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.7}
                            viewBox="0 0 24 24"
                        >
                            <path d="m8 9 4-4 4 4M8 15l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    </>
                )}
            </PopoverTrigger>
            <PopoverContent align={collapsed ? "end" : "start"} keepMounted side={collapsed ? "right" : "top"}>
                <ConnectPopoverContent chrome={chrome} connected={connected} />
            </PopoverContent>
        </Popover>
    );
};

/**
 * The grouped sidebar. Reads the provider's collapsed/expanded state to swap
 * presentation: **expanded** shows the full labelled nav (each row's one-line
 * description as a hover tooltip); **collapsed** shows one icon per domain, each
 * opening a hover flyout of that domain's pages — so every page stays reachable
 * from the narrow icon rail. Rendered inside `<SidebarProvider>` so it can call
 * {@link useSidebar}.
 */
const StudioSidebar = ({ chrome, connected, current, groupLabel, groups, selectTab, tabDescription, tabLabel }: StudioSidebarProps): ReactElement => {
    const t = useT();
    const { state } = useSidebar();
    const collapsed = state === "collapsed";

    return (
        <Sidebar collapsible="icon" variant="inset">
            {/* Brand — a static mark + wordmark (no button/hover), bigger logo. */}
            <SidebarHeader>
                <div className={cn("flex items-center gap-2.5 px-1.5 py-1", collapsed && "justify-center px-0")}>
                    <BrandMark className="size-9 shrink-0 text-foreground" />
                    {!collapsed && (
                        <>
                            <span className="grid flex-1 leading-tight">
                                <span className="truncate text-sm font-semibold text-foreground">lunora</span>
                                <span className="truncate text-[11px] text-muted-foreground">{t("Studio")}</span>
                            </span>
                            <Badge className="px-1.5 text-[10px] tracking-wider uppercase" variant="secondary">
                                {connected ? t("Live") : t("Local")}
                            </Badge>
                        </>
                    )}
                </div>
            </SidebarHeader>

            <SidebarContent>
                {collapsed
                    ? groups.map((group) => (
                          <CollapsedGroupNav
                              current={current}
                              group={group}
                              groupLabel={groupLabel}
                              key={group.key}
                              selectTab={selectTab}
                              tabDescription={tabDescription}
                              tabLabel={tabLabel}
                          />
                      ))
                    : groups.map((group) => (
                          <SidebarGroup key={group.key}>
                              <SidebarGroupLabel className="text-[11px] font-medium tracking-wider uppercase">{groupLabel[group.key]}</SidebarGroupLabel>
                              <SidebarGroupContent>
                                  <SidebarMenu>
                                      {group.tabs.map((tab) => (
                                          <SidebarMenuItem key={tab}>
                                              <SidebarMenuButton
                                                  className="data-active:text-foreground dark:data-active:text-royal-amethyst data-active:shadow-[inset_2px_0_0_0_var(--royal-amethyst)]"
                                                  data-tab={tab}
                                                  data-testid={`dash-tab-${tab}`}
                                                  isActive={current === tab}
                                                  onClick={selectTab}
                                                  title={tabDescription[tab]}
                                                  tooltip={tabDescription[tab]}
                                              >
                                                  <TabIcon tab={tab} />
                                                  <span>{tabLabel[tab]}</span>
                                              </SidebarMenuButton>
                                          </SidebarMenuItem>
                                      ))}
                                  </SidebarMenu>
                              </SidebarGroupContent>
                          </SidebarGroup>
                      ))}
            </SidebarContent>

            {/* Profile / connection card pinned to the bottom — opens the admin-token
                popover. Collapses to just the avatar in the icon rail. */}
            <SidebarFooter>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarFooterProfile chrome={chrome} collapsed={collapsed} connected={connected} />
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarFooter>
        </Sidebar>
    );
};

/**
 * Skeleton shown while a route resolves — the brief first paint after mount, a
 * lazy panel's chunk streaming in (the {@link Suspense} fallback below), and any
 * future panel with a router loader — so the content area never flashes empty.
 * Renders inside the layout's panel region during navigation.
 */
const RoutePending = (): ReactElement => (
    <div className="flex flex-col gap-4" data-testid="dash-pending">
        <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-8 w-24" />
        </div>
        <Skeleton className="h-72 w-full" />
    </div>
);

/**
 * Persistent shell rendered by the router's root route: the grouped sidebar
 * ({@link StudioSidebar}) and the routed panel area (`<Outlet />`). The active
 * tab is derived from the URL, so deep links and the browser back/forward
 * buttons drive which panel shows.
 */
const StudioLayoutShell = (): ReactElement => {
    const t = useT();
    const navigate = useNavigate();
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const current = tabFromPathname(pathname);
    const fullHeight = FULL_HEIGHT_TABS.has(current);

    // The operation console (plan 204): a dockable tape of every admin RPC this
    // studio issued. Toggled with ⌘/Ctrl+` — recording is always on regardless,
    // because a tape you have to arm before the bug is a tape that misses it.
    // The open/focus state lives in a provider above this layout so an
    // `ErrorAlert` rendered deep inside a panel can open it on a specific entry.
    // `StudioLayout` always mounts the provider above this component, so the
    // context is present; the optional read is for the type, not a real branch.
    const operationConsole = useOperationConsole();
    const toggleConsole = operationConsole?.toggle;

    useConsoleShortcut(toggleConsole);

    // Which optional package-backed pages this deployment enables. Defaults to
    // everything-shown until the RPC settles, so the nav never flickers a page in
    // then out — it only ever drops a page once the worker reports it disabled.
    const features = useStudioFeatures();
    const { groupLabel, tabDescription, tabLabel } = useNavLabels();

    // The nav, command palette, and active-domain lookup all run off the filtered
    // groups so a disabled feature's tab disappears from every entry point. A
    // group whose every tab is gated off collapses out of the rail entirely.
    // react-doctor-disable-next-line react-doctor/js-combine-iterations -- two passes over the nav groups — a fixed table of ~9 domains, walked once per render of the rail
    const visibleGroups = NAV_GROUPS.map((group) => {
        return { ...group, tabs: group.tabs.filter((tab) => isTabVisible(tab, features)) };
    }).filter((group) => group.tabs.length > 0);

    // Landing on (or deep-linking to) a now-hidden tab bounces to Home, so a
    // disabled feature's panel is unreachable even by typing its URL — the same
    // backstop `NotFoundRedirect` gives unknown paths.
    useEffect(() => {
        if (!isTabVisible(current, features)) {
            fireAndForget(navigate({ replace: true, to: "/home" }));
        }
    }, [current, features, navigate]);

    const selectTab = (event: React.MouseEvent<HTMLButtonElement>): void => {
        fireAndForget(navigate({ to: `/${event.currentTarget.dataset.tab ?? ""}` }));
    };

    // Reflect the active section in the tab title — this is a hostable, routed
    // studio, so each deep-linked panel gets its own document title.
    useEffect(() => {
        if (typeof document !== "undefined") {
            document.title = `${tabLabel[current]} · lunora`;
        }
    }, [current, tabLabel]);

    // The domain owning the current tab, used for the header breadcrumb. `current`
    // always belongs to a group, but `.find` is typed as possibly undefined; fall
    // back to the first domain (the non-empty tuple type guarantees one).
    const activeGroup = visibleGroups.find((group) => group.tabs.includes(current)) ?? NAV_GROUPS[0];

    // Every navigable destination, in sidebar order, for the ⌘K command palette.
    const commandItems = visibleGroups.flatMap((group) =>
        group.tabs.map((tab) => {
            return { group: groupLabel[group.key], label: tabLabel[tab], to: `/${tab}` };
        }),
    );

    /*
     * The operation console is reachable by keyboard chord only — no route, no
     * button — so without this entry it is undiscoverable, and unreachable
     * entirely once an operator rebinds the key and forgets what to. Appended
     * rather than mixed into the nav list: it acts rather than navigates.
     *
     * Omitted when the console provider is not mounted, which is also when the
     * chord binds nothing — an entry that silently did nothing would be worse
     * than no entry.
     */
    const paletteItems =
        toggleConsole === undefined ? commandItems : [...commandItems, { group: t("Operations"), label: t("Toggle operation console"), run: toggleConsole }];

    // The app-owned chrome (theme + admin token + rules banner) renders inside this
    // router-owned layout; absent when `<Studio>` is composed bare.
    const chrome = use(StudioChromeContext);
    const connected = chrome !== null && chrome.token !== "";

    return (
        <SidebarProvider className="min-h-0 flex-1" data-testid="lunora-studio">
            <CommandPalette items={paletteItems} />

            <StudioSidebar
                chrome={chrome}
                connected={connected}
                current={current}
                groupLabel={groupLabel}
                groups={visibleGroups}
                selectTab={selectTab}
                tabDescription={tabDescription}
                tabLabel={tabLabel}
            />

            <SidebarInset className="overflow-hidden md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm">
                {/* Top bar — sidebar toggle + breadcrumb, centred ⌘K search, and the
                    connection / theme cluster. Mirrors the reference dashboard header. */}
                <StudioHeader domain={groupLabel[activeGroup.key]} onOpenCommandPalette={openCommandPalette} page={tabLabel[current]} />

                {chrome?.rulesInstalled === false && <RulesBanner />}

                <div
                    aria-labelledby={`dash-tab-${current}`}
                    className="flex min-w-0 flex-1 flex-col overflow-hidden"
                    data-testid="dash-panel"
                    id="dash-panel"
                    role="tabpanel"
                >
                    {/* No per-section title bar — the breadcrumb already names the page and
                        each nav item carries its one-line description as a tooltip, so the
                        panel gets the full content area. Key the boundary by tab so one
                        panel throwing doesn't blank the shell, and switching tabs clears a
                        prior panel's error. Full-height tabs (Table/SQL editor) own the
                        height and scroll internally and fill edge-to-edge; the rest get the
                        default padded, page-scrolled content area. */}
                    <div className={fullHeight ? "flex min-w-0 flex-1 flex-col overflow-hidden" : "min-w-0 flex-1 overflow-auto p-6"}>
                        <ErrorBoundary
                            fallbackTitle={t("{title} failed", { title: tabLabel[current] })}
                            key={current}
                            label={tabLabel[current]}
                            retryLabel={t("Try again")}
                        >
                            {/* Every routed panel except Home is a `React.lazy` boundary, so its
                                chunk streams in behind this Suspense fallback; Home (the index
                                route) is eager and paints without suspending. */}
                            <Suspense fallback={<RoutePending />}>
                                <Outlet />
                            </Suspense>
                        </ErrorBoundary>
                    </div>
                    {/* The operation console docks under whatever panel is open — it is a
                        companion to the current page, not a destination of its own. */}
                    {operationConsole?.open === true && (
                        <OperationConsole
                            focusSeq={operationConsole.focusSeq}
                            onClose={operationConsole.close}
                            onShownChange={operationConsole.setShown}
                            shown={operationConsole.shown}
                        />
                    )}
                </div>
            </SidebarInset>
        </SidebarProvider>
    );
};

/**
 * The root route component: the console provider wrapped around the shell.
 *
 * Split in two because {@link StudioLayoutShell} CONSUMES the console context
 * (for the ⌘/Ctrl+` toggle and to render the drawer) — a component cannot read a
 * context it provides itself, and every panel under the routed outlet needs to
 * reach the same provider to offer "show in console" on a failure.
 */
const StudioLayout = (): ReactElement => (
    <OperationConsoleProvider>
        <StudioLayoutShell />
    </OperationConsoleProvider>
);

/**
 * Schema tab wrapper that lifts the optional `?table=<name>` search param off
 * the URL and forwards it to {@link SchemaViewer} as `initialTable`. This is the
 * landing target of the Insights "add the index" deep-link: navigating to
 * `/schema?table=posts` auto-expands `posts`'s index list. Read with
 * `strict: false` because the generic tab routes don't declare a typed search
 * schema; the param is coerced to a string or dropped.
 */
const SchemaRoutePanel = ({ initialShardKey, schemaEditable }: { readonly initialShardKey?: string; readonly schemaEditable?: boolean }): ReactElement => {
    const search: Record<string, unknown> = useSearch({ strict: false });
    const { table } = search;
    const initialTable = typeof table === "string" ? table : undefined;

    return <SchemaViewer initialShardKey={initialShardKey} initialTable={initialTable} schemaEditable={schemaEditable} />;
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
    analyticsQuery,
    basePath,
    dataEditable = false,
    functions,
    initialShardKey,
    openApiSpec,
    openRpcSpec,
    runAsIdentity = false,
    schemaEditable = false,
    scheduledCancel,
    scheduledCron,
    scheduledLoad,
}: StudioShellProps) => {
    const rootRoute = createRootRoute({ component: StudioLayout });

    const panels: Record<StudioTab, ReactElement> = {
        agents: <AgentsPanel initialShardKey={initialShardKey} />,
        analytics: <AnalyticsPanel runQuery={analyticsQuery} />,
        api: <ApiTab functions={functions} initialShardKey={initialShardKey} openApiSpec={openApiSpec} openRpcSpec={openRpcSpec} />,
        audit: <AuditPanel initialShardKey={initialShardKey} />,
        authAudit: <AuthAuditPanel />,
        authConfig: <AuthConfigPanel />,
        authSessions: <AuthSessionsPanel />,
        containers: <ContainersPanel />,
        dashboards: <DashboardsPanel initialShardKey={initialShardKey} />,
        data: <TableEditor editable={dataEditable} initialShardKey={initialShardKey} />,
        deploymentHealth: <DeploymentHealthPanel />,
        drains: <LogDrainsPanel />,
        export: <ExportImportPanel initialShardKey={initialShardKey} />,
        fanout: <FanoutPanel initialShardKey={initialShardKey} />,
        files: <FileBrowser />,
        kv: <KvBrowser />,
        flags: <FlagsPanel initialShardKey={initialShardKey} />,
        reactors: <ReactorsPanel initialShardKey={initialShardKey} />,
        functions: (
            <div className="flex flex-col gap-8">
                <FunctionStatsPanel functions={functions} initialShardKey={initialShardKey} />
                <FunctionRunner functions={functions} runAsIdentity={runAsIdentity} />
            </div>
        ),
        health: <HealthPanel initialShardKey={initialShardKey} />,
        home: <HomePanel initialShardKey={initialShardKey} />,
        insights: <InsightsPanel initialShardKey={initialShardKey} />,
        issues: <IssuesPanel initialShardKey={initialShardKey} />,
        logs: <LogsPanel initialShardKey={initialShardKey} />,
        traces: <TracesPanel initialShardKey={initialShardKey} />,
        evals: <EvalsPanel initialShardKey={initialShardKey} />,
        metrics: <MetricsPanel initialShardKey={initialShardKey} />,
        migrations: <MigrationsRoutePanel initialShardKey={initialShardKey} />,
        notifications: <NotificationsPanel />,
        organizations: <OrganizationsPanel />,
        permissions: <PermissionsPanel functions={functions} runAsIdentity={runAsIdentity} schemaEditable={schemaEditable} />,
        pitr: <PitrPanel initialShardKey={initialShardKey} />,
        mail: <MailPanel />,
        payments: <PaymentsPanel />,
        queues: <QueuesPanel />,
        realtime: (
            <div className="flex flex-col gap-8">
                {/* Server's view of the live connections… */}
                <SubscriptionsPanel initialShardKey={initialShardKey} />
                {/* …paired with the client's own belief, so a disagreement is visible. */}
                <SyncClientPanel />
            </div>
        ),
        rls: <RlsPanel />,
        schedule: <SchedulePanel loadCronJobs={scheduledCron} scheduledCancel={scheduledCancel} scheduledLoad={scheduledLoad} />,
        schema: <SchemaRoutePanel initialShardKey={initialShardKey} schemaEditable={schemaEditable} />,
        advisorHealth: <AdvisorHealthPanel />,
        security: <SecurityAdvisorPanel />,
        settings: <SettingsPanel initialShardKey={initialShardKey} />,
        sql: <SqlEditorPanel initialShardKey={initialShardKey} />,
        storageRules: <StorageRulesPanel />,
        users: <UsersPanel />,
        vectors: <VectorBrowser />,
        workflows: <WorkflowsPanel />,
    };

    // `/` renders the Home overview directly (no async redirect, so the first
    // paint is synchronous); `/home` renders it too, so both URLs are valid.
    const indexRoute = createRoute({
        component: () => panels.home,
        getParentRoute: () => rootRoute,
        path: "/",
    });

    // Routes that keep state in the URL validate + normalise it at the router
    // boundary, so malformed or legacy links are sanitised once and each panel
    // reads a typed, trustworthy search instead of a raw record.
    const tabRoutes = TABS.map((tab) =>
        createRoute({
            component: () => panels[tab],
            getParentRoute: () => rootRoute,
            path: `/${tab}`,
            validateSearch: SEARCH_VALIDATORS[tab],
        }),
    );

    const routeTree = rootRoute.addChildren([indexRoute, ...tabRoutes]);
    // Browser when a DOM `window` exists; an in-memory history under SSR/tests.
    // `"window" in globalThis` sidesteps both the typeof-undefined and the
    // always-defined-type lints that a `=== undefined` check trips.
    const history = "window" in globalThis ? createBrowserHistory() : createMemoryHistory({ initialEntries: ["/home"] });

    return createRouter({
        // When mounted under a prefix (e.g. the `/__lunora` dev route), the router
        // works in that subtree: `/__lunora` matches the index route and every
        // `navigate({ to: "/logs" })` resolves to `/__lunora/logs`, so navigation
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
    analyticsQuery,
    basePath,
    chrome,
    dataEditable,
    functions,
    initialShardKey,
    openApiSpec,
    openRpcSpec,
    runAsIdentity,
    schemaEditable,
    scheduledCancel,
    scheduledCron,
    scheduledLoad,
}: StudioShellProps): ReactElement => {
    // Rebuild the router only when a panel-affecting prop changes (keyed on the
    // individual props, not the unstable `props` identity), so navigation state
    // survives unrelated re-renders.
    const router = buildRouter({
        analyticsQuery,
        basePath,
        dataEditable,
        functions,
        initialShardKey,
        openApiSpec,
        openRpcSpec,
        runAsIdentity,
        schemaEditable,
        scheduledCancel,
        scheduledCron,
        scheduledLoad,
    });

    return (
        <StudioChromeContext value={chrome ?? null}>
            <RouterProvider router={router} />
        </StudioChromeContext>
    );
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
export const Studio = ({ i18n, locale, ...shellProps }: StudioProps): ReactElement => {
    // The header's <ThemeToggle> needs a theme context. `StudioApp` mounts one;
    // a bare `<Studio>` embed (a public export) gets its own here — inherit-or-own,
    // exactly like the i18n provider below.
    const shell = (
        <EnsureThemeProvider>
            {/* eslint-disable-next-line react/jsx-props-no-spreading -- forwarding a closed, typed prop set: hand-writing this list is how `scheduledCron` went missing one layer up. The spread still lands as individual props, so the shell's own memoisation keys on each one, not on this object's identity. */}
            <StudioShell {...shellProps} />
        </EnsureThemeProvider>
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

export type { StudioChrome, StudioProps };

export { type StudioTab } from "./nav-types";
