import { defineEnv, v } from "@lunora/server";

/**
 * The control-plane Worker's typed env contract (`defineEnv`). Codegen validates
 * the worker `env` through this accessor and wires the result onto `ctx.env`, so
 * actions can read the observability **read-back** config the queries/mutations
 * can't reach (queries/mutations run in the DO with no `fetch`).
 *
 * Everything is `v.optional(...)`, so `ctx.env` fails **open**: the archived-span
 * R2-SQL read-back (`traces.getArchived`) and the Analytics-Engine metric-series
 * read-back (`metrics.list`) no-op to empty until a cell provisions the token +
 * account id — the same 🌐-gated posture as the write side (`store.ts`).
 */
export const env = defineEnv({
    /** Cloudflare account id — the path segment for the R2-SQL + AE-SQL read endpoints. */
    CLOUDFLARE_ACCOUNT_ID: v.optional(v.string()),
    /** Cloudflare API token with Analytics-Engine read scope (metric-series read-back). A secret. */
    CLOUDFLARE_API_TOKEN: v.optional(v.string()),

    /**
     * Edge-block suspension settings (plan 365 W8), read here only so the
     * studio's Domains tab can say which mode this cell runs in
     * (`domains.edgeBlockMode`, `src/domains/edge-block-mode.ts`); the sweep reads
     * the Worker env directly.
     */
    LUNORA_EDGE_BLOCK_DELETE_HOSTNAMES: v.optional(v.string()),
    LUNORA_SAAS_ZONE_ID: v.optional(v.string()),
    LUNORA_SUSPENDED_HOSTS_LIST_ID: v.optional(v.string()),

    /**
     * GitHub App id, and its PKCS#8 private key. The pair authenticates as the App
     * so the build dispatcher can mint an installation token — used both to fetch a
     * repository's source and to write the build's outcome back as a commit status.
     * Absent → builds report to nobody (and cannot fetch source). The key is a
     * secret; it must be PKCS#8, not the PKCS#1 form GitHub hands you.
     */
    GITHUB_APP_ID: v.optional(v.string()),
    GITHUB_APP_PRIVATE_KEY: v.optional(v.string()),

    /**
     * The apex customer boxes' default hostnames live under
     * (`{alias}.{slug}.{LUNORA_BOX_DOMAIN}`, plan 458 D9). Read here only so the
     * studio can show a box's hostname (`boxes.domain`); the box routes and
     * the celld-vps driver read the Worker env directly. Defaults to `boxes.lunora.app`.
     */
    LUNORA_BOX_DOMAIN: v.optional(v.string()),

    /**
     * This control plane's public origin. Read here so the studio's box install
     * command names it (`lunora-hostd enrol --control-plane`, `boxes.createEnrolment`);
     * the routes, the box session and the scheduler read the Worker env directly.
     */
    LUNORA_ORIGIN_URL: v.optional(v.string()),
    /** The platform apex (`{alias}.{this}`); read by `edge.firewall` to name an org's hostnames. Defaults to `lunora.app`. */
    LUNORA_APP_DOMAIN: v.optional(v.string()),

    /**
     * How many per-org edge rules of each kind this cell's zone may hold (plan 365
     * W7). Unset → 0 → the setting is shown as unavailable. Set only to what the
     * zone's plan allows: host-scoped DDoS overrides need Enterprise with Advanced
     * DDoS (10 rules), host-scoped rate limits Business or above.
     */
    LUNORA_DDOS_OVERRIDE_BUDGET: v.optional(v.string()),
    LUNORA_RATE_LIMIT_RULE_BUDGET: v.optional(v.string()),

    /** The SaaS zone (zone of `LUNORA_APP_DOMAIN`) the firewall-events read queries. Absent → `edge.firewall` answers unconfigured. */
    LUNORA_SAAS_ZONE_ID: v.optional(v.string()),

    /** Bearer token for R2 SQL (archived-span read-back). Absent → the archive read no-ops. A secret. */
    R2_SQL_TOKEN: v.optional(v.string()),

    /**
     * 32-byte hex master key for envelope encryption (§7). Shared with the edge
     * `/v1/secrets` + `/v1/cloudflare-accounts` routes; `cloudflareAccounts.costs`
     * reads it to *decrypt* a connected account's token before the
     * Billable-Usage read. Absent → the costs read no-ops to a "not configured" view.
     */
    SECRET_ENCRYPTION_KEY: v.optional(v.string()),
    /** R2 bucket (warehouse) name backing the span archive's Iceberg table. */
    TELEMETRY_BUCKET_NAME: v.optional(v.string()),
    /** AE dataset the tenant `ctx.metrics.*` measurements land in (`/v1/metrics`). Defaults to `TELEMETRY`. */
    TELEMETRY_DATASET: v.optional(v.string()),
    /** Iceberg table the span archive lands in (`namespace.table`); defaults to `default.telemetry_spans`. */
    TELEMETRY_SPAN_TABLE: v.optional(v.string()),
    /** AE dataset the dispatcher meters tenant requests into (`traffic.snapshot`). Defaults to `lunora_tenant_usage`. */
    USAGE_ANALYTICS_DATASET: v.optional(v.string()),
});
