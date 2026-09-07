import type { AdvisorIndexHit, AdvisorShardTraffic, AdvisorTableScan, AnalyticsRuntimeMetrics } from "@lunora/advisor";
import { runAdvisor, RUNTIME_LINTS } from "@lunora/advisor";

import type { FunctionCallStat, MetricsIndexHit, TableIndexInfo } from "../../lib/admin";
import type { AdvisorRow } from "./advisor-view";
import { advisoryRow } from "./advisor-view";

/**
 * One declared index, paired with the table it lives on — the per-table
 * `listTableIndexes` result flattened into the `{ table, index }` pairs the
 * dead-index reconciliation enumerates.
 */
interface DeclaredIndex {
    /** The declared index name (matched against the recorded hit feed). */
    index: string;
    /** The table the index is declared on. */
    table: string;
}

/** Inputs the studio gathers from the admin RPCs to feed the runtime lints. */
interface RuntimeAdvisoryInputs {
    /**
     * Optional Analytics-Engine-derived runtime metrics, fetched out-of-band via
     * `@lunora/advisor`'s analytics runtime-metrics loader when an AE read token is
     * configured. Each non-empty array **replaces** the corresponding in-DO
     * signal below (AE's cross-shard scan attribution is the authoritative source
     * when available); an empty/absent array falls back to the in-DO counters, so
     * the advisors still function with no AE token. Strictly optional — the panel
     * passes this only after a successful AE read.
     */
    analyticsMetrics?: AnalyticsRuntimeMetrics | null;

    /**
     * Every declared index across the schema's tables, enumerated from
     * `listTables` + `listTableIndexes`. Reconciled against `indexHits` so a
     * declared index absent from the recorded feed counts as dead (`reads: 0`).
     * Empty/absent when the RPCs are unavailable — then no dead-index check runs.
     */
    declaredIndexes?: ReadonlyArray<DeclaredIndex>;

    /**
     * The per-function call stats from `getFunctionStats`, whose `scannedTables`
     * carry the full-scan attribution aggregated into the hot-scan lint input.
     */
    functions?: ReadonlyArray<FunctionCallStat> | null;

    /**
     * The per-`(table, index)` recorded reads from the `getMetrics` payload's
     * `indexHits` (the USED-index counts). Reconciled against
     * `declaredIndexes`: a declared index with no matching entry is dead.
     */
    indexHits?: ReadonlyArray<MetricsIndexHit> | null;

    /**
     * The cross-shard request distribution from the worker's
     * `POST /_lunora/admin/shard-traffic` endpoint (`@lunora/runtime`'s
     * `orchestrateShardTraffic` fans `getMetrics` out across the live shards).
     * One `{ shardKey, requests }` per shard — fed straight into the `hot_shard`
     * lint, which fires when one shard takes a disproportionate share. Best-effort
     * and on-demand: absent/`null` when the panel hasn't fanned it out (or the
     * worker predates the endpoint), and then `hot_shard` simply finds nothing.
     */
    shardTraffic?: ReadonlyArray<AdvisorShardTraffic> | null;

    /**
     * Tables already covered by the panel's `missing-index` insight (which reads
     * the same `scannedTables` signal). The hot-scan lint half suppresses its
     * finding for these so a hot full-scanned table isn't double-reported; the
     * unique dead-index half is unaffected.
     */
    suppressHotScanTables?: ReadonlySet<string>;
}

/**
 * Reconcile the declared indexes against the recorded-reads feed into the
 * `AdvisorIndexHit[]` the dead-index lint half consumes. The recorded feed only
 * carries USED indexes, so a declared index missing from it (or present with a
 * non-positive count) becomes `{ ..., reads: 0 }` and the lint flags it dead. A
 * declared index with recorded `reads > 0` carries its count through and stays
 * quiet. Indexes that recorded reads but aren't declared (a stale row from a
 * dropped index) are ignored — only declared indexes can be "dead overhead".
 */
const reconcileIndexHits = (declaredIndexes: ReadonlyArray<DeclaredIndex>, indexHits: ReadonlyArray<MetricsIndexHit>): AdvisorIndexHit[] => {
    const readsByKey = new Map<string, number>();

    for (const hit of indexHits) {
        const key = `${hit.table} ${hit.index}`;

        readsByKey.set(key, (readsByKey.get(key) ?? 0) + hit.reads);
    }

    return declaredIndexes.map((declared) => {
        return {
            index: declared.index,
            reads: readsByKey.get(`${declared.table} ${declared.index}`) ?? 0,
            table: declared.table,
        };
    });
};

