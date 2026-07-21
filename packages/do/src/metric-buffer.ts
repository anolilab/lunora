/**
 * In-memory aggregation of application metrics (`ctx.metrics.*`) backing the
 * studio's Metrics panel.
 *
 * Same field-on-the-instance contract and hibernation caveat as
 * {@link file://./log-buffer.ts} and {@link file://./span-buffer.ts}: it lives on
 * the live Durable Object instance and resets on hibernation or restart. It is a
 * "recent metrics on this instance" readout for local development, NOT a durable
 * metric store — production aggregation is the sink's job, shipping measurements
 * to a collector that retains and indexes series across instances and time.
 *
 * Where the log and span buffers keep a bounded ring of raw *events*, this folds
 * them: a metric's value IS its aggregate over a window, so a bounded ring of raw
 * samples could never represent one — the oldest samples, which a ring evicts
 * first, are exactly the ones a running total needs. Instead this keeps one
 * running aggregate per *series* (name + kind + dimensions) and bounds by the
 * number of distinct series, not the number of samples: a series folds
 * arbitrarily many measurements into O(1) state, so the readout stays faithful
 * for a hot counter while staying bounded against high-cardinality dimensions.
 */
import { stableStringify } from "../../../shared/stable-key";
import type { LogFields } from "../../../shared/log-fields";
import type { MetricEvent, MetricKind } from "../../../shared/metric-event";

/** Default number of distinct series retained; least-recently-updated evicted first. */
const DEFAULT_CAPACITY = 256;

/**
 * One aggregated metric series: every measurement sharing a `(name, kind,
 * attributes)` identity folded into a single running summary.
 *
 * All fields are maintained for every {@link MetricKind} — the fold is uniform
 * and O(1), and letting the panel choose the meaningful projection per kind
 * (counter → `sum`, gauge → `last`, histogram → `sum`/`count` for the mean, plus
 * `min`/`max`) is cheaper and clearer than branching on kind at record time.
 */
export interface MetricSeries {
    /** The series' dimensions, if any — the attributes that made it distinct. */
    attributes?: LogFields;
    /** Number of measurements folded into this series. */
    count: number;
    /** Trace id of the most recent measurement that carried one — the series' exemplar, for linking to a trace. */
    exemplarTraceId?: string;
    /** Wall-clock millis of the first measurement folded in. */
    firstTs: number;
    /** Function path that recorded the series' most recent measurement. */
    functionPath: string;
    /** Instrument kind; decides which projection the panel shows. */
    kind: MetricKind;
    /** Most recent measured value — the current reading for a `gauge`. */
    last: number;
    /** Wall-clock millis of the most recent measurement. */
    lastTs: number;
    /** Largest measured value seen. */
    max: number;
    /** Smallest measured value seen. */
    min: number;
    /** Instrument name, e.g. `"orders.placed"`. */
    name: string;
    /** Shard key for single-shard calls; absent for the unnamed root DO. */
    shardKey?: string;
    /** Sum of measured values — a `counter`'s total, a `histogram`'s sum. */
    sum: number;
}

/**
 * Stable identity for a series: kind, name, then the code-point-sorted encoding
 * of its dimensions so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` fold together. The
 * NUL (`\u0000`) separator can't occur in a metric name, so distinct series never
 * collide. `stableStringify` is fed already-normalized JSON-safe `LogFields`, so
 * its fail-loud path is unreachable here; the caller still records best-effort.
 *
 * Exported and shared with the durable {@link file://./metric-history.ts} rollups:
 * the live buffer and the history MUST agree byte-for-byte on what "one series"
 * is, or the studio's live↔history join silently mismatches. One shared function
 * makes that guarantee structural rather than a comment across two copies.
 */
export const metricSeriesKey = (event: MetricEvent): string => `${event.kind}\u0000${event.name}\u0000${stableStringify(event.attributes ?? {})}`;

/**
 * A bounded map of running metric aggregates, keyed by series identity. Eviction
 * is least-recently-*updated*: a re-recorded series moves back to the tail (Map
 * insertion order), so the capacity bound sheds cold, high-cardinality series and
 * keeps the ones still receiving traffic — the opposite of a raw ring, which
 * would evict a hot counter's own history.
 */
export class MetricBuffer {
    private readonly capacity: number;

    private readonly series = new Map<string, MetricSeries>();

    public constructor(capacity: number = DEFAULT_CAPACITY) {
        this.capacity = capacity > 0 ? Math.trunc(capacity) : DEFAULT_CAPACITY;
    }

    /** Number of distinct series currently aggregated. */
    public get size(): number {
        return this.series.size;
    }

    /** Drop every aggregated series. */
    public clear(): void {
        this.series.clear();
    }

    /**
     * Snapshot of the aggregated series, most-recently-updated first, each a fresh
     * copy so a caller can't mutate the live aggregate. `series` is kept in
     * update order (tail = newest), so one reverse yields newest-first.
     */
    public entries(): MetricSeries[] {
        return [...this.series.values()].reverse().map((s) => ({ ...s }));
    }

    /** Fold one measurement into its series, creating or updating the aggregate. */
    public push(event: MetricEvent): void {
        const key = metricSeriesKey(event);
        const existing = this.series.get(key);

        if (existing === undefined) {
            // Evict the least-recently-updated series (Map's oldest key) before
            // inserting a new one at capacity, bounding distinct-series growth.
            if (this.series.size >= this.capacity) {
                const oldest = this.series.keys().next().value;

                if (oldest !== undefined) {
                    this.series.delete(oldest);
                }
            }

            this.series.set(key, {
                ...(event.attributes === undefined ? {} : { attributes: event.attributes }),
                count: 1,
                ...(event.traceId === undefined ? {} : { exemplarTraceId: event.traceId }),
                firstTs: event.ts,
                functionPath: event.functionPath,
                kind: event.kind,
                last: event.value,
                lastTs: event.ts,
                max: event.value,
                min: event.value,
                name: event.name,
                ...(event.shardKey === undefined ? {} : { shardKey: event.shardKey }),
                sum: event.value,
            });

            return;
        }

        // Re-key to the tail so this series counts as most-recently-updated for
        // eviction: delete + set is the only way to move a Map entry's position.
        this.series.delete(key);
        existing.count += 1;
        existing.sum += event.value;
        existing.min = Math.min(existing.min, event.value);
        existing.max = Math.max(existing.max, event.value);
        existing.last = event.value;
        existing.lastTs = event.ts;
        existing.functionPath = event.functionPath;

        // Latest exemplar wins: a later measurement carrying a trace replaces the
        // series' link; one without a trace leaves the prior exemplar intact.
        if (event.traceId !== undefined) {
            existing.exemplarTraceId = event.traceId;
        }

        this.series.set(key, existing);
    }
}
