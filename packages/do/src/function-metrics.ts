/**
 * Per-function metrics for `ShardDO`: the in-memory counters served by
 * `__lunora_admin__:getFunctionStats`, and the coalesced delta written to the
 * durable `__lunora_metrics*` tables every N dispatches.
 *
 * Reaches the shard only through {@link FunctionMetricsHost}. The dispatch path
 * decides when a call is recorded; this module decides how it is folded and
 * when it is written.
 */
import type { FunctionMetricBucketsResult, IndexHit } from "@lunora/observability";
import {
    FUNCTION_METRICS_BUCKET_MS,
    FUNCTION_METRICS_MAX_PATHS,
    latencyBucketIndex,
    mergeScanAttribution,
    readFunctionMetricBuckets,
    readFunctionMetrics,
    recordFunctionMetric,
    recordQueryMetric,
} from "@lunora/observability";
import type { ShardHost } from "@lunora/platform";
import type { FunctionCallStat, FunctionStatsResult, SqlExec } from "@lunora/shard-engine";

import { decodeIndexHitKey } from "./admin-rpc-args";

/**
 * Bound on distinct normalised statements folded into
 * `ShardDO.currentStmtSamples` per dispatch. Mirrors
 * `database-telemetry.ts`'s `MAX_CLIENT_SPANS_PER_TALLY`: a handler that queries in a
 * loop already folds repeats of the SAME statement into one running entry (see
 * `sql` getter), so this only bounds the number of DISTINCT statement shapes one
 * dispatch can accumulate before {@link FunctionMetrics.foldStmtSamples} starts
 * dropping brand-new ones — a handler building ad-hoc SQL per iteration
 * (dynamic column lists, generated `IN (...)` clauses) would otherwise grow the
 * buffer, and the flush that drains it, without bound.
 */
const MAX_STMT_SAMPLES_PER_DISPATCH = 200;

/** Dispatches per durable metric write by default; an evicted DO loses at most 7 of them. */
const DEFAULT_METRICS_FLUSH_EVERY = 8;

/**
 * One distinct statement's folded activity within a dispatch — see
 * `ShardDO.currentStmtSamples`. `count` is how many raw executions
 * folded into this entry; `totalDurationMs`/`rowsRead`/`rowsWritten` are sums
 * across all of them, so `totalDurationMs / count` recovers the per-execution
 * average `recordQueryMetric`'s bucket histogram places the entry by.
 */
interface StmtSample {
    count: number;
    rowsRead: number;
    rowsWritten: number;
    totalDurationMs: number;
}

/** One path's un-flushed metric delta; see {@link FunctionMetrics.pendingFunctionMetrics}. */
interface PendingFunctionMetric {
    calls: number;
    conflicts: number;
    durationMaxMs: number;
    durationMinMs: number;
    durationTotalMs: number;
    errors: number;
    /** `JSON.stringify([table, index])` key -> dispatches that used the index. */
    indexHits: Map<string, number>;
    /** Latest dispatch time for this path; a delta never spans two minute buckets. */
    lastCalledAt: number;
    lastErrorAt: number | null;
    lastErrorMessage: string | null;
    /** table -> dispatches that full-scanned it. */
    scans: Map<string, number>;
}

/** A pending statement write: the samples of one statement that fell in one latency bucket. */
interface PendingStmtSample extends StmtSample {
    rawSql: string;
}

/**
 * What the metrics need of the shard. Thunks, because the instance is built as
 * a field initializer before the DO's constructor assigns `env` and the host.
 */
interface FunctionMetricsHost {
    /** The worker `env`, read per flush decision so the flush-cadence variable is seen as bound. */
    env: () => unknown;
    sql: () => ShardHost["sql"];
}

/**
 * Per-instance metric state. A class, like `CdcRetentionRunner`, because the
 * pending delta belongs to one DO instance: module state would merge the
 * deltas of every shard sharing the isolate.
 */
class FunctionMetrics {
    private readonly host: FunctionMetricsHost;

    /**
     * Per-function execution counters surfaced by the
     * `__lunora_admin__:getFunctionStats` RPC, keyed by `<file>:<function>`
     * path. Shares the `metrics` lifecycle: in-memory, reset on
     * hibernation/restart. `functionPath` is caller-controlled (the runtime
     * forwards it unchecked), so the map is NOT bounded by the app's registered
     * function count — every path that reaches a metrics-recording dispatch
     * lands here, including one that resolves to nothing. `recordFunctionCall`
     * therefore caps it at {@link FUNCTION_METRICS_MAX_PATHS} the same way the
     * durable `__lunora_metrics` twin caps its table. Maintained by
     * `recordFunctionCall` at the one dispatch site that also bumps the
     * aggregate `metrics` counters.
     */
    private readonly functionStats = new Map<string, FunctionCallStat>();

