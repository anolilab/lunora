import type { ContextLogLevel } from "../../../shared/log-event";

/**
 * Severity of a buffered log entry — the full seven-tier `ctx.log` ramp
 * (`trace`→`fatal`), not a console-shaped subset. The buffer used to fold the
 * ramp onto four tiers, which made `trace` and `fatal` lines indistinguishable
 * from `debug` and `error` in the Studio Logs panel; it now stores the level the
 * caller actually logged at. Container-lifecycle entries only ever use
 * `info`/`error`, which remain part of the union.
 */
type LogLevel = ContextLogLevel;

/**
 * One buffered log line. `functionPath` is the RPC that produced it (when the
 * entry came from the RPC dispatch site); `timestamp` is `Date.now()` at the
 * moment it was pushed. `instance`/`exitCode` are populated for container
 * lifecycle entries: `instance` correlates the per-instance Durable Object id,
 * `exitCode` carries the process exit code parsed out of a `stop` event.
 */
interface LogEntry {
    exitCode?: number;
    /** Structured fields from a `ctx.log.<level>(message, fields)` / `ctx.log.with(fields)` call, when present. */
    fields?: Record<string, unknown>;
    functionPath?: string;
    instance?: string;
    level: LogLevel;
    message: string;
    timestamp: number;

    /** Trace the line was emitted under; absent outside a dispatch (container lifecycle, hibernation-path errors). What the Studio joins a log line to its waterfall on. */
    traceId?: string;
}

/** Default ring size for both in-memory buffers — `SpanBuffer` imports it from here alongside {@link normalizeCapacity}. */
const DEFAULT_CAPACITY = 500;

/**
 * Normalize a caller-supplied ring capacity to a usable integer. Shared with
 * `span-buffer.ts`, which imposes the identical bound on the identical ring.
 *
 * `> 0` alone was not enough, in both directions. A fractional capacity passed
 * that test and then truncated to ZERO, so the ring evicted every entry it was
 * handed and capture was silently off. `Infinity` passed it too and truncates to
 * itself, removing the memory bound the ring exists to impose — on a buffer that
 * lives for the life of a Durable Object.
 *
 * Anything not a finite value of at least 1 therefore falls back to the default
 * rather than being coerced into a degenerate ring.
 */
const normalizeCapacity = (capacity: number): number => (Number.isFinite(capacity) && capacity >= 1 ? Math.trunc(capacity) : DEFAULT_CAPACITY);

/**
 * A bounded, in-memory ring buffer of recent {@link LogEntry} records.
 *
 * In-memory only: like the metrics counters on `ShardDO`, the buffer is a field
 * on the live Durable Object instance and so resets whenever the DO hibernates
 * or restarts. It is a "recent activity on this instance" readout (for the
 * studio's live log panel), NOT a durable log store or a transport.
 * Production log shipping is the platform's job, not ours: use Cloudflare
 * **Workers Logs** (retained, queryable in the studio), **Logpush** (stream
 * to R2 / a SIEM / a log service), or a **Tail Worker** for programmatic
 * capture. Lunora deliberately does not reimplement any of those — this buffer
 * stays a tiny dev/ops readout. Capacity is fixed at construction; once full,
 * the oldest entry is evicted to make room (FIFO), so memory stays bounded
 * regardless of traffic.
 */
class LogBuffer {
    /** Backing store, kept in insertion order (oldest first). */
    private readonly buffer: LogEntry[] = [];

    private readonly capacity: number;

    /** How many entries the ring has evicted since it was last cleared. */
    private droppedCount = 0;

    public constructor(capacity: number = DEFAULT_CAPACITY) {
        this.capacity = normalizeCapacity(capacity);
    }

    /**
     * Entries evicted for capacity since the last {@link LogBuffer.clear}.
     *
     * Without it a full ring is indistinguishable from a quiet instance that
     * happened to log exactly `capacity` lines: the reader sees 500 entries
     * either way and cannot tell whether 500 lines happened or 50,000 did. The
     * count is what turns "the newest 500" into an honest statement.
     */
    public get dropped(): number {
        return this.droppedCount;
    }

    /** Number of entries currently buffered. */
    public get size(): number {
        return this.buffer.length;
    }

    /** Drop every buffered entry, including the eviction count. */
    public clear(): void {
        this.buffer.length = 0;
        this.droppedCount = 0;
    }

    /**
     * Snapshot of the buffered entries, **newest first** so the panel renders
     * the most recent activity at the top without re-sorting. Returns a fresh
     * array each call; the caller may mutate it freely.
     */
    public entries(): LogEntry[] {
        return this.buffer.toReversed();
    }

    /**
     * Append an entry, evicting the oldest when at capacity so the buffer never
     * grows past its bound.
     */
    public push(entry: LogEntry): void {
        this.buffer.push(entry);

        if (this.buffer.length > this.capacity) {
            this.buffer.shift();
            this.droppedCount += 1;
        }
    }
}

export { DEFAULT_CAPACITY, LogBuffer, normalizeCapacity };
export type { LogEntry, LogLevel };
