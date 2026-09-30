/**
 * Read-back of tenant **request traffic** from the metering Analytics Engine
 * dataset — the source behind the Traffic tab (visitors by country, top paths,
 * response codes, and volume/bytes/latency over time).
 *
 * The write side is `src/metering/analytics.ts`'s `recordRequestUsage`, called
 * once per dispatched request:
 * `blob1=script`, `blob2=plan`, `blob3=outcome`, `blob4=route`, `blob5=country`,
 * `blob6=hostname`, `blob7=status`, `double1=count`, `double2=durationMs`,
 * `double3=responseBytes`, `index1=script`.
 *
 * **Org scoping is by script name, and that is deliberate.** The dataset carries
 * no organization dimension — it is the billing meter, keyed on `index1=script`.
 * So every read here takes the caller's resolved script names and filters
 * `index1 IN (…)`. A caller that cannot name a script cannot read a row, which
 * makes cross-tenant leakage a property of the query shape rather than something
 * a `WHERE` clause has to be trusted to remember. It is also what makes a
 * single-deployment health chart free: pass one script name.
 *
 * **Sampling — the honest limit.** AE retains one row in place of many past a
 * write rate, each carrying the `_sample_interval` it stands in for. Every
 * aggregate below is therefore sample-weighted: counts are `SUM(_sample_interval)`
 * (exact, because the dispatcher writes exactly one point per request), summed
 * values are `SUM(value * _sample_interval)`, and averages divide the two. What
 * you cannot get from here is a true percentile — a p95 over sampled rows is a
 * number nobody should page on, so latency percentiles are read from the
 * unsampled `observations` span store instead (see `lunora/traffic.ts`).
 *
 * Query building and row folding are pure and unit-tested; the AE SQL client is
 * injected so the read path never touches the network in tests.
 */
import type { AnalyticsSqlClient } from "@lunora/bindings/analytics";
import { createAnalyticsSqlClient } from "@lunora/bindings/analytics";

/** Default look-back when the caller gives no `from` (24 h) — matches the metrics reader. */
export const DEFAULT_TRAFFIC_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Default bucket width for the volume series (15 min) — ~96 points over 24 h. */
export const DEFAULT_TRAFFIC_BUCKET_MS = 15 * 60 * 1000;

/** Hard cap on rows returned per dimension breakdown (bounds the response and the UI list). */
export const MAX_TRAFFIC_ROWS = 40;

/** Ceiling on script names accepted in one read — bounds the generated `IN (…)` list. */
export const MAX_TRAFFIC_SCRIPTS = 200;

/**
 * Escape a string for single-quoted SQL — the AE SQL API takes raw text, no bound
 * params.
 *
 * Backslash first, then the quote. The AE SQL API is ClickHouse, which honours
 * backslash escapes inside string literals, so doubling the quote alone leaves a
 * value ending in a backslash able to escape its own closing quote. That is not
 * reachable today — the only caller-supplied term (`hostname`) is last in the
 * WHERE clause, with no following quote to break into — but that is an accident
 * of clause order, not a property, and the next predicate appended here would
 * turn it into a real injection.
 */
const quote = (value: string): string => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;

/**
 * The dimension a breakdown groups on, mapped to its blob position.
 *
 * Named rather than passed as a raw column so a caller can never interpolate an
 * arbitrary expression into the `GROUP BY` — the values are a closed set here,
 * not a string that arrives from a request.
 */
export const TRAFFIC_DIMENSIONS = {
    country: "blob5",
    hostname: "blob6",
    route: "blob4",
    status: "blob7",
} as const;

/** A groupable traffic dimension. */
export type TrafficDimension = keyof typeof TRAFFIC_DIMENSIONS;

/** Shared filters for every traffic read: the window, the org's scripts, and an optional domain. */
export interface TrafficFilter {
    /** AE dataset the dispatcher meters into. */
    dataset: string;
    /** Restrict to one hostname (the Traffic tab's domain filter); omitted → all domains. */
    hostname?: string;
    /** The org's script names — the org scope. An empty list can match nothing. */
    scriptNames: ReadonlyArray<string>;
    /** Lower bound (epoch seconds, exclusive). */
    sinceSec: number;
    /** Upper bound (epoch seconds, inclusive). */
    toSec: number;
}

/** The `WHERE` shared by every query here: window, org scope, optional domain. */
const whereClause = (filter: TrafficFilter): string => {
    const scripts = filter.scriptNames
        .slice(0, MAX_TRAFFIC_SCRIPTS)
        .map((name) => quote(name))
        .join(", ");
    const domain = filter.hostname === undefined ? "" : ` AND blob6 = ${quote(filter.hostname)}`;

    return `WHERE timestamp > toDateTime(${String(filter.sinceSec)}) AND timestamp <= toDateTime(${String(filter.toSec)}) AND index1 IN (${scripts})${domain}`;
};

