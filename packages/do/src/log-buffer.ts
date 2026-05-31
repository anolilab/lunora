/** Severity of a buffered log entry, mirroring the usual console levels. */
export type LogLevel = "debug" | "error" | "info" | "warn";

/**
 * One buffered log line. `functionPath` is the RPC that produced it (when the
 * entry came from the RPC dispatch site); `timestamp` is `Date.now()` at the
 * moment it was pushed.
 */
export interface LogEntry {
    functionPath?: string;
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
 * or restarts. It is a "recent activity on this instance" readout, not a
 * durable log store — durable log shipping would be a separate, heavier
 * feature. Capacity is fixed at construction; once full, the oldest entry is
 * evicted to make room (FIFO), so memory stays bounded regardless of traffic.
 */
export class LogBuffer {
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