    /**
     * Exact per-path metric deltas not yet written to `__lunora_metrics*`. Every
     * dispatch folds in here; {@link FunctionMetrics.maybeFlushMetrics} writes the sum once
     * every N dispatches ({@link FunctionMetrics.metricsFlushEvery}, default 8), so rates stay exact
     * and only write frequency drops. In memory only: an evicted DO loses at most
     * N-1 dispatches of counters (no alarm flush).
     */
    private pendingFunctionMetrics = new Map<string, PendingFunctionMetric>();

    /**
     * Per-statement samples folded from `currentStmtSamples`, written with
     * {@link FunctionMetrics.pendingFunctionMetrics}. Keyed by statement AND the latency
     * bucket of each dispatch's own average: `recordQueryMetric` places an entry in the
     * histogram by its average, so only dispatches in the same bucket may merge (summing 19
     * fast and 1 slow dispatch would flatten the tail percentiles). The key count also
     * drives the width-based flush.
     */
    private pendingStmtSamples = new Map<string, PendingStmtSample>();

    /** Dispatches folded since the last flush. */
    private dispatchesSinceFlush = 0;

    /** Whether an errored/conflicted dispatch is pending (forces the next flush). */
    private pendingForceFlush = false;

    /** Time of the first / latest dispatch in the pending delta; `undefined` when empty. */
    private pendingStartedAt: number | undefined;

    private pendingLastAt: number | undefined;

    public constructor(host: FunctionMetricsHost) {
        this.host = host;
    }

    /**
     * Fold one dispatch into the per-function counters keyed by `functionPath`,
     * creating the entry on first sight. `errorMessage` is supplied only when
     * the handler threw, in which case the failure counters advance too. The
     * caller is expected to have already redacted `errorMessage` (via
     * `redactArgs`, the same `standardRules` treatment the request-log sinks
     * use) — this method persists/caches it verbatim into BOTH the durable
     * `__lunora_metrics.last_error_message` column and the in-memory
     * `functionStats.lastErrorMessage` served by `getFunctionStats`, so an
     * un-redacted message reaching here leaks into the Studio.
     * `scannedTables` carries the tables the dispatch full-scanned (collected by
     * `getCtxDbReadHook`), which advance the causal scan attribution.
     * `indexHits` carries the declared indexes it exercised (collected by
     * `getCtxDbIndexUseHook`, NUL-free `JSON.stringify([table, index])` keys),
     * which advance the durable `__lunora_metrics_index` hit counter behind the
     * dead-index lint. Called once per `/rpc` dispatch alongside the aggregate
     * `metrics` update.
     *
     * Two writes happen here. The in-memory {@link functionStats} map is kept
     * for the fast warm-instance path, and the durable `__lunora_metrics`
     * table is upserted so the counters survive hibernation/restart — the
     * persisted table is the source of truth the admin RPCs read from. The
     * persist is best-effort: a SQL failure (e.g. a test double without a
     * `sql` handle) must never turn a successful dispatch into a failed one,
     * so it is swallowed and the in-memory counters still advance.
     *
     * The durable write is COALESCED, not per-dispatch: the call is folded into
     * {@link FunctionMetrics.pendingFunctionMetrics} (exact counts, durations, scans and
     * index hits) and {@link FunctionMetrics.maybeFlushMetrics} writes the whole delta once
     * every N dispatches ({@link FunctionMetrics.metricsFlushEvery}; default 8; 1 = every dispatch),
     * so the durable counters stay exact and only the write frequency drops.
     */
    public recordFunctionCall(
        functionPath: string,
        durationMs: number,
        errorMessage?: string,
        scannedTables?: ReadonlySet<string>,
        indexHits?: ReadonlySet<string>,
        conflicted: boolean = false,
    ): void {
        const now = Date.now();
        const scanned = scannedTables ? [...scannedTables] : [];

        this.foldFunctionMetric(functionPath, durationMs, now, errorMessage, scanned, indexHits, conflicted);

        const existing = this.functionStats.get(functionPath);
        const stat: FunctionCallStat = existing ?? {
            calls: 0,
            conflicts: 0,
            errors: 0,
            lastCalledAt: now,
            // eslint-disable-next-line unicorn/no-null -- wire shape: `null` until the function first throws
            lastErrorAt: null,
            // eslint-disable-next-line unicorn/no-null -- wire shape: `null` until the function first throws
            lastErrorMessage: null,
            maxDurationMs: 0,
            path: functionPath,
            scannedTables: [],
            scans: 0,
            totalDurationMs: 0,
        };

        stat.calls += 1;
        stat.totalDurationMs += durationMs;
        stat.maxDurationMs = Math.max(stat.maxDurationMs, durationMs);
        stat.lastCalledAt = now;

        // Fold the dispatch's full-scan attribution into the in-memory stat so
        // the warm-instance fallback (used when the durable read fails) carries
        // the causal data too — via the same `mergeScanAttribution` rule the
        // durable `__lunora_metrics_scans` upsert uses, so the two can't drift.
        if (scanned.length > 0) {
            stat.scans += scanned.length;
            mergeScanAttribution(stat.scannedTables, scanned);
        }

        if (errorMessage !== undefined) {
            stat.errors += 1;
            stat.lastErrorAt = now;
            stat.lastErrorMessage = errorMessage;
        }

        if (conflicted) {
            stat.conflicts += 1;
        }

        if (existing === undefined) {
            // Distinct-path cap, mirroring the durable twin's
            // `FUNCTION_METRICS_MAX_PATHS` admission rule: `functionPath` is
            // caller-controlled, and the recording paths that never resolve it
            // (the idempotency cache hit, the watermark short-circuit) can be
            // driven with a fresh path per request. Refuse the new path rather
            // than evict — protecting the incumbents is the reason the cap
            // exists, exactly as `admitPath` argues on the durable side.
            if (this.functionStats.size >= FUNCTION_METRICS_MAX_PATHS) {
                return;
            }

            this.functionStats.set(functionPath, stat);
        }
    }

