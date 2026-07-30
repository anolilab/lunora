/**
 * Per-transaction resource meter.
 *
 * A Durable Object is a single-threaded process with a hard memory ceiling, so
 * one unbounded mutation — a scan that materializes a whole table, a loop that
 * writes a million rows — takes the entire shard down with it. Every other
 * caller on that shard fails, and the only diagnostic is an isolate that
 * disappeared. That is a bad way to learn a query needed an index.
 *
 * This meter turns that failure into a bounded, attributable one: reads and
 * writes are counted as they happen, and the transaction is stopped with a
 * `TRANSACTION_LIMIT_EXCEEDED` naming the ceiling it hit. Overshoot is
 * impossible to avoid entirely — a limit is only observed once the work that
 * crossed it is done — so the caps are set well below what a DO can actually
 * survive.
 *
 * The counters are cumulative per transaction and deliberately have no rollback
 * path. A savepoint restore rewinds the *logical* footprint (what the
 * transaction will commit), but the bytes were materialized either way and the
 * ceiling exists to protect the isolate that had to hold them — so a meter that
 * rewound could not bound a retry loop. If a savepoint-aware caller ever needs
 * one, add it then, with a test for the loop it is meant to bound.
 */

import { LunoraError } from "@lunora/errors";

import { estimateBytes } from "./estimate-bytes";

/** Ceilings for one transaction. Every field is a hard stop, not a target. */
interface TransactionLimits {
    /** Maximum documents a single transaction may read. */
    maxReadRows: number;
    /** Maximum serialized bytes a single transaction may write. */
    maxWrittenBytes: number;
    /** Maximum documents a single transaction may write. */
    maxWrittenRows: number;
}

/** What a transaction has consumed, and what remains before each ceiling. */
interface TransactionHeadroom {
    readRows: number;
    remainingReadRows: number;
    remainingWrittenBytes: number;
    remainingWrittenRows: number;
    writtenBytes: number;
    writtenRows: number;
}

/**
 * Defaults sized for a Cloudflare Durable Object (128 MiB isolate).
 *
 * The byte cap is the load-bearing one: 32 MiB of serialized documents leaves
 * room for the JS-object expansion of that same data (roughly 2–4x), the SQLite
 * page cache, and the rest of the runtime. The row caps are secondary — they
 * catch pathological loops over small documents that would otherwise burn the
 * whole request budget before the byte cap noticed.
 */
const DEFAULT_TRANSACTION_LIMITS: TransactionLimits = {
    maxReadRows: 100_000,
    maxWrittenBytes: 32 * 1024 * 1024,
    maxWrittenRows: 50_000,
};

class TransactionHeadroomTracker {
    private readRows = 0;

    private writtenRows = 0;

    private writtenBytes = 0;

    private readonly limits: TransactionLimits;

    public constructor(limits: Partial<TransactionLimits> = {}) {
        this.limits = { ...DEFAULT_TRANSACTION_LIMITS, ...limits };
    }

    /**
     * Charge `count` documents against the read ceiling.
     *
     * Called with the size of each result set rather than once per row, so a
     * page of 500 rows costs one call. The check runs after the increment: the
     * rows are already materialized by the time we hear about them, and the
     * point is to stop the NEXT read, not to pretend this one did not happen.
     */
    public recordRead(count: number): void {
        this.readRows += count;

        if (this.readRows > this.limits.maxReadRows) {
            throw new LunoraError(
                "TRANSACTION_LIMIT_EXCEEDED",
                `this transaction read ${String(this.readRows)} documents, over the ${String(this.limits.maxReadRows)}-document limit`,
            );
        }
    }

    /** Charge one written document, sized by {@link estimateBytes}. */
    public recordWrite(row: unknown): void {
        this.writtenRows += 1;
        this.writtenBytes += estimateBytes(row, this.limits.maxWrittenBytes);

        if (this.writtenRows > this.limits.maxWrittenRows) {
            throw new LunoraError(
                "TRANSACTION_LIMIT_EXCEEDED",
                `this transaction wrote ${String(this.writtenRows)} documents, over the ${String(this.limits.maxWrittenRows)}-document limit`,
            );
        }

        if (this.writtenBytes > this.limits.maxWrittenBytes) {
            throw new LunoraError(
                "TRANSACTION_LIMIT_EXCEEDED",
                `this transaction wrote ${String(this.writtenBytes)} bytes, over the ${String(this.limits.maxWrittenBytes)}-byte limit`,
            );
        }
    }

    /** Current consumption and what is left before each ceiling (never negative). */
    public headroom(): TransactionHeadroom {
        return {
            readRows: this.readRows,
            remainingReadRows: Math.max(0, this.limits.maxReadRows - this.readRows),
            remainingWrittenBytes: Math.max(0, this.limits.maxWrittenBytes - this.writtenBytes),
            remainingWrittenRows: Math.max(0, this.limits.maxWrittenRows - this.writtenRows),
            writtenBytes: this.writtenBytes,
            writtenRows: this.writtenRows,
        };
    }
}

export { DEFAULT_TRANSACTION_LIMITS, TransactionHeadroomTracker };
export type { TransactionHeadroom, TransactionLimits };
