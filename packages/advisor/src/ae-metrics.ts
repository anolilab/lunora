/* eslint-disable no-secrets/no-secrets -- false positive: `loadAnalyticsRuntimeMetrics` is a function name in prose, not a credential */

/**
 * Analytics-Engine-derived feed for the runtime lints — QUARANTINED design note,
 * **not exported** from `@lunora/advisor`'s package root (plan 225 / ADVISOR-01).
 *
 * The runtime lints (`hot_shard`, `index_utilization`) are pure over the
 * {@link LintContext} arrays `shardTraffic` / `tableScans` / `indexHits`. By
 * default the studio backend fills those from each shard's durable in-DO
 * counters (`__lunora_metrics*`). This module sketches an **alternative feeder**:
 * given a read client over Analytics Engine, it would reconstruct the same
 * arrays from cross-shard scan-attribution data in AE — so the advisors could be
 * backed by AE instead of (or alongside) the in-DO counters.
 *
 * Two read clients fit, and `options.dialect` picks the SQL to send:
 * - `"analytics-sql"` — `ctx.analyticsSql` / `createAnalyticsSql` from
 * `@lunora/bindings/analytics-sql`, backed by the Worker's Analytics SQL binding
 * (no API token). Prefer it wherever the binding exists. The dialect needs a
 * lower `timestamp` bound, so `options.since` is required, and its `COUNT(*)` is
 * already sample-weighted by the SQL API.
 * - `"analytics-engine"` (the default) — `createAnalyticsSqlClient` from
 * `@lunora/bindings/analytics`, the API-token client over the older Workers
 * Analytics Engine SQL API, which sums `_sample_interval` itself.
 *
 * It never shipped a writer: nothing in the runtime calls
 * `ctx.analytics.track("lunora.index.hit" | "lunora.shard.request" |
 * "lunora.table.scan", …)`, so the `{@link AE_METRIC_EVENTS}` this reader queries
 * for are never populated, and `loadAnalyticsRuntimeMetrics` always returns
 * `shardTraffic` and `tableScans` empty against a live AE dataset. `indexHits`
 * is empty too UNLESS the caller passes `options.declaredIndexes` — then it's
 * every declared index with `reads: 0` (a real "zero reads observed" fact, not
 * a stand-in for "no data"). The one caller shaped to consume it —
 * the studio's `deriveRuntimeAdvisories` (`analyticsMetrics` input) — never
 * actually supplies it either. Silently wiring this as-is would disable the
 * dead-index half of `index_utilization` (an AE array that's merely empty reads
 * as "no dead indexes" rather than "no data"), so it stays unexported until a
 * writer exists. The read-side logic and its test coverage stay in place as the
 * groundwork for that follow-up; import from `./ae-metrics` directly (not the
 * package root) if you need it for that work.
 *
 * ## Read contract (for when a writer exists)
 *
 * The arrays would be reconstructed from data points the runtime mirrors into AE
 * via `ctx.analytics.track(name, { dimensions })`. `track` reserves `blob1` for
 * the event name and lays dimensions out from `blob2` in key order (see
 * `@lunora/bindings/analytics`' `createAnalytics`). The event names + dimension columns
 * this reader expects are the {@link AE_METRIC_EVENTS} constants below; the
 * un-sampled count is AE's `sum(_sample_interval)`.
 */
import { LunoraError } from "@lunora/errors";

import type { AdvisorIndexHit, AdvisorTableScan } from "./index-usage";
import type { AdvisorShardTraffic } from "./shard-traffic";
import type { LintContext } from "./types";

/** A bare AE table identifier: letters, digits, `_`, `.` and `-` only. */
const DATASET_NAME_PATTERN = /^[\w.-]+$/u;

/**
 * Minimal structural view of an Analytics Engine read client — just its
 * `query(sql, params?)` method. Kept structural (not an `import type` from
 * `@lunora/bindings`) so the advisor needn't depend on the bindings package.
 * Both `createAnalyticsSql`'s client (which binds `params`) and
 * `createAnalyticsSqlClient`'s (which takes only `sql`, and is only ever sent
 * parameterless statements) satisfy it, as does a plain test double.
 */
interface AnalyticsMetricsSource {
    query: (sql: string, params?: Readonly<Record<string, string>>) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
}

/**
 * The AE event-name + dimension-column contract the runtime writes and this
 * reader reads. `blob1` is the event name; dimensions start at `blob2`.
 */
const AE_METRIC_EVENTS = {
    /** `lunora.index.hit` — one row per `(table, index)` use. `blob2`=table, `blob3`=index. */
    indexHit: { event: "lunora.index.hit", index: "blob3", table: "blob2" },
    /** `lunora.shard.request` — one row per shard dispatch. `blob2`=shardKey, `blob3`=group. */
    shardRequest: { event: "lunora.shard.request", group: "blob3", shardKey: "blob2" },
    /** `lunora.table.scan` — one row per full-scan. `blob2`=table. */
    tableScan: { event: "lunora.table.scan", table: "blob2" },
} as const;