    /**
     * Fold the per-DISTINCT-statement SQL samples accumulated during the current
     * dispatch into {@link FunctionMetrics.pendingStmtSamples}. Called after
     * `recordFunctionCall` on both the success and error paths, followed by
     * {@link FunctionMetrics.maybeFlushMetrics}.
     *
     * Already folded by the instrumented `sql` getter (see `currentStmtSamples`);
     * `count` carries the real execution count so the durable
     * `exec_count`/`total_duration_ms` still reflect every execution. Pure
     * in-memory; nothing is written until the flush. Clearing `currentStmtSamples`
     * happens in the `finally` block of the dispatch path, not here.
     */
    public foldStmtSamples(samples: ReadonlyMap<string, StmtSample>): void {
        if (samples.size === 0) {
            return;
        }

        for (const [rawSql, sample] of samples) {
            // Keyed by the dispatch's own latency bucket (the one `recordQueryMetric`
            // places the entry in), so same-bucket dispatches merge into one write
            // while a slow dispatch stays in its own bucket.
            const key = `${String(latencyBucketIndex(sample.totalDurationMs / sample.count))}:${rawSql}`;
            const pending = this.pendingStmtSamples.get(key);

            if (pending === undefined) {
                this.pendingStmtSamples.set(key, { ...sample, rawSql });
            } else {
                pending.count += sample.count;
                pending.rowsRead += sample.rowsRead;
                pending.rowsWritten += sample.rowsWritten;
                pending.totalDurationMs += sample.totalDurationMs;
            }
        }
    }

    /**
     * Write the pending metric delta when this dispatch is due: every
     * N dispatches ({@link FunctionMetrics.metricsFlushEvery}), immediately after an errored or
     * conflicted one, or when the pending statement set is as wide as one
     * dispatch may be. (A minute-boundary crossing flushes earlier, inside
     * {@link FunctionMetrics.foldFunctionMetric}.) Counts are exact either way; at most
     * N-1 dispatches of counters are lost if the DO is evicted before a flush.
     */
    public maybeFlushMetrics(): void {
        if (this.dispatchesSinceFlush === 0 && this.pendingStmtSamples.size === 0) {
            return;
        }

        if (this.pendingForceFlush || this.dispatchesSinceFlush >= this.metricsFlushEvery() || this.pendingStmtSamples.size >= MAX_STMT_SAMPLES_PER_DISPATCH) {
            this.flushPendingMetrics();
        }
    }

    /** Write any coalesced delta so an admin read of the durable metric tables is never stale. */
    public flushUnwrittenMetrics(): void {
        if (this.dispatchesSinceFlush > 0 || this.pendingStmtSamples.size > 0) {
            this.flushPendingMetrics();
        }
    }

