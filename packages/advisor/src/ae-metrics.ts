/**
 * Analytics-Engine-derived feed for the runtime lints — QUARANTINED design note,
 * **not exported** from `@lunora/advisor`'s package root (plan 225 / ADVISOR-01).
 *
 * The runtime lints (`hot_shard`, `index_utilization`) are pure over the
 * {@link LintContext} arrays `shardTraffic` / `tableScans` / `indexHits`. By
 * default the studio backend fills those from each shard's durable in-DO
 * counters (`__lunora_metrics*`). This module sketches an **alternative feeder**:
 * given a read client over the Analytics Engine SQL API (the one
 * `@lunora/bindings/analytics` exposes as `createAnalyticsSqlClient`), it would
 * reconstruct the same arrays from cross-shard scan-attribution data in AE —
 * so the advisors could be backed by AE instead of (or alongside) the in-DO
 * counters.
 *
 * It never shipped a writer: nothing in the runtime calls
 * `ctx.analytics.track("lunora.index.hit" | "lunora.shard.request" |
 * "lunora.table.scan", …)`, so the `{@link AE_METRIC_EVENTS}` this reader queries
 * for are never populated, and `loadAnalyticsRuntimeMetrics` always returns three
 * empty arrays against a live AE dataset. The one caller shaped to consume it —
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
 * Minimal structural view of the `@lunora/bindings/analytics` SQL client — just its
 * `query(sql)` method. Kept structural (not an `import type` from
 * `@lunora/bindings/analytics`) so the advisor needn't depend on the analytics package;
 * the real `AnalyticsSqlClient` satisfies it, as does a plain test double.
 */
interface AnalyticsMetricsSource {
    query: (sql: string) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
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

/** Options for the AE-backed runtime-metrics feeder. */
interface AnalyticsMetricsOptions {
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
}

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

/** Run one query, mapping a transport/SQL error to an empty result so one bad metric never aborts the whole feed. */
const queryOrEmpty = async (source: AnalyticsMetricsSource, sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
    try {
        const result = await source.query(sql);

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
    const groupFilter = options.group === undefined ? "" : ` AND ${group} = ${sqlString(options.group)}`;
    const sql =
        `SELECT ${shardKey} AS shardKey, ${group} AS shardGroup, sum(_sample_interval) AS requests ` +
        `FROM ${options.dataset} WHERE blob1 = ${sqlString(event)}${groupFilter} ` +
        `GROUP BY shardKey, shardGroup`;

    const rows = await queryOrEmpty(source, sql);

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
    const sql = `SELECT ${table} AS scanTable, sum(_sample_interval) AS scans FROM ${options.dataset} WHERE blob1 = ${sqlString(event)} GROUP BY scanTable`;

    const rows = await queryOrEmpty(source, sql);

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
    const sql =
        `SELECT ${table} AS hitTable, ${index} AS hitIndex, sum(_sample_interval) AS reads ` +
        `FROM ${options.dataset} WHERE blob1 = ${sqlString(event)} ` +
        `GROUP BY hitTable, hitIndex`;

    const rows = await queryOrEmpty(source, sql);
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
 * ever calls `ctx.analytics.track` with the events this reads, so every call
 * today returns three empty arrays against a real dataset. Wiring this in as-is
 * would silently disable `index_utilization`'s dead-index check (empty reads as
 * "nothing dead", not "no data"). See the module doc for the full rationale;
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
export type { AnalyticsMetricsOptions, AnalyticsMetricsSource, AnalyticsRuntimeMetrics };
