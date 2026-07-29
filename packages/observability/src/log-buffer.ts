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
    /** Structured fields from a `ctx.log.&lt;level>(message, fields)` / `ctx.log.with(fields)` call, when present. */
    fields?: Record<string, unknown>;
    functionPath?: string;
    instance?: string;
    level: LogLevel;
    message: string;
    timestamp: number;
}

const DEFAULT_CAPACITY = 500;

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

    public constructor(capacity: number = DEFAULT_CAPACITY) {
        // Guard against a zero/negative capacity silently disabling capture.
        this.capacity = capacity > 0 ? Math.trunc(capacity) : DEFAULT_CAPACITY;
    }

    /** Number of entries currently buffered. */
    public get size(): number {
        return this.buffer.length;
    }

    /** Drop every buffered entry. */
    public clear(): void {
        this.buffer.length = 0;
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
        }
    }
}

export { LogBuffer };
export type { LogEntry, LogLevel };
