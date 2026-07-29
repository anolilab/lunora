import { useMemo } from "react";

import { useT } from "../i18n/i18n-context";
import type { NavGroupKey, StudioTab } from "./nav-types";

/** The localised strings the sidebar, breadcrumb, command palette, and page header share. */
interface NavLabels {
    /** Domain name, for the rail and the breadcrumb's first crumb. */
    readonly groupLabel: Record<NavGroupKey, string>;
    /** One-line description of each page, shown as the nav item's tooltip. */
    readonly tabDescription: Record<StudioTab, string>;
    /** Page name, for the nav item, the breadcrumb, the palette, and the document title. */
    readonly tabLabel: Record<StudioTab, string>;
}

/**
 * Every navigation string in one place, resolved against the active locale.
 *
 * Lifted out of `StudioLayoutShell` because ~150 lines of translation calls
 * buried the ~40 lines of behaviour that component actually has. Nothing here is
 * logic — it is the studio's copy, and it reads better as a table than as a
 * preamble to a layout.
 */
const useNavLabels = (): NavLabels => {
    const t = useT();

    // `tabLabel` is MEMOISED, unlike its two siblings: the shell feeds it to the
    // document-title effect as a dependency, so a fresh object every render would
    // re-set `document.title` on every render. `t` is stable per locale, so this
    // rebuilds exactly when the locale changes.
    const tabLabel = useMemo(() => {
        return {
            agents: t("Agents"),
            analytics: t("Analytics"),
            api: t("API"),
            audit: t("Audit"),
            authAudit: t("Auth audit"),
            authConfig: t("Configuration"),
            authSessions: t("Sessions"),
            containers: t("Containers"),
            dashboards: t("Dashboards"),
            data: t("Data"),
            deploymentHealth: t("Deployment health"),
            drains: t("Log drains"),
            export: t("Export / Import"),
            fanout: t("Fan-out"),
            files: t("Files"),
            flags: t("Flags"),
            functions: t("Functions"),
            health: t("Health"),
            home: t("Home"),
            insights: t("Performance"),
            issues: t("Issues"),
            kv: t("KV"),
            logs: t("Logs"),
            metrics: t("Metrics"),
            migrations: t("Migrations"),
            notifications: t("Notifications"),
            organizations: t("Organizations"),
            pitr: t("Time Travel"),
            mail: t("Mail"),
            payments: t("Payments"),
            permissions: t("Permissions"),
            queues: t("Queues"),
            realtime: t("Realtime"),
            rls: t("RLS Policies"),
            schedule: t("Scheduled"),
            schema: t("Schema"),
            security: t("Security"),
            settings: t("Settings"),
            sql: t("SQL editor"),
            traces: t("Traces"),
            storageRules: t("Access Rules"),
            users: t("Users"),
            vectors: t("Vectors"),
            workflows: t("Workflows"),
        };
    }, [t]);

    const groupLabel = {
        advisors: t("Advisors"),
        auth: t("Auth"),
        database: t("Database"),
        functions: t("Functions"),
        observability: t("Observability"),
        operations: t("Operations"),
        overview: t("Overview"),
        settings: t("Settings"),
        storage: t("Storage"),
    };

    // One-line section descriptions for the page header.
    const tabDescription = {
        agents: t("Inspect agent threads, message timelines, tool calls, and token usage."),
        analytics: t("Usage and latency from Analytics Engine — request volume, p50/p95, and hot shards."),
        api: t("Interactive OpenAPI reference and copy-paste snippets for your functions."),
        audit: t("A durable log of admin state-changing operations."),
        authAudit: t("Authentication and security events — sign-ins, MFA, and session changes."),
        authConfig: t("Enabled plugins and session config (read-only)."),
        authSessions: t("Browse and revoke active sessions across all users."),
        containers: t("Live Cloudflare Containers — current lifecycle state per instance from the log stream."),
        dashboards: t("Chart widgets backed by saved read-only SQL queries."),
        data: t("Browse and edit rows across your shard and global tables."),
        deploymentHealth: t("Live liveness, readiness, and per-binding health from the deployment's /_lunora/health endpoint."),
        drains: t("Forward logs to Logpush, Tail Workers, or a webhook collector."),
        export: t("Export a shard to NDJSON, or import rows from it."),
        fanout: t("Realtime fan-out cost and per-topic subscriber counts for this shard."),
        files: t("Browse objects in your R2 storage buckets."),
        flags: t("Inspect feature flags and their live evaluation under a targeting context."),
        functions: t("Run registered queries, mutations, and actions."),
        health: t("At-a-glance connection, error, and shard signals."),
        home: t("Connection, health, and advisor summary for your deployment."),
        insights: t("Surface slow functions, error spikes, and cache problems."),
        issues: t("Grouped error triage — Worker throws and container crashes folded by fingerprint."),
        logs: t("A live stream of recent function logs."),
        metrics: t("Per-shard health and aggregate metrics."),
        migrations: t("Review migration status and run them."),
        notifications: t("Registered push devices — endpoint, kind, last-send status, and delivery errors."),
        organizations: t("Browse and manage organizations, members, and invitations."),
        pitr: t("Restore a shard to a point in the last 30 days."),
        mail: t("Email your app sent, captured in dev."),
        payments: t("Synced customers, subscriptions, and webhook events."),
        permissions: t("Inspect access policies per table, and probe a function as any identity."),
        queues: t("Inspect declared Cloudflare Queues — their producer bindings, consumer mode, and dead-letter queue."),
        realtime: t("Active WebSocket subscriptions on this shard."),
        rls: t("Inspect row-level-security policies and roles, per table."),
        schedule: t("Inspect and cancel scheduled jobs."),
        schema: t("Inspect each table and its columns."),
        security: t("Review admin gates, credentials, and log redaction."),
        settings: t("Read-only deployment config — vars, secrets, and bindings."),
        sql: t("Run read-only SQL against a shard."),
        kv: t("Browse and edit key-value pairs in your Workers KV namespaces."),
        storageRules: t("Inspect storage access rules — per bucket, operation, and key prefix."),
        traces: t("Recent ctx.trace waterfalls for this shard — the drill-down from a log line."),
        users: t("Manage auth users — roles, bans, sessions, and identity."),
        vectors: t("Browse Vectorize indexes and run similarity searches."),
        workflows: t("Inspect declared Cloudflare Workflows and their bindings."),
    };

    return { groupLabel, tabDescription, tabLabel };
};

export { useNavLabels };
export type { NavLabels };