/**
 * Build the breakdown query for one dimension — request count per distinct value,
 * biggest first.
 *
 * `SUM(_sample_interval)` rather than `SUM(double1)`: the dispatcher writes one
 * point per request, so summing the interval each retained row stands in for is
 * the exact count, while summing the bare count under-reports by the sample
 * factor — and sampling engages precisely during the traffic spikes an operator
 * opened this page to look at.
 */
export const buildTrafficDimensionQuery = (filter: TrafficFilter, dimension: TrafficDimension, limit = MAX_TRAFFIC_ROWS): string =>
    [
        `SELECT ${TRAFFIC_DIMENSIONS[dimension]} AS key, SUM(_sample_interval) AS requests`,
        `FROM ${filter.dataset}`,
        whereClause(filter),
        "GROUP BY key",
        "ORDER BY requests DESC",
        `LIMIT ${String(Math.max(Math.floor(limit), 1))}`,
    ].join(" ");

/**
 * Build the response-code query — grouped on class AND exact code, so the UI can
 * render the nested "2xx → 200 / 204" shape from one read.
 *
 * The class is stored rather than derived in SQL because it is already a blob:
 * `recordRequestUsage` writes both, and grouping on a stored low-cardinality
 * value beats a string expression over every row.
 */
export const buildTrafficStatusQuery = (filter: TrafficFilter, limit = MAX_TRAFFIC_ROWS): string =>
    [
        "SELECT blob3 AS class, blob7 AS code, SUM(_sample_interval) AS requests",
        `FROM ${filter.dataset}`,
        whereClause(filter),
        "GROUP BY class, code",
        "ORDER BY requests DESC",
        `LIMIT ${String(Math.max(Math.floor(limit), 1))}`,
    ].join(" ");

/**
 * Build the volume-over-time query — requests, bytes and mean duration per bucket.
 *
 * Both summed doubles are multiplied by `_sample_interval` before summing, and the
 * mean is the weighted `SUM(v * i) / SUM(i)` rather than `avg(v)`: a plain average
 * over retained rows silently weights a heavily-sampled minute the same as a quiet
 * one, which inverts exactly the spike an operator is looking for.
 */
export const buildTrafficSeriesQuery = (filter: TrafficFilter, bucketSec: number): string => {
    const width = Math.max(Math.floor(bucketSec), 1);
    const bucket = `intDiv(toUInt32(timestamp), ${String(width)}) * ${String(width)}`;

    return [
        `SELECT ${bucket} AS bucket, SUM(_sample_interval) AS requests, SUM(double3 * _sample_interval) AS bytes,`,
        "SUM(double2 * _sample_interval) / SUM(_sample_interval) AS avgDurationMs",
        `FROM ${filter.dataset}`,
        whereClause(filter),
        "GROUP BY bucket",
        "ORDER BY bucket",
    ].join(" ");
};

/** Coerce an AE cell (AE returns numbers as numeric strings over the SQL API) to a finite number. */
const asNumber = (value: unknown): number => {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);

        return Number.isFinite(parsed) ? parsed : 0;
    }

    return 0;
};

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/** One row of a dimension breakdown: the value, its request count, and its share of the window. */
export interface TrafficBreakdownRow {
    key: string;
    requests: number;
    /** Fraction of the returned window's requests, `0`–`1`. Precomputed so every consumer agrees. */
    share: number;
}

/**
 * Fold breakdown rows, dropping empties and computing each row's share.
 *
 * Share is over the SUM OF RETURNED ROWS, not the window total — the query is
 * `LIMIT`ed, so a page of the top 40 countries does not know about the tail. The
 * UI states the row count alongside, which is the honest framing ("110.2K
 * requests from 35 countries") rather than implying the list is exhaustive.
 */
export const foldTrafficBreakdown = (rows: ReadonlyArray<Record<string, unknown>>): TrafficBreakdownRow[] => {
    const kept = rows
        .map((row) => {
            return { key: asString(row.key), requests: asNumber(row.requests) };
        })
        .filter((row) => row.key !== "" && row.requests > 0);
    const total = kept.reduce((sum, row) => sum + row.requests, 0);

    return kept.map((row) => {
        return { ...row, share: total === 0 ? 0 : row.requests / total };
    });
};

/** One response class with the exact codes inside it, biggest first. */
export interface TrafficStatusClass {
    class: string;
    codes: { code: string; requests: number }[];
    requests: number;
}

/** Fold `(class, code)` rows into per-class groups with their codes nested and summed. */
export const foldTrafficStatus = (rows: ReadonlyArray<Record<string, unknown>>): TrafficStatusClass[] => {
    const byClass = new Map<string, TrafficStatusClass>();

    for (const row of rows) {
        const className = asString(row.class);
        const requests = asNumber(row.requests);

        if (className === "" || requests <= 0) {
            continue;
        }

        const group = byClass.get(className) ?? { class: className, codes: [], requests: 0 };

        group.requests += requests;

        const code = asString(row.code);

        if (code !== "" && code !== "unknown") {
            group.codes.push({ code, requests });
        }

        byClass.set(className, group);
    }

    for (const group of byClass.values()) {
        group.codes.sort((a, b) => b.requests - a.requests);
    }

    return [...byClass.values()].toSorted((a, b) => a.class.localeCompare(b.class));
};

