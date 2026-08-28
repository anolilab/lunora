/**
 * Platform metering source (CLOUD-PLAN.md §4) — a thin domain layer over
 * `@lunora/bindings/analytics`. The dispatcher emits one request data point per tenant
 * request to a Cloudflare Analytics Engine dataset (the cheap, fire-and-forget
 * request-path source); a control-plane rollup reads it back through the AE SQL
 * API and folds it into the `platformUsage` ledger. The write helper no-ops when
 * the binding is absent; the reader is a port with an HTTP impl (built on
 * `createAnalyticsSqlClient`) so the rollup is unit-testable with a fake fetch.
 */
import type { AnalyticsEngineDatasetLike } from "@lunora/bindings/analytics";
import { createAnalytics, createAnalyticsSqlClient } from "@lunora/bindings/analytics";

export type { AnalyticsEngineDatasetLike } from "@lunora/bindings/analytics";

/** Path segments kept in a route label; deeper ones collapse to `/…`. Bounds the tag length without losing the part that identifies the endpoint. */
const MAX_ROUTE_SEGMENTS = 4;

/** A segment that identifies a specific RECORD rather than an endpoint: numeric, uuid/hex, or simply too long to be a route word. */
const IDENTIFIER_SEGMENT = /^(?:\d+|[\da-f]{8,}|[\w-]{22,})$/iu;

/**
 * Collapse a request path to a low-cardinality route label — `/orders/:id/items`.
 *
 * Cardinality is the whole point. Recording the raw path makes every record id
 * its own dimension, so the dataset grows without bound and grouping by route
 * answers nothing; the label has to name the ENDPOINT, which is the thing an
 * operator can act on. Segments that look like identifiers become `:id`, and
 * the depth is capped so a pathological URL can't mint a giant tag.
 */
export const normalizeRoutePath = (pathname: string): string => {
    const segments = pathname.split("/").filter((segment) => segment !== "");

    if (segments.length === 0) {
        return "/";
    }

    const kept = segments.slice(0, MAX_ROUTE_SEGMENTS).map((segment) => (IDENTIFIER_SEGMENT.test(segment) ? ":id" : segment.toLowerCase()));
    const suffix = segments.length > MAX_ROUTE_SEGMENTS ? "/…" : "";

    return `/${kept.join("/")}${suffix}`;
};

/** Status class of a response — `2xx`/`4xx`/`5xx`. Four possible values, so it costs nothing to group on, unlike the raw code. */
export const statusClass = (status: number): string => `${String(Math.floor(status / 100))}xx`;

/** Longest hostname kept as a dimension. Bounds the tag; a name past this is a probe, not a customer domain. */
const MAX_HOSTNAME_LENGTH = 100;

/**
 * Normalize a request hostname to a dimension value — lowercased, port stripped,
 * length-capped.
 *
 * Unlike route and status class, hostname is not bounded by construction: anything
 * resolving to the dispatcher arrives here, including scanner traffic aimed at
 * hostnames nobody registered. The cap is what stops a probe run from minting
 * unbounded dimension values; the domains table remains the source of truth for
 * which of these is a real custom domain.
 */
export const normalizeHostname = (hostname: string): string => hostname.toLowerCase().split(":")[0]?.slice(0, MAX_HOSTNAME_LENGTH) ?? "";

/**
 * Emit one request data point: `blob1=script`, `blob2=plan`, `blob3=outcome`,
 * `blob4=route`, `blob5=country`, `blob6=hostname`, `blob7=status`,
 * `double1=count`, `double2=durationMs`, `double3=responseBytes`.
 *
 * **Positions are append-only.** `blob1`/`blob2` keep their positions because the
 * usage rollup's SQL reads `blob1 AS scriptName` and the billing ledger derives
 * charges from it; every later widening appends rather than renumbering, because
 * a shifted position silently rewrites what customers are charged and no test
 * downstream would notice. The same reasoning pins `double1` as the count.
 *
 * The `outcome` and `route` dimensions are what make per-deployment health
 * charts possible: billing metrics can say a tenant's requests rose, but never
 * which endpoint rose or whether it started failing. There is deliberately no
 * separate version blob — a blue/green alias already resolves to the VERSIONED
 * script name, so `blob1` carries the deploy identity for exactly the traffic
 * that has one.
 *
 * `country`/`hostname`/`status` answer the three questions the class dimensions
 * cannot: WHERE the traffic came from, WHICH domain it arrived on (so a tenant
 * running several can tell them apart), and WHICH code inside a class — a 429 and
 * a 404 are both `4xx` and mean entirely different things. `durationMs` and
 * `responseBytes` are recorded as doubles so a wide-window average costs one
 * query; exact percentiles are NOT read from here, because AE rows are sampled
 * (see `readTrafficSeries`).
 */