/** Which SQL dialect the {@link AnalyticsMetricsSource} speaks. */
type AnalyticsMetricsDialect =
    | {
          /** The Analytics SQL API, through the binding-backed `createAnalyticsSql` client. */
          dialect: "analytics-sql";
          /** ISO-8601 lower `timestamp` bound — required by the Analytics SQL dialect. */
          since: string;
      }
    | {
          /** The Workers Analytics Engine SQL API, through the API-token `createAnalyticsSqlClient` (the default). */
          dialect?: "analytics-engine";
          since?: never;
      };

/** Options for the AE-backed runtime-metrics feeder. */
type AnalyticsMetricsOptions = AnalyticsMetricsDialect & {
    /** The AE dataset (the wrangler `analytics_engine_datasets[].dataset`) to read from. */
    dataset: string;

    /**
     * Declared index names per table, used to synthesise the `reads: 0` rows the
     * `index_utilization` dead-index half needs. AE only stores rows for indexes
     * that were *used*, so a never-hit index has no AE row at all; supplying the
     * declared set lets the reader emit an explicit `reads: 0` entry for any
     * declared index absent from the AE hit feed. Omit it to report only the
     * positive hit counts AE returns.
     */
    declaredIndexes?: ReadonlyArray<{ index: string; table: string }>;

    /**
     * Restrict the shard-traffic read to one sharded-function group (`blob3`).
     * Omit to read the whole deployment's shard set.
     */
    group?: string;
};

/** The runtime-lint input arrays this module reconstructs from AE. */
interface AnalyticsRuntimeMetrics {
    indexHits: AdvisorIndexHit[];
    shardTraffic: AdvisorShardTraffic[];
    tableScans: AdvisorTableScan[];
}

/** Coerce an AE column value (which may arrive as a number or numeric string) to a finite number, defaulting to 0. */
const toCount = (value: unknown): number => {
    const numeric = typeof value === "number" ? value : Number(value);

    return Number.isFinite(numeric) ? numeric : 0;
};

/** Coerce an AE column value to a string, defaulting to empty (AE returns `null` for an unwritten blob slot). */
const toText = (value: unknown): string => {
    if (typeof value === "string") {
        return value;
    }

    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value);
    }

    return "";
};

/**
 * Reject a dataset name that isn't a bare AE table identifier. The dataset comes
 * from wrangler config (not user query text), but it is interpolated into the
 * `FROM` clause, so this is a defensive guard against an unexpected value
 * smuggling SQL — only letters, digits, `_`, `.` and `-` are allowed.
 */
const assertDataset = (dataset: string): void => {
    if (!DATASET_NAME_PATTERN.test(dataset)) {
        throw new LunoraError("INTERNAL", `@lunora/advisor: invalid Analytics Engine dataset name "${dataset}" — expected a bare table identifier.`);
    }
};

/**
 * Single-quote-escape a string for an AE SQL literal.
 *
 * Escapes backslashes first (so a trailing `\` cannot consume the closing
 * quote) and then doubles any single quotes — the standard defence-in-depth
 * escape for SQL string literals regardless of whether the AE/ClickHouse
 * dialect treats backslash as an escape character.
 */
const sqlString = (value: string): string => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;

/**
 * The pieces of one aggregate read that differ between the two dialects: the
 * `FROM` table, the sample-weighted count, and the leading `WHERE` filter.
 *
 * Analytics SQL names an AE dataset `events.analyticsEngine."<dataset>"`, needs
 * the lower `timestamp` bound (bound as `$since`), and weights `COUNT(*)` by the
 * sample interval itself ("For adaptively sampled event and log datasets, the
 * SQL API automatically applies sample weights to `COUNT`…"). The AE SQL API
 * names the bare dataset and leaves the weighting to `sum(_sample_interval)`.
 */
const dialectParts = (options: AnalyticsMetricsOptions, event: string): { count: string; from: string; params?: Record<string, string>; where: string } => {
    if (options.dialect === "analytics-sql") {
        return {
            count: "COUNT(*)",
            from: `events.analyticsEngine."${options.dataset}"`,
            params: { event, since: options.since },
            where: "timestamp >= $since AND blob1 = $event",
        };
    }

    return { count: "sum(_sample_interval)", from: options.dataset, where: `blob1 = ${sqlString(event)}` };
};

/** Run one query, mapping a transport/SQL error to an empty result so one bad metric never aborts the whole feed. */
const queryOrEmpty = async (
    source: AnalyticsMetricsSource,
    sql: string,
    params?: Readonly<Record<string, string>>,
): Promise<ReadonlyArray<Record<string, unknown>>> => {
    try {
        const result = params === undefined ? await source.query(sql) : await source.query(sql, params);

        return result.rows;
    } catch {
        return [];
    }
};

/**
 * Read per-shard request volume (`hot_shard`'s input) from AE. Sums the
 * un-sampled `_sample_interval` per `(shardKey, group)` for the `shard.request`
 * event, optionally scoped to one group.
 */