/** One bucket of the volume series. */
export interface TrafficSeriesPoint {
    avgDurationMs: number;
    bytes: number;
    requests: number;
    /** Bucket start, epoch ms. */
    t: number;
}

/** Fold series rows; AE returns the bucket as epoch **seconds**. */
export const foldTrafficSeries = (rows: ReadonlyArray<Record<string, unknown>>): TrafficSeriesPoint[] =>
    rows.map((row) => {
        return {
            avgDurationMs: asNumber(row.avgDurationMs),
            bytes: asNumber(row.bytes),
            requests: asNumber(row.requests),
            t: asNumber(row.bucket) * 1000,
        };
    });

/** Everything the Traffic tab renders, from one reader call. */
export interface TrafficSnapshot {
    countries: TrafficBreakdownRow[];
    hostnames: TrafficBreakdownRow[];
    routes: TrafficBreakdownRow[];
    series: TrafficSeriesPoint[];
    statuses: TrafficStatusClass[];
    /** Total requests across the returned country rows — the panel's headline number. */
    totalRequests: number;
}

/** Read a traffic snapshot for a set of scripts over a window. */
export interface TrafficReader {
    readSnapshot: (input: { from: number; hostname?: string; scriptNames: ReadonlyArray<string>; to: number }) => Promise<TrafficSnapshot>;
}

/** Options for {@link createTrafficReader}: AE account creds + dataset (+ injectable `fetch`/bucket). */
export interface TrafficReaderOptions {
    accountId: string;
    apiToken: string;
    /** Bucket width in ms; defaults to {@link DEFAULT_TRAFFIC_BUCKET_MS}. */
    bucketMs?: number;
    /** The metering dataset the dispatcher writes to. */
    dataset: string;
    fetch?: typeof globalThis.fetch;
}

/** An empty snapshot — the shape every degraded path returns rather than throwing. */
const EMPTY_SNAPSHOT: TrafficSnapshot = { countries: [], hostnames: [], routes: [], series: [], statuses: [], totalRequests: 0 };

/**
 * HTTP {@link TrafficReader} over the AE SQL API (the same read path as the usage
 * and metrics readers). Runs at the edge — it needs the account API token.
 *
 * The five reads are issued together rather than sequentially: they share a
 * `WHERE` and nothing depends on another's result, so serializing them would
 * multiply the tab's latency by five for no benefit.
 */
export const createTrafficReader = (options: TrafficReaderOptions): TrafficReader => {
    const sql: AnalyticsSqlClient = createAnalyticsSqlClient({
        accountId: options.accountId,
        apiToken: options.apiToken,
        ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const bucketSec = Math.max(Math.floor((options.bucketMs ?? DEFAULT_TRAFFIC_BUCKET_MS) / 1000), 1);

    return {
        readSnapshot: async ({ from, hostname, scriptNames, to }) => {
            // No scripts means the org has deployed nothing, and `index1 IN ()` is
            // not valid SQL — answer without a round trip rather than building it.
            if (scriptNames.length === 0) {
                return EMPTY_SNAPSHOT;
            }

            const filter: TrafficFilter = {
                dataset: options.dataset,
                scriptNames,
                sinceSec: Math.floor(from / 1000),
                toSec: Math.floor(to / 1000),
                ...(hostname === undefined ? {} : { hostname }),
            };

            // The hostname breakdown deliberately ignores the hostname filter. It IS
            // the filter's option list, so narrowing it to the selected domain would
            // leave the picker holding exactly one choice the moment you used it —
            // and it is also the only view that answers "how does my traffic split
            // across my domains", which a filtered read cannot.
            const unfiltered: TrafficFilter = { dataset: filter.dataset, scriptNames, sinceSec: filter.sinceSec, toSec: filter.toSec };

            const [countries, routes, hostnames, statuses, series] = await Promise.all([
                sql.query(buildTrafficDimensionQuery(filter, "country")),
                sql.query(buildTrafficDimensionQuery(filter, "route")),
                sql.query(buildTrafficDimensionQuery(unfiltered, "hostname")),
                sql.query(buildTrafficStatusQuery(filter)),
                sql.query(buildTrafficSeriesQuery(filter, bucketSec)),
            ]);

            const countryRows = foldTrafficBreakdown(countries.rows);

            return {
                countries: countryRows,
                hostnames: foldTrafficBreakdown(hostnames.rows),
                routes: foldTrafficBreakdown(routes.rows),
                series: foldTrafficSeries(series.rows),
                statuses: foldTrafficStatus(statuses.rows),
                totalRequests: countryRows.reduce((sum, row) => sum + row.requests, 0),
            };
        },
    };
};