export const recordRequestUsage = (
    dataset: AnalyticsEngineDatasetLike | undefined,
    input: {
        bytes?: number;
        country?: string;
        durationMs?: number;
        hostname?: string;
        outcome?: string;
        plan: string;
        route?: string;
        scriptName: string;
        status?: number;
    },
): void => {
    if (!dataset) {
        return;
    }

    createAnalytics(dataset).writeDataPoint({
        blobs: [
            input.scriptName,
            input.plan,
            input.outcome ?? "unknown",
            input.route ?? "unknown",
            input.country ?? "unknown",
            input.hostname ?? "unknown",
            input.status === undefined ? "unknown" : String(input.status),
        ],
        doubles: [1, input.durationMs ?? 0, input.bytes ?? 0],
        indexes: [input.scriptName],
    });
};

/** A row read back from the AE dataset, summed per script over a window. */
export interface AnalyticsUsageRow {
    requests: number;
    scriptName: string;
}

/** Port: read aggregated request usage since `sinceMs` from the metering source. */
export interface AnalyticsUsageReader {
    readRequestUsage: (sinceMs: number) => Promise<AnalyticsUsageRow[]>;
}

interface AnalyticsReaderOptions {
    accountId: string;
    apiToken: string;
    /** AE dataset name the dispatcher writes to. */
    dataset: string;
    fetch?: typeof globalThis.fetch;
}

/**
 * HTTP `AnalyticsUsageReader` over the Analytics Engine SQL API (via
 * `@lunora/bindings/analytics`'s read client). Runs at the edge (needs the account API
 * token); the SQL groups request counts per script over the window.
 *
 * **The aggregation must be `SUM(_sample_interval)`, not `SUM(double1)`.**
 * Analytics Engine applies weighted adaptive sampling at write time: past a
 * write rate it keeps one row in place of many, and each retained row carries
 * the `_sample_interval` it stands in for. Summing `double1` bare therefore
 * under-counts by the sample factor — and sampling engages precisely when a
 * tenant's request rate spikes, i.e. in the runaway/compromised-account case
 * the spend cap downstream of this ledger exists to stop. Cloudflare's own
 * usage-based-billing recipe uses exactly this form.
 *
 * Because the dispatcher writes `index1 = scriptName` and one data point per
 * request, summing the sample interval grouped by that index is not an
 * approximation — it is the exact request count. Grouping on `blob1` would have
 * been the sampled-and-therefore-approximate form; the index is also what makes
 * per-tenant sampling equitable, so one enormous tenant cannot sample a small
 * tenant's rows down to zero.
 */
export const createHttpAnalyticsReader = (options: AnalyticsReaderOptions): AnalyticsUsageReader => {
    const sql = createAnalyticsSqlClient({ accountId: options.accountId, apiToken: options.apiToken, fetch: options.fetch });

    return {
        readRequestUsage: async (sinceMs) => {
            const sinceSeconds = Math.floor(sinceMs / 1000);
            const result = await sql.query(
                `SELECT index1 AS scriptName, SUM(_sample_interval) AS requests FROM ${options.dataset} WHERE timestamp > toDateTime(${String(sinceSeconds)}) GROUP BY scriptName`,
            );

            return result.rows.map((row) => {
                return {
                    requests: typeof row.requests === "number" ? row.requests : Number(row.requests ?? 0),
                    scriptName: typeof row.scriptName === "string" ? row.scriptName : "",
                };
            });
        },
    };
};
