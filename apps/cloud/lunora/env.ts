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
    /** Bearer token for R2 SQL (archived-span read-back). Absent → the archive read no-ops. A secret. */
    R2_SQL_TOKEN: v.optional(v.string()),

    /**
     * 32-byte hex master key for envelope encryption (§7). Shared with the edge
     * `/v1/secrets` + `/v1/cloudflare-billing` routes; `cloudflareBilling.summary`
     * reads it to *decrypt* a BYO org's stored Billing-Read token before the
     * Billable-Usage read. Absent → the costs read no-ops to a "not configured" view.
     */
    SECRET_ENCRYPTION_KEY: v.optional(v.string()),
    /** R2 bucket (warehouse) name backing the span archive's Iceberg table. */
    TELEMETRY_BUCKET_NAME: v.optional(v.string()),
    /** AE dataset the tenant `ctx.metrics.*` measurements land in (`/v1/metrics`). Defaults to `TELEMETRY`. */
    TELEMETRY_DATASET: v.optional(v.string()),
    /** Iceberg table the span archive lands in (`namespace.table`); defaults to `default.telemetry_spans`. */
    TELEMETRY_SPAN_TABLE: v.optional(v.string()),
});
