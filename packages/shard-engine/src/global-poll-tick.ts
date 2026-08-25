/**
 * One `.global()` shape poll tick.
 *
 * A tick is an accumulator every stage of the poll writes into — the changelog's
 * answer for this pass, the per-tick membership read cache, the skip count, and
 * whether anything failed to settle. It is a class rather than a plain record
 * because those writes come from four unrelated call sites, and as bare mutable
 * fields each one had to restate what it was doing (and suppress the lint rule
 * that objects to writing through a parameter). Methods name the writes instead.
 *
 * Host-neutral: it holds a `Set`, a `Map` and two counters, and reaches nothing.
 */

import type { ShapeRow } from "./ctx-db-shapes";

class GlobalPollTick {
    /**
     * The changelog's answer for this tick, or `undefined` for "no visibility".
     *
     * The absence is meaningful and is NOT the same as an empty set: `undefined`
     * means read everything (a cold instance, a backend without CDC, a resync
     * pass), while an empty set means nothing changed and every shape may be
     * skipped. {@link GlobalPollTick.shouldRead} is the only reader, so no caller
     * has to get that distinction right twice.
     */
    private readonly changedTables: Set<string> | undefined;

    /**
     * Membership reads keyed by predicate AND identity, so N sockets on one shape
     * drain the backend once. Holds the in-flight PROMISE, not the settled rows:
     * storing only the result left a window between `load()` starting and its
     * entry landing in which every concurrent caller started its own read, which
     * is exactly the fan-out this cache exists to collapse.
     */
    private readonly reads = new Map<string, Promise<ShapeRow[]>>();

    private resync = false;

    private skippedCount = 0;

    public constructor(changedTables?: Set<string>) {
        this.changedTables = changedTables;
    }

    /** Distinct backend reads this tick issued — the numerator of the fan-out saving. */
    public get readCount(): number {
        return this.reads.size;
    }

    /** Whether any shape failed to settle, so the next tick must read unconditionally. */
    public get resyncRequested(): boolean {
        return this.resync;
    }

    /** How many (socket, shape) pairs this tick needed no read for at all. */
    public get skipped(): number {
        return this.skippedCount;
    }

    /**
     * Ask for an unconditional next pass: a shape threw, was over the membership
     * cap, or its poke was not delivered.
     *
     * The cursor moves once per tick for the whole shard, so by the time such a
     * shape fails, the changelog rows that marked its table changed have already
     * been consumed. Without this the next tick sees the table as unchanged, skips
     * it, and the socket keeps a stale membership until the resync interval
     * elapses. Requesting a resync converts "we lost the notification" into "read
     * everything once", which is the only recovery available to a shared cursor.
     */
    public requestResync(): void {
        this.resync = true;
    }

    /** Read `key`'s membership through this tick's cache, loading it at most once. */
    public async rows(key: string | undefined, load: () => Promise<ShapeRow[]>): Promise<ShapeRow[]> {
        if (key === undefined) {
            return load();
        }

        const cached = this.reads.get(key);

        if (cached !== undefined) {
            return cached;
        }

        const pending = load();

        // Published BEFORE the await, so a caller arriving mid-flight joins this
        // read instead of starting a second one.
        this.reads.set(key, pending);

        try {
            return await pending;
        } catch (error) {
            // Drop the failed read so the next poll retries rather than
            // re-throwing this tick's error for the rest of the object's life.
            this.reads.delete(key);

            throw error;
        }
    }

    /** Whether `table` needs reading this tick; counts the skip when it does not. */
    public shouldRead(table: string): boolean {
        if (this.changedTables === undefined || this.changedTables.has(table)) {
            return true;
        }

        this.skippedCount += 1;

        return false;
    }
}

export default GlobalPollTick;
