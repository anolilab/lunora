/**
 * Read-back of the platform's own metrics (GAPS.md E1) — the write side and the
 * row layouts are `./platform-metrics.ts`. Served to operators by
 * `GET /v1/platform/metrics` (admin-token gated); never to a tenant.
 *
 * Every statement filters on `index1`, the metric kind, so each read touches one
 * kind's rows. Latency percentiles use `quantileWeighted` over `sampleInterval`:
 * the dispatch rows are the high-volume kind AE samples first, and an unweighted
 * quantile over the retained rows would over-represent quiet minutes.
 */
import type { AnalyticsSqlCredentials } from "./ae-sql";
import { analyticsEngineTable, bucketExpression, createRestAnalyticsSql, isoSeconds } from "./ae-sql";
import { PLATFORM_METRIC_KINDS } from "./platform-metrics";

/** The dataset `PLATFORM_METRICS` is bound to when a cell names none (`wrangler.jsonc`). */
export const DEFAULT_PLATFORM_METRICS_DATASET = "lunora_platform_metrics";

/** Bucket width of the queue-depth series (15 min) — ~96 points over a day. */
const QUEUE_BUCKET_SEC = 15 * 60;

/** Most distinct (cell, step, reason) failure rows one read returns. */
const MAX_FAILURE_ROWS = 50;

/** One statement plus its bound values. */
export interface PlatformMetricsQuery {
    params: Record<string, string>;
    query: string;
}

/** Build the four statements for the window `(sinceSec, toSec]`. Pure, so the SQL is pinned by tests. */
export const buildPlatformMetricsQueries = (
    dataset: string,
    sinceSec: number,
    toSec: number,
): Record<"dispatchLatency" | "dispatchOutcomes" | "provisionFailures" | "queueDepth", PlatformMetricsQuery> => {
    const table = analyticsEngineTable(dataset);
    const statement = (kind: string, select: string, tail: string): PlatformMetricsQuery => {
        return {
            params: { kind, since: isoSeconds(sinceSec), to: isoSeconds(toSec) },
            query: `${select} FROM ${table} WHERE index1 = $kind AND timestamp > $since AND timestamp <= $to ${tail}`,
        };
    };

    return {
        dispatchLatency: statement(
            PLATFORM_METRIC_KINDS.dispatch,
            "SELECT blob2 AS cell, COUNT(*) AS requests, quantileWeighted(0.50, double1, sampleInterval) AS p50, quantileWeighted(0.95, double1, sampleInterval) AS p95",
            "GROUP BY cell ORDER BY cell",
        ),
        dispatchOutcomes: statement(
            PLATFORM_METRIC_KINDS.dispatch,
            "SELECT blob2 AS cell, blob3 AS outcome, COUNT(*) AS requests",
            "GROUP BY cell, outcome ORDER BY cell, outcome",
        ),
        provisionFailures: statement(
            PLATFORM_METRIC_KINDS.provisionFailure,
            "SELECT blob2 AS cell, blob3 AS step, blob4 AS reason, COUNT(*) AS failures",
            `GROUP BY cell, step, reason ORDER BY failures DESC LIMIT ${String(MAX_FAILURE_ROWS)}`,
        ),
        // MAX, not AVG: a queue that backed up for one minute of fifteen is the
        // thing to see, and averaging it away hides exactly that.
        queueDepth: statement(
            PLATFORM_METRIC_KINDS.queue,
            `SELECT ${bucketExpression(QUEUE_BUCKET_SEC)} AS bucket, blob2 AS cell, MAX(double1) AS buildsPending, MAX(double2) AS buildsRunning, MAX(double3) AS deploysInFlight`,
            "GROUP BY bucket, cell ORDER BY bucket",
        ),
    };
};

/** Coerce an AE cell (64-bit numbers can come back as strings) to a finite number. */
const asNumber = (value: unknown): number => {
    const parsed = typeof value === "number" ? value : Number(value ?? Number.NaN);

    return Number.isFinite(parsed) ? parsed : 0;
};

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/** What the endpoint returns. */
export interface PlatformMetricsSnapshot {
    dispatch: { cell: string; outcomes: Record<string, number>; p50Ms: number; p95Ms: number; requests: number }[];
    provisionFailures: { cell: string; failures: number; reason: string; step: string }[];
    /** Peak depth per 15-minute bucket; `t` is the bucket start in epoch ms. */
    queue: { buildsPending: number; buildsRunning: number; cell: string; deploysInFlight: number; t: number }[];
}

type Rows = ReadonlyArray<Record<string, unknown>>;

/** Fold the four result sets into one snapshot — outcomes nested under their cell's latency row. */
export const foldPlatformMetrics = (rows: {
    dispatchLatency: Rows;
    dispatchOutcomes: Rows;
    provisionFailures: Rows;
    queueDepth: Rows;
}): PlatformMetricsSnapshot => {
    const dispatch = rows.dispatchLatency.map((row): PlatformMetricsSnapshot["dispatch"][number] => {
        return {
            cell: asString(row.cell),
            outcomes: {},
            p50Ms: asNumber(row.p50),
            p95Ms: asNumber(row.p95),
            requests: asNumber(row.requests),
        };
    });

    const byCell = new Map(dispatch.map((entry) => [entry.cell, entry]));

    for (const row of rows.dispatchOutcomes) {
        const cell = byCell.get(asString(row.cell));

        if (cell) {
            cell.outcomes[asString(row.outcome)] = asNumber(row.requests);
        }
    }

    return {
        dispatch,
        provisionFailures: rows.provisionFailures.map((row) => {
            return { cell: asString(row.cell), failures: asNumber(row.failures), reason: asString(row.reason), step: asString(row.step) };
        }),
        queue: rows.queueDepth.map((row) => {
            return {
                buildsPending: asNumber(row.buildsPending),
                buildsRunning: asNumber(row.buildsRunning),
                cell: asString(row.cell),
                deploysInFlight: asNumber(row.deploysInFlight),
                t: asNumber(row.bucket) * 1000,
            };
        }),
    };
};

/** Read a snapshot over `[from, to]` (epoch ms). The four reads are independent, so they run together. */
export const readPlatformMetrics = async (
    options: AnalyticsSqlCredentials & { dataset: string },
    window: { from: number; to: number },
): Promise<PlatformMetricsSnapshot> => {
    const sql = createRestAnalyticsSql(options);
    const queries = buildPlatformMetricsQueries(options.dataset, Math.floor(window.from / 1000), Math.floor(window.to / 1000));
    const run = async (request: PlatformMetricsQuery): Promise<Rows> => {
        const { rows } = await sql.query(request.query, request.params);

        return rows;
    };
    const [dispatchLatency, dispatchOutcomes, provisionFailures, queueDepth] = await Promise.all([
        run(queries.dispatchLatency),
        run(queries.dispatchOutcomes),
        run(queries.provisionFailures),
        run(queries.queueDepth),
    ]);

    return foldPlatformMetrics({ dispatchLatency, dispatchOutcomes, provisionFailures, queueDepth });
};
