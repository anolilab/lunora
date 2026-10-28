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
    /** Maximum encoded document bytes a single transaction may read. */
    maxReadBytes: number;
    /** Maximum documents a single transaction may read. */
    maxReadRows: number;
    /** Maximum serialized bytes a single transaction may write. */
    maxWrittenBytes: number;
    /** Maximum documents a single transaction may write. */
    maxWrittenRows: number;
}

/** What a transaction has consumed, and what remains before each ceiling. */
interface TransactionHeadroom {
    readBytes: number;
    readRows: number;
    remainingReadBytes: number;
    remainingReadRows: number;
    remainingWrittenBytes: number;
    remainingWrittenRows: number;
    writtenBytes: number;
    writtenRows: number;
}

/** Which ceiling a {@link TransactionLimitWarning} is about. */
type TransactionLimitKind = "readBytes" | "readRows" | "writtenBytes" | "writtenRows";

/** A transaction crossed {@link NEAR_LIMIT_RATIO} of one ceiling without breaching it. */
interface TransactionLimitWarning {
    kind: TransactionLimitKind;
    limit: number;
    used: number;
}

/**
 * Defaults sized for a Cloudflare Durable Object (128 MiB isolate).
 *
 * The byte caps are the load-bearing ones: 32 MiB of serialized documents leaves
 * room for the JS-object expansion of that same data (roughly 2–4x), the SQLite
 * page cache, and the rest of the runtime. Reads get the same budget for the
 * same reason — 100k large documents exhaust the isolate long before the row
 * cap notices. The row caps are secondary — they catch pathological loops over
 * small documents that would otherwise burn the whole request budget before the
 * byte caps noticed.
 */
const DEFAULT_TRANSACTION_LIMITS: TransactionLimits = {
    maxReadBytes: 32 * 1024 * 1024,
    maxReadRows: 100_000,
    maxWrittenBytes: 32 * 1024 * 1024,
    maxWrittenRows: 50_000,
};

/**
 * Share of a ceiling at which the meter warns. Dev data is usually far smaller
 * than prod data, so a transaction that only ever reaches 80% locally is the one
 * that fails after deploy; the warning is how that shows up before it does.
 */
const NEAR_LIMIT_RATIO = 0.8;

const LIMIT_OF: Record<TransactionLimitKind, keyof TransactionLimits> = {
    readBytes: "maxReadBytes",
    readRows: "maxReadRows",
    writtenBytes: "maxWrittenBytes",
    writtenRows: "maxWrittenRows",
};

const OVERRUN_MESSAGE: Record<TransactionLimitKind, (used: string, limit: string) => string> = {
    readBytes: (used, limit) => `this transaction read ${used} bytes, over the ${limit}-byte limit`,
    readRows: (used, limit) => `this transaction read ${used} documents, over the ${limit}-document limit`,
    writtenBytes: (used, limit) => `this transaction wrote ${used} bytes, over the ${limit}-byte limit`,
    writtenRows: (used, limit) => `this transaction wrote ${used} documents, over the ${limit}-document limit`,
};

class TransactionHeadroomTracker {
    private readBytes = 0;

    private readRows = 0;

    private writtenRows = 0;

    private writtenBytes = 0;

    private readonly limits: TransactionLimits;

    private readonly onNearLimit: ((warning: TransactionLimitWarning) => void) | undefined;

    /** Kinds already warned about, so a loop near a ceiling warns once rather than once per row. */
    private readonly warned = new Set<TransactionLimitKind>();

    public constructor(limits: Partial<TransactionLimits> = {}, onNearLimit?: (warning: TransactionLimitWarning) => void) {
        this.limits = { ...DEFAULT_TRANSACTION_LIMITS, ...limits };
        this.onNearLimit = onNearLimit;
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
        this.check("readRows", this.readRows);
    }

    /**
     * Charge `bytes` of encoded documents against the read-byte ceiling. Sized
     * by the stored JSON's length — the same unit {@link estimateBytes} charges
     * writes in — so a read costs no second serialization.
     */
    public recordReadBytes(bytes: number): void {
        this.readBytes += bytes;
        this.check("readBytes", this.readBytes);
    }

    /** Charge one written document, sized by {@link estimateBytes}. */
    public recordWrite(row: unknown): void {
        const bytes = estimateBytes(row);

        // Measure, then validate, then charge. A value `estimateBytes` cannot
        // size (a cycle, a function) has no honest byte count to charge —
        // treating it as free, or as the whole cap (the old behavior), both hide
        // the real problem. It is also never written, so it must not move either
        // counter: charging the row first left a caller that catches this and
        // continues carrying a phantom row against `maxWrittenRows`. The two
        // ceilings below are the opposite case — that work already happened, so
        // they charge first and complain after.
        if (bytes === undefined) {
            throw new LunoraError("BAD_REQUEST", "this document is not JSON-serializable (cyclic or non-JSON value); it cannot be written");
        }

        this.writtenRows += 1;
        this.writtenBytes += bytes;
        this.check("writtenRows", this.writtenRows);
        this.check("writtenBytes", this.writtenBytes);
    }

    /** Current consumption and what is left before each ceiling (never negative). */
    public headroom(): TransactionHeadroom {
        return {
            readBytes: this.readBytes,
            readRows: this.readRows,
            remainingReadBytes: Math.max(0, this.limits.maxReadBytes - this.readBytes),
            remainingReadRows: Math.max(0, this.limits.maxReadRows - this.readRows),
            remainingWrittenBytes: Math.max(0, this.limits.maxWrittenBytes - this.writtenBytes),
            remainingWrittenRows: Math.max(0, this.limits.maxWrittenRows - this.writtenRows),
            writtenBytes: this.writtenBytes,
            writtenRows: this.writtenRows,
        };
    }

    private check(kind: TransactionLimitKind, used: number): void {
        const limit = this.limits[LIMIT_OF[kind]];

        if (used > limit) {
            throw new LunoraError("TRANSACTION_LIMIT_EXCEEDED", OVERRUN_MESSAGE[kind](String(used), String(limit)));
        }

        if (used >= limit * NEAR_LIMIT_RATIO && !this.warned.has(kind)) {
            this.warned.add(kind);
            // A warning sink is telemetry: it must never turn a transaction that
            // fits into a failed one.
            try {
                this.onNearLimit?.({ kind, limit, used });
            } catch {
                // Swallowed for the reason above.
            }
        }
    }
}

export { DEFAULT_TRANSACTION_LIMITS, TransactionHeadroomTracker };
export type { TransactionHeadroom, TransactionLimitKind, TransactionLimits, TransactionLimitWarning };