const loadShardTraffic = async (source: AnalyticsMetricsSource, options: AnalyticsMetricsOptions): Promise<AdvisorShardTraffic[]> => {
    const { event, group, shardKey } = AE_METRIC_EVENTS.shardRequest;
    const { count, from, params, where } = dialectParts(options, event);
    let groupFilter = "";

    if (options.group !== undefined) {
        groupFilter = params === undefined ? ` AND ${group} = ${sqlString(options.group)}` : ` AND ${group} = $group`;
    }

    const sql = `SELECT ${shardKey} AS shardKey, ${group} AS shardGroup, ${count} AS requests FROM ${from} WHERE ${where}${groupFilter} GROUP BY shardKey, shardGroup`;

    const rows = await queryOrEmpty(source, sql, params === undefined || options.group === undefined ? params : { ...params, group: options.group });

    return rows.map((row) => {
        const shardGroup = toText(row.shardGroup);

        return {
            ...(shardGroup === "" ? {} : { group: shardGroup }),
            requests: toCount(row.requests),
            shardKey: toText(row.shardKey),
        };
    });
};

/**
 * Read per-table full-scan volume (`index_utilization`'s hot-scan input) from AE.
 * Sums the un-sampled count per table for the `table.scan` event.
 */
const loadTableScans = async (source: AnalyticsMetricsSource, options: AnalyticsMetricsOptions): Promise<AdvisorTableScan[]> => {
    const { event, table } = AE_METRIC_EVENTS.tableScan;
    const { count, from, params, where } = dialectParts(options, event);
    const sql = `SELECT ${table} AS scanTable, ${count} AS scans FROM ${from} WHERE ${where} GROUP BY scanTable`;

    const rows = await queryOrEmpty(source, sql, params);

    return rows.map((row) => {
        return { scans: toCount(row.scans), table: toText(row.scanTable) };
    });
};

/**
 * Read per-`(table, index)` hit counts (`index_utilization`'s dead-index input)
 * from AE. AE only has rows for indexes that were used, so when
 * `options.declaredIndexes` is supplied, any declared index absent from the hit
 * feed is emitted with `reads: 0` — exactly the "dead index" signal the lint
 * needs (AE alone can't report an index that was never written).
 */
const loadIndexHits = async (source: AnalyticsMetricsSource, options: AnalyticsMetricsOptions): Promise<AdvisorIndexHit[]> => {
    const { event, index, table } = AE_METRIC_EVENTS.indexHit;
    const { count, from, params, where } = dialectParts(options, event);
    const sql = `SELECT ${table} AS hitTable, ${index} AS hitIndex, ${count} AS reads FROM ${from} WHERE ${where} GROUP BY hitTable, hitIndex`;

    const rows = await queryOrEmpty(source, sql, params);
    const hits = rows.map((row) => {
        return { index: toText(row.hitIndex), reads: toCount(row.reads), table: toText(row.hitTable) };
    });

    if (options.declaredIndexes === undefined) {
        return hits;
    }

    const seen = new Set(hits.map((hit) => `${hit.table}\0${hit.index}`));
    const zeros = options.declaredIndexes
        .filter((declared) => !seen.has(`${declared.table}\0${declared.index}`))
        .map((declared) => {
            return { index: declared.index, reads: 0, table: declared.table };
        });

    return [...hits, ...zeros];
};

/**
 * Reconstruct the runtime-lint input arrays (`shardTraffic` / `tableScans` /
 * `indexHits`) from the Analytics Engine SQL API. The three reads run
 * concurrently; each degrades to an empty array on a query failure, so a
 * partially-misconfigured read path still returns what it can.
 *
 * QUARANTINED — not exported from `@lunora/advisor`'s package root. No writer
 * ever calls `ctx.analytics.track` with the events this reads, so `shardTraffic`
 * and `tableScans` are always empty against a real dataset. `indexHits` is
 * empty too unless `options.declaredIndexes` is supplied, in which case it's
 * every declared index reported with `reads: 0` — that's real zero-read
 * evidence, not an absence-of-data placeholder. Wiring this in as-is would
 * silently disable `index_utilization`'s dead-index check for a caller that
 * omits `declaredIndexes` (empty reads as "nothing dead", not "no data"). See
 * the module doc for the full rationale;
 * import from `./ae-metrics` directly if you're doing the follow-up work that
 * adds the writer.
 *
 * Feed the result into a {@link LintContext} alongside the declared schema:
 *
 * ```ts
 * const metrics = await loadAnalyticsRuntimeMetrics(client, { dataset: "ANALYTICS" });
 * runAdvisor({ schema, ...metrics }, { source: "runtime" });
 * ```
 */
const loadAnalyticsRuntimeMetrics = async (source: AnalyticsMetricsSource, options: AnalyticsMetricsOptions): Promise<AnalyticsRuntimeMetrics> => {
    assertDataset(options.dataset);

    const [shardTraffic, tableScans, indexHits] = await Promise.all([
        loadShardTraffic(source, options),
        loadTableScans(source, options),
        loadIndexHits(source, options),
    ]);

    return { indexHits, shardTraffic, tableScans };
};

export { AE_METRIC_EVENTS, loadAnalyticsRuntimeMetrics };
export type { AnalyticsMetricsDialect, AnalyticsMetricsOptions, AnalyticsMetricsSource, AnalyticsRuntimeMetrics };