    /**
     * Assemble the per-function readout served by
     * `__lunora_admin__:getFunctionStats`, sorted most-recently-called first so
     * the busiest functions surface at the top of the studio table.
     *
     * Reads from the durable `__lunora_metrics` table — the source of truth —
     * so the counts reflect the function's lifetime, not just calls since this
     * instance woke. Falls back to the in-memory map only if the durable read
     * throws (e.g. a test double without a usable `sql` handle), keeping the
     * warm-instance counters available even then. The wire shape is unchanged
     * (`{ functions, sinceMs }`), so existing studio/runtime consumers keep
     * working; the rows are now backed by persisted data.
     */
    public collectFunctionStats(sinceMs: number): FunctionStatsResult {
        this.flushUnwrittenMetrics();

        try {
            const functions = readFunctionMetrics(this.host.sql());

            return { functions, sinceMs };
        } catch {
            const functions = [...this.functionStats.values()].toSorted((a, b) => b.lastCalledAt - a.lastCalledAt);

            return { functions, sinceMs };
        }
    }

    /**
     * Per-function coarse time-series served additively by the metrics RPC, so
     * the studio can chart call/error history. Reads the durable
     * `__lunora_metrics_buckets` table; returns an empty, non-truncated result
     * when persistence is unavailable so the response stays well-formed.
     */
    public collectFunctionMetricBuckets(): FunctionMetricBucketsResult {
        this.flushUnwrittenMetrics();

        try {
            return readFunctionMetricBuckets(this.host.sql());
        } catch {
            return { buckets: [], truncated: false };
        }
    }

    /** Fold one completed dispatch into {@link FunctionMetrics.pendingFunctionMetrics}. */
    private foldFunctionMetric(
        functionPath: string,
        durationMs: number,
        now: number,
        errorMessage: string | undefined,
        scanned: ReadonlyArray<string>,
        indexHits: ReadonlySet<string> | undefined,
        conflicted: boolean,
    ): void {
        // A delta is written under ONE minute bucket (the last call's), so close
        // out the pending delta before a dispatch from a later minute joins it.
        if (
            this.pendingStartedAt !== undefined &&
            Math.floor(now / FUNCTION_METRICS_BUCKET_MS) !== Math.floor(this.pendingStartedAt / FUNCTION_METRICS_BUCKET_MS)
        ) {
            this.flushPendingMetrics();
        }

        let pending = this.pendingFunctionMetrics.get(functionPath);

        // A new path at the cap flushes first so this dispatch (an error included) is
        // recorded rather than dropped.
        if (pending === undefined && this.pendingFunctionMetrics.size >= FUNCTION_METRICS_MAX_PATHS) {
            this.flushPendingMetrics();
        }

        this.pendingStartedAt ??= now;
        this.pendingLastAt = now;
        this.dispatchesSinceFlush += 1;

        if (errorMessage !== undefined || conflicted) {
            this.pendingForceFlush = true;
        }

        if (pending === undefined) {
            pending = {
                calls: 0,
                conflicts: 0,
                durationMaxMs: durationMs,
                durationMinMs: durationMs,
                durationTotalMs: 0,
                errors: 0,
                indexHits: new Map(),
                lastCalledAt: now,
                // eslint-disable-next-line unicorn/no-null -- wire shape: `null` until the function first throws
                lastErrorAt: null,
                // eslint-disable-next-line unicorn/no-null -- wire shape: `null` until the function first throws
                lastErrorMessage: null,
                scans: new Map(),
            };
            this.pendingFunctionMetrics.set(functionPath, pending);
        }

        pending.calls += 1;
        pending.durationTotalMs += durationMs;
        pending.lastCalledAt = now;
        pending.durationMinMs = Math.min(pending.durationMinMs, durationMs);
        pending.durationMaxMs = Math.max(pending.durationMaxMs, durationMs);
        if (errorMessage !== undefined) {
            pending.errors += 1;
            pending.lastErrorAt = now;
            pending.lastErrorMessage = errorMessage;
        }

        if (conflicted) {
            pending.conflicts += 1;
        }

        for (const table of new Set(scanned)) {
            pending.scans.set(table, (pending.scans.get(table) ?? 0) + 1);
        }

        // Each entry is a `JSON.stringify([table, index])` key stamped by the
        // index-use hook; one hit per distinct `(table, index)` per dispatch.
        for (const key of indexHits ?? []) {
            pending.indexHits.set(key, (pending.indexHits.get(key) ?? 0) + 1);
        }
    }

