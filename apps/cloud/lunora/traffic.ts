import { createTrafficReader, DEFAULT_TRAFFIC_WINDOW_MS, MAX_TRAFFIC_SCRIPTS } from "../src/telemetry/traffic-read";
import { action, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";
import { rateLimit } from "./guards";
import { boundedString, LIMITS } from "./validators";

/**
 * The Traffic tab — request analytics over the tenant traffic the dispatcher
 * already meters.
 *
 * Two reads with deliberately different sources, because they answer different
 * questions and only one of them can be answered honestly by each store:
 *
 * - {@link snapshot} is an **action** over Analytics Engine (`src/telemetry/traffic-read.ts`).
 *   AE is where the per-request data point lands, it retains ~90 days, and it is
 *   the only store that can answer "of 110k requests, how many came from Brazil"
 *   without keeping 110k rows in D1. It is sampled, so it gives counts and means.
 * - {@link live} is a **query** over the `observations` span store. Those rows are
 *   unsampled and reactive, which makes them the right source for both the live
 *   request stream and true latency percentiles — the two things a sampled store
 *   cannot give you.
 *
 * Both fail **open** to an empty view rather than throwing: a dashboard read path
 * that errors because a cell has not provisioned AE credentials yet is a worse
 * outcome than an empty panel, and that is the convention `metrics.list` and
 * `traces.listArchived` already set here.
 */

/** The env keys the snapshot action reads off `ctx.env` (the validated `lunora/env.ts` contract). */
interface TrafficEnv {
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_API_TOKEN?: string;
    USAGE_ANALYTICS_DATASET?: string;
}

/** The dataset the dispatcher meters into; matches `dispatcher.wrangler.jsonc` and `src/server.ts`. */
const DEFAULT_USAGE_DATASET = "lunora_tenant_usage";

/** The traffic snapshot as the dashboard consumes it. Mirrors the reader's shape so codegen inlines it. */
interface TrafficSnapshotView {
    /** Request share per country (ISO-3166 alpha-2 from `request.cf.country`), biggest first. */
    countries: { key: string; requests: number; share: number }[];
    /** Domains the traffic arrived on — the source list for the tab's domain filter. */
    hostnames: { key: string; requests: number; share: number }[];
    /** Id-collapsed route labels (`/orders/:id`), biggest first. */
    routes: { key: string; requests: number; share: number }[];
    /** Requests, bytes and mean duration per time bucket. */
    series: { avgDurationMs: number; bytes: number; requests: number; t: number }[];
    /** Response classes with their exact codes nested. */
    statuses: { class: string; codes: { code: string; requests: number }[]; requests: number }[];
    /** Total requests across the returned country rows. */
    totalRequests: number;
}

/** The empty view every degraded path returns — no credentials, no deployments, or a failed read. */
const EMPTY_VIEW: TrafficSnapshotView = { countries: [], hostnames: [], routes: [], series: [], statuses: [], totalRequests: 0 };

/**
 * Request analytics for the org over `[from, to]`, optionally filtered to one
 * domain.
 *
 * **How the org scope works, and why it is the query shape rather than a filter.**
 * The metering dataset has no organization dimension — it is keyed on the script
 * name, because that is what the billing meter needs. So this resolves the org's
 * own deployments to script names first and the reader filters `index1 IN (…)`.
 * An org that has deployed nothing reads nothing, and an org can never name a
 * script it does not own, so cross-tenant leakage is structurally impossible here
 * rather than depending on a `WHERE` clause staying correct through future edits.
 *
 * An **action**, not a query: the read is a `fetch` over the AE SQL API and the
 * account id / API token live on `ctx.env`, both action-only. Members only.
 */
export const snapshot = action
    .use(rateLimit("archive"))
    .input({
        from: v.optional(v.number()),
        hostname: v.optional(boundedString(LIMITS.name)),
        organizationId: v.id("organizations"),
        to: v.optional(v.number()),
    })
    .action(async ({ ctx: context, args }): Promise<TrafficSnapshotView> => {
        await assertMember(context, args.organizationId);

        const environment = (context.env ?? {}) as TrafficEnv;

        // Fail open: no AE account creds → no traffic view (the same 🌐-gated
        // posture as every other read-back here).
        if (!environment.CLOUDFLARE_ACCOUNT_ID || !environment.CLOUDFLARE_API_TOKEN) {
            return EMPTY_VIEW;
        }

        // Newest first, so the cap keeps the releases an operator is actually
        // looking at. Unordered, an org past the cap got an ARBITRARY subset —
        // a different one run to run — and the Traffic tab under-reported without
        // saying so, which bites precisely the large orgs the comment below is
        // about.
        const { page } = await context.db.deployments.findMany({
            limit: MAX_TRAFFIC_SCRIPTS,
            orderBy: [{ createdAt: "desc" }],
            where: { organizationId: args.organizationId },
        });

        // Every release the org has ever cut, not just the live one: a window that
        // spans a deploy must still count the traffic the superseded script served,
        // or the chart shows a cliff at each release that never happened.
        const scriptNames = [...new Set(page.map((row) => row.scriptName).filter((name) => name !== ""))];

        if (scriptNames.length === 0) {
            return EMPTY_VIEW;
        }

        const reader = createTrafficReader({
            accountId: environment.CLOUDFLARE_ACCOUNT_ID,
            apiToken: environment.CLOUDFLARE_API_TOKEN,
            dataset: environment.USAGE_ANALYTICS_DATASET ?? DEFAULT_USAGE_DATASET,
            fetch: context.fetch,
        });

        const to = args.to ?? Date.now();
        const from = args.from ?? to - DEFAULT_TRAFFIC_WINDOW_MS;

        try {
            const result = await reader.readSnapshot({
                from,
                scriptNames,
                to,
                ...(args.hostname === undefined ? {} : { hostname: args.hostname }),
            });

            // Returned directly: the reader's snapshot and this action's wire view are
            // the same shape, and the return annotation is what codegen reads — three
            // field-for-field `map`s in between were indirection, not a boundary.
            return result;
        } catch {
            // AE SQL unreachable / dataset absent — degrade to an empty view.
            return EMPTY_VIEW;
        }
    });

/** Spans scanned before folding into the live stream (bounds the read; matches the traces list). */
const LIVE_SCAN_LIMIT = 500;

/** Default rows in the live stream — enough to fill a tail pane without paging. */
const DEFAULT_LIVE_LIMIT = 50;

/** Hard cap on live-stream rows one read returns. */
const MAX_LIVE_LIMIT = 200;

/** One request in the live stream. */
interface LiveRequestView {
    durationMs: number;
    /** `error` when the span's OTLP status was an error, else `info`. */
    level: string;
    name: string;
    serviceName?: string;
    startedAt: number;
    statusMessage?: string;
    traceId: string;
}

/** Latency percentiles over the same unsampled window, in ms. */
interface LatencyView {
    count: number;
    p50: number;
    p95: number;
    p99: number;
}

/** The live view: the tail plus the percentiles computed from the same rows. */
interface LiveTrafficView {
    latency: LatencyView;
    requests: LiveRequestView[];
}

/**
 * Is this span a request, rather than work inside one?
 *
 * `== null` is load-bearing. An absent optional column reads back from the store
 * as `null`, not `undefined`, so a strict `=== undefined` here drops every root
 * span and the live stream renders permanently empty while the rows sit in the
 * table — a failure with no error anywhere, which is why it gets its own named
 * predicate and its own test. The rest of the control plane checks absent
 * optionals the same loose way (`deploy_keys.verify`, `findActiveIngestKey`).
 *
 * Only ROOT spans count. A span with a parent is work inside a request, and
 * counting it would inflate the request rate by the app's internal fan-out and
 * drag the percentiles toward whatever the smallest inner span is.
 */
export const isRequestSpan = (span: { parentSpanId?: null | string }): boolean => span.parentSpanId == null;

/**
 * Nearest-rank percentile over an ascending array of durations.
 *
 * Nearest-rank rather than interpolated: every value returned is a duration some
 * request actually took, which is what an operator comparing the number against a
 * trace in the list below expects to be able to find. Interpolation would produce
 * a p95 that appears nowhere in the data.
 */
export const percentile = (ascending: ReadonlyArray<number>, fraction: number): number => {
    if (ascending.length === 0) {
        return 0;
    }

    const rank = Math.ceil(fraction * ascending.length);

    return ascending[Math.min(Math.max(rank, 1), ascending.length) - 1] ?? 0;
};

/**
 * The live request stream plus true latency percentiles for the org.
 *
 * A plain **query**, which is the whole point: Lunora queries are reactive, so a
 * client subscribed to this gets each new request pushed as its span lands — the
 * "live" half needs no polling, no websocket of its own, and no new ingest path.
 * The rows are the same unsampled `observations` the Traces tab reads.
 *
 * Only ROOT spans count as requests. A span with a parent is work inside a
 * request, and counting it would inflate the request rate by the app's internal
 * fan-out and drag the percentiles toward whatever the smallest inner span is.
 */
export const live = query
    .input({
        limit: v.optional(v.number()),
        organizationId: v.id("organizations"),
    })
    .query(async ({ ctx: context, args }): Promise<LiveTrafficView> => {
        await assertMember(context, args.organizationId);

        const limit = Math.min(Math.max(Math.trunc(args.limit ?? DEFAULT_LIVE_LIMIT), 1), MAX_LIVE_LIMIT);

        const { page } = await context.db.observations.findMany({
            limit: LIVE_SCAN_LIMIT,
            orderBy: [{ startedAt: "desc" }],
            where: { organizationId: args.organizationId },
        });

        const roots = page.filter((row) => isRequestSpan(row));
        // Percentiles come from the whole scanned window, not the truncated list —
        // a p99 over the 50 rows the pane happens to show is a different statistic
        // from a p99 over the window, and the smaller one is the misleading one.
        const ascending = roots.map((row) => row.durationMs).toSorted((a, b) => a - b);

        return {
            latency: {
                count: ascending.length,
                p50: percentile(ascending, 0.5),
                p95: percentile(ascending, 0.95),
                p99: percentile(ascending, 0.99),
            },
            requests: roots.slice(0, limit).map((row) => {
                return {
                    durationMs: row.durationMs,
                    level: row.level,
                    name: row.name,
                    startedAt: row.startedAt,
                    traceId: row.traceId,
                    // Same `== null` reasoning as the root filter above: a strict
                    // check here would spread `serviceName: null` onto a field the
                    // wire view declares as `string | undefined`.
                    ...(row.serviceName == null ? {} : { serviceName: row.serviceName }),
                    ...(row.statusMessage == null ? {} : { statusMessage: row.statusMessage }),
                };
            }),
        };
    });