/**
 * Aggregate the per-function full-scan attribution (`FunctionCallStat.scannedTables`,
 * each `{ table, scans }`) into the per-table `AdvisorTableScan[]` the hot-scan
 * lint half consumes — one total per table summed across every function.
 */
const aggregateTableScans = (functions: ReadonlyArray<FunctionCallStat>): AdvisorTableScan[] => {
    const scansByTable = new Map<string, number>();

    for (const callStat of functions) {
        for (const attribution of callStat.scannedTables ?? []) {
            scansByTable.set(attribution.table, (scansByTable.get(attribution.table) ?? 0) + attribution.scans);
        }
    }

    return [...scansByTable].map(([table, scans]) => {
        return { scans, table };
    });
};

/**
 * Flatten one table's `listTableIndexes` result into `{ table, index }` pairs.
 * Exposed so the panel can build {@link RuntimeAdvisoryInputs.declaredIndexes}
 * from its best-effort per-table fan-out without re-deriving the shape.
 */
const declaredIndexesFor = (table: string, indexes: ReadonlyArray<TableIndexInfo>): DeclaredIndex[] =>
    indexes.map((index) => {
        return { index: index.name, table };
    });

/* eslint-disable jsdoc/check-indentation -- intentional nested bullet list documenting the inputs */

/**
 * Build the runtime {@link import("@lunora/advisor").LintContext} from the
 * studio-gathered admin signal, run the `runtime`-source lints, and return their
 * findings as Advisor table rows in the same shape `insights-panel`'s static
 * `advisoryRow` produces.
 *
 * The context is built from:
 *
 * - **indexHits** — declared indexes (from `listTables` + `listTableIndexes`)
 *   reconciled against the recorded-reads feed (`getMetrics.indexHits`). A
 *   declared index with no recorded use → `reads: 0` → flagged dead. With no
 *   declared indexes the dead-index half simply finds nothing.
 * - **tableScans** — `FunctionCallStat.scannedTables` aggregated per table across
 *   every function; a table over the lint's hot-scan threshold is flagged.
 * - **shardTraffic** — the cross-shard request distribution from the worker's
 *   `POST /_lunora/admin/shard-traffic` fan-out (`orchestrateShardTraffic`),
 *   passed straight through so the `hot_shard` lint fires when one shard takes a
 *   disproportionate share. Best-effort: when the panel hasn't fanned it out (or
 *   the worker predates the endpoint) it's absent and `hot_shard` finds nothing.
 *
 * Pure and side-effect-free, so the panel can call it inside a `useMemo` and it
 * unit-tests without a client.
 *
 */
const deriveRuntimeAdvisories = (inputs: RuntimeAdvisoryInputs): AdvisorRow[] => {
    const inDoIndexHits = reconcileIndexHits(inputs.declaredIndexes ?? [], inputs.indexHits ?? []);
    const inDoTableScans = aggregateTableScans(inputs.functions ?? []);
    // The cross-shard traffic feed now flows in (was omitted while the studio
    // held only one shard's snapshot); the worker's shard-traffic fan-out builds
    // it on demand, so `hot_shard` fires on a genuine cross-shard skew.
    const inDoShardTraffic = inputs.shardTraffic ?? [];

    // When AE metrics are supplied, each non-empty AE array takes precedence over
    // the in-DO signal (AE's cross-shard scan attribution is authoritative); an
    // empty AE array degrades to the in-DO counters.
    const analytics = inputs.analyticsMetrics;
    const indexHits = analytics && analytics.indexHits.length > 0 ? analytics.indexHits : inDoIndexHits;
    const tableScans = analytics && analytics.tableScans.length > 0 ? analytics.tableScans : inDoTableScans;
    const shardTraffic = analytics && analytics.shardTraffic.length > 0 ? analytics.shardTraffic : inDoShardTraffic;

    const findings = runAdvisor({ indexHits, schema: { tables: [] }, shardTraffic, tableScans }, { lints: RUNTIME_LINTS, source: "runtime" });

    // Drop hot-scan findings for tables the panel's `missing-index` insight
    // already reports (same `scannedTables` signal), so a hot full-scanned table
    // renders once. The dead-index half (unique to the runtime lint) is kept.
    const suppress = inputs.suppressHotScanTables;
    const visible =
        suppress === undefined
            ? findings
            : findings.filter(
                  (finding) =>
                      !(finding.metadata["kind"] === "hot_scan" && typeof finding.metadata["table"] === "string" && suppress.has(finding.metadata["table"])),
              );

    return visible.map((finding) => advisoryRow(finding));
};
/* eslint-enable jsdoc/check-indentation */

export { declaredIndexesFor, deriveRuntimeAdvisories };
export type { DeclaredIndex, RuntimeAdvisoryInputs };