    /**
     * Persist the pending delta: one `recordFunctionMetric` per path and one
     * `recordQueryMetric` per (statement, latency bucket) key, so the
     * histogram still sees each dispatch's own average. The accumulators are swapped out
     * first, so a write that throws DROPS that path's (or entry's) delta and the rest
     * of the batch is still written. There is deliberately no retry: metrics are
     * best-effort, `recordFunctionMetric` is several statements per path and the host
     * exposes no synchronous transaction, so a retry after a partial write would double
     * count, and a persistent failure would grow the pending set without bound. One
     * warning per flush reports what was dropped. Never fails the request.
     */
    private flushPendingMetrics(): void {
        const functions = this.pendingFunctionMetrics;
        const statements = this.pendingStmtSamples;
        const ts = this.pendingLastAt ?? Date.now();

        this.pendingFunctionMetrics = new Map();
        this.pendingStmtSamples = new Map();
        this.pendingStartedAt = undefined;
        this.pendingLastAt = undefined;
        this.pendingForceFlush = false;
        this.dispatchesSinceFlush = 0;

        let droppedFunctions = 0;
        let droppedStatements = 0;
        let firstError: unknown;

        for (const [path, delta] of functions) {
            try {
                recordFunctionMetric(this.host.sql(), {
                    calls: delta.calls,
                    conflicts: delta.conflicts,
                    durationMaxMs: delta.durationMaxMs,
                    durationMinMs: delta.durationMinMs,
                    durationMs: delta.durationTotalMs,
                    durationTotalMs: delta.durationTotalMs,
                    errored: delta.errors > 0,
                    errorMessage: delta.lastErrorMessage ?? undefined,
                    errors: delta.errors,
                    indexHitCounts: [...delta.indexHits]
                        .map(([key, count]) => {
                            return { count, hit: decodeIndexHitKey(key) };
                        })
                        .filter((entry): entry is { count: number; hit: IndexHit } => entry.hit !== undefined)
                        .map(({ count, hit }) => {
                            return { ...hit, count };
                        }),
                    lastErrorAt: delta.lastErrorAt,
                    path,
                    scanCounts: [...delta.scans].map(([table, count]) => {
                        return { count, table };
                    }),
                    ts: delta.lastCalledAt,
                });
            } catch (error) {
                droppedFunctions += 1;
                firstError ??= error;
            }
        }

        const sqlHandle = this.host.sql() as unknown as SqlExec;

        for (const sample of statements.values()) {
            try {
                recordQueryMetric(sqlHandle, sample.rawSql, sample.totalDurationMs, sample.rowsRead, sample.rowsWritten, ts, sample.count);
            } catch (error) {
                droppedStatements += 1;
                firstError ??= error;
            }
        }

        if (droppedFunctions > 0 || droppedStatements > 0) {
            const message = firstError instanceof Error ? firstError.message : String(firstError);

            // eslint-disable-next-line no-console -- one operational warning per flush: metrics are best-effort and a dropped delta must not be silent
            console.warn(
                `[@lunora/do] metric write failed, dropped ${String(droppedFunctions)} function deltas and ${String(droppedStatements)} statement samples: ${message}`,
            );
        }
    }

    /**
     * Dispatches per durable metric write (env `LUNORA_METRICS_FLUSH_EVERY`): a positive
     * integer, default {@link DEFAULT_METRICS_FLUSH_EVERY} (8). Unset, blank, fractional,
     * non-numeric or < 1 values fall back to the default. An evicted DO loses at most N-1
     * dispatches of un-flushed counters (7 by default); errored or conflicted dispatches
     * and minute-boundary crossings still flush immediately. Set 1 to write every dispatch.
     */
    private metricsFlushEvery(): number {
        // A bare number in wrangler config arrives as a number, not a string.
        const raw = ((this.host.env() ?? {}) as { LUNORA_METRICS_FLUSH_EVERY?: unknown }).LUNORA_METRICS_FLUSH_EVERY;
        let value = Number.NaN;

        if (typeof raw === "number") {
            value = raw;
        } else if (typeof raw === "string" && raw.trim() !== "") {
            value = Number(raw);
        }

        return Number.isInteger(value) && value >= 1 ? value : DEFAULT_METRICS_FLUSH_EVERY;
    }
}

export type { StmtSample };
export { FunctionMetrics, MAX_STMT_SAMPLES_PER_DISPATCH };
