/**
 * The studio's navigation taxonomy: which pages exist and which domain each one
 * belongs to.
 *
 * Its own module so the label maps (`nav-labels.ts`) can name these types without
 * importing `studio.tsx`, which pulls in every lazy panel behind it.
 */

/** Identifier for each built-in studio tab. */
type StudioTab =
    | "agents"
    | "analytics"
    | "api"
    | "audit"
    | "authAudit"
    | "authConfig"
    | "authSessions"
    | "containers"
    | "dashboards"
    | "data"
    | "deploymentHealth"
    | "drains"
    | "export"
    | "fanout"
    | "files"
    | "flags"
    | "functions"
    | "health"
    | "home"
    | "insights"
    | "issues"
    | "kv"
    | "logs"
    | "mail"
    | "metrics"
    | "migrations"
    | "notifications"
    | "organizations"
    | "payments"
    | "permissions"
    | "pitr"
    | "queues"
    | "realtime"
    | "rls"
    | "schedule"
    | "schema"
    | "security"
    | "settings"
    | "sql"
    | "storageRules"
    | "traces"
    | "users"
    | "vectors"
    | "workflows";

/**
 * Stable identifier for each sidebar domain; the display label is localised.
 * Domains group the pages by concern — Overview · Database · Functions · Auth ·
 * Storage · Observability (live logs + metrics) · Advisors · Operations (jobs,
 * mail, drains, payments) · Settings — so the data/SQL surfaces sit together and
 * monitoring is separated from the things you run.
 */
type NavGroupKey = "advisors" | "auth" | "database" | "functions" | "observability" | "operations" | "overview" | "settings" | "storage";

/** One icon-rail domain and the sub-pages its secondary nav lists. */
type NavGroup = { readonly key: NavGroupKey; readonly tabs: ReadonlyArray<StudioTab> };

export type { NavGroup, NavGroupKey, StudioTab };
