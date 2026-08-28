/**
 * Changelog retention for `ShardDO`: the throttled sweep that bounds
 * `__cdc_log`, the destructive step it defers behind an archive upload, and the
 * read path that serves a consumer out of the archive once the live log can no
 * longer account for it.
 *
 * Lives outside `shard-do.ts` because it is a genuinely separable subsystem —
 * everything here reaches the shard through the {@link CdcRetentionHost} seam
 * and nothing else. `@lunora/shard-engine` owns the
 * mechanics (the trim, the compaction, the segment format, the floors); this
 * module owns the POLICY: when a sweep runs, which windows it honours, what may
 * be destroyed and only after what has been durably written elsewhere.
 *
 * Kept in `@lunora/do` rather than beside the engine because every input is a
 * host concern — the operator's env knobs, the R2 binding, the DO's
 * `waitUntil`, the shard's own name.
 */

import { LunoraError } from "@lunora/errors";
import type { R2BucketLike } from "@lunora/platform";
import type { CdcChange, SqlExec } from "@lunora/shard-engine";
import {
    archiveCdcSegment,
    cdcSeqLeavingRows,
    compactCdcDocs,
    envOptionalPositiveInt,
    readArchivedCdcChanges,
    readCdcArchivedThrough,
    readCdcChanges,
    trimCdcChanges,
    writeCdcArchivedThrough,
} from "@lunora/shard-engine";

/** R2 bucket binding that receives changelog segments. Absent ⇒ archiving is off. */
const CDC_ARCHIVE_BINDING = "LUNORA_CDC_ARCHIVE";

/**
 * Minimum spacing between retention sweeps. The sweep is amortized onto a write
 * dispatch rather than a timer, so this is what keeps it off the per-mutation
 * path on a busy shard.
 */
const CDC_SWEEP_INTERVAL_MS = 60_000;

/**
 * Upper bound on rows one un-archived sweep may compact or delete.
 *
 * The steady state never reaches it: a shard writing under this many changes a
 * minute stays exactly at its configured window. It bounds the OTHER case — the
 * first sweep after an operator enables retention on a log that has been growing
 * unbounded — where a single statement over the whole backlog risks exceeding
 * the DO's per-request limits, aborting with nothing changed, and being retried
 * identically forever. Bounded, that backlog drains over successive sweeps
 * instead of never draining at all.
 *
 * Named apart from `@lunora/sql-store`'s `GLOBAL_CDC_SWEEP_MAX_ROWS`, which is
 * the same concept for the `.global()` changelog at a fifth of the value: this
 * sweep runs against the shard's own workerd SQLite, that one against D1 or
 * PlanetScale over the network. They are not interchangeable and neither is a
 * re-export of the other.
 */
const SHARD_CDC_SWEEP_MAX_ROWS = 50_000;

/**
 * How many changelog rows one archived segment may hold.
 *
 * Not {@link SHARD_CDC_SWEEP_MAX_ROWS}: this bound governs a read that
 * MATERIALIZES every post-image into the isolate and then serializes the lot
 * into one JSON body, so it is a memory bound, while the sweep cap bounds a
 * `DELETE` that touches no payloads at all. It also matches `readCdcChanges`'s
 * own internal clamp — asking for more would silently return this many anyway.
 *
 * It does NOT bound the destructive step, which is sized by the sweep cap and
 * ceilinged by the archive watermark. Those are different questions: how much
 * can be uploaded in one turn, versus how much is safe to delete — and the
 * second is "everything archived to date", not "the slice just uploaded", since
 * rows an earlier sweep archived may still be waiting on a floor that has moved.
 */
const CDC_ARCHIVE_SEGMENT_MAX_ROWS = 10_000;

/**
 * Everything this subsystem needs from the shard, as thunks.
 *
 * Thunks rather than values because the runner is constructed as a field
 * initializer, before the DO's constructor has assigned `env` — and because
 * `sql` and the floor must be read at the moment they are used, not at the
 * moment the runner was built. See the note on the floor in
 * {@link CdcRetentionRunner.applyRetention}.
 */
interface CdcRetentionHost {
    /** Whether this shard has a `__cdc_log` at all; a sweep on one without is a no-op. */
    enabled: () => boolean;
    /** The worker `env`, read fresh so a binding attached after construction is still seen. */
    env: () => unknown;
    /** The shard's CDC epoch, or `undefined` when CDC was never enabled. */
    epoch: () => string | undefined;
    /** Report a swallowed failure; retention is maintenance and must never surface on a write path. */
    recordError: (scope: string, error: unknown) => void;
    /** Lowest cursor any durable in-shard consumer has reached — the seq a sweep may not cross. */
    retentionFloor: (sql: SqlExec) => number;
    /** This DO's shard key, or `__root__` for the single-DO default. */
    shardKey: () => string;
    sql: () => SqlExec;
    /** Keep background work alive past the response; absent in the unit harness. */
    waitUntil?: (promise: Promise<unknown>) => void;
}

/** The configured archive bucket, or `undefined` when the shard has no `LUNORA_CDC_ARCHIVE` binding. */
const cdcArchiveBucket = (environment: unknown): R2BucketLike | undefined => {
    if (typeof environment !== "object" || environment === null) {
        return undefined;
    }

    const binding = (environment as Record<string, unknown>)[CDC_ARCHIVE_BINDING];

    // Structural check rather than `instanceof`: the binding is a host object in
    // workerd and a plain double in tests, and only `get`/`list`/`put` are used.
    if (typeof binding !== "object" || binding === null) {
        return undefined;
    }

    const candidate = binding as Partial<R2BucketLike>;

    return typeof candidate.get === "function" && typeof candidate.list === "function" && typeof candidate.put === "function"
        ? (binding as R2BucketLike)
        : undefined;
};

/**
 * Per-instance retention state and behaviour. A class, like
 * `DurableStreamRunner`, because the sweep throttle is per-DO-instance
 * in-memory state and a module-level scalar would let one busy shard claim the
 * window for every other shard sharing the isolate.
 */
class CdcRetentionRunner {
    private readonly host: CdcRetentionHost;

    /** Last sweep's wall clock, throttling to one per {@link CDC_SWEEP_INTERVAL_MS}. Resets on hibernation, which only costs one extra sweep. */
    private lastSweepAt = 0;

    public constructor(host: CdcRetentionHost) {
        this.host = host;
    }

    /**
     * Bound the changelog to the configured windows, archiving anything
     * destructible first when a bucket is bound.
     *
     * Two independent, opt-in windows. `LUNORA_CDC_PAYLOAD_RETENTION` strips
     * post-images past N rows, keeping every key — a client below that floor
     * still gets an exact key-level delta and reads the values from the tables.
     * `LUNORA_CDC_LOG_RETENTION` deletes rows outright past N, which is the
     * level that destroys information and the one the archive exists for.
     *
     * Both levels are enforced on the READ paths, not merely intended here —
     * `evaluateResume` and `computeOpLogShapeSeed` gate on `minCdcSeq`, and
     * `ShardDO.runShardCdcSync` refuses a page below either floor. That matters
     * because the failure a sweep can cause is silent by nature: a consumer
     * handed the surviving tail with an advanced cursor has no way to notice a
     * range went missing, so every path that can serve one has to refuse.
     *
     * **Both are opt-in, and that is a deliberate answer rather than caution.**
     * The log's in-shard consumers record durable cursors this sweep can read
     * ({@link CdcRetentionHost.retentionFloor}), but its out-of-shard consumers
     * do not: a warehouse connector holds an opaque cursor token issued by the
     * Worker, and nothing in this shard knows where it is. Trimming to a floor
     * computed only from what SQLite can see would silently drop rows a
     * connector had not read — so a deployment that wants retention states the
     * window it can afford, and gets a sweep that additionally never crosses the
     * in-shard floor. A shard that configures neither behaves exactly as before.
     *
     * Best-effort throughout: a stub `sql` handle or a shard without CDC is a
     * no-op, and a failure here must never surface on a write path whose data
     * already committed.
     */
    public sweep(): void {
        if (!this.host.enabled()) {
            return;
        }

        const now = Date.now();

        if (now - this.lastSweepAt <= CDC_SWEEP_INTERVAL_MS) {
            return;
        }

        this.lastSweepAt = now;

        // Strictly parsed. These knobs DELETE data, and the lenient
        // `Number.parseInt` reading (which stops at the first character it cannot
        // eslint-disable-next-line no-secrets/no-secrets -- an example env assignment, not a credential
        // use) turns `LUNORA_CDC_LOG_RETENTION=10k` into "keep 10 rows" — an
        // operator's typo silently destroying the changelog rather than being
        // ignored. `envOptionalPositiveInt` requires the whole string to be an
        // integer and treats anything else as unset, i.e. as off.
        const environment = this.host.env();
        const keepRows = envOptionalPositiveInt(environment, "LUNORA_CDC_LOG_RETENTION");
        const keepPayloads = envOptionalPositiveInt(environment, "LUNORA_CDC_PAYLOAD_RETENTION");

        if (keepRows === undefined && keepPayloads === undefined) {
            return;
        }

        // Compacting a window WIDER than the one being deleted is a no-op with a
        // misleading configuration: rows leave the log before they can reach the
        // payload cutoff. Clamp rather than ignore, so the stated payload window
        // is honoured as far as the row window allows.
        const payloadWindow = keepPayloads === undefined ? undefined : Math.min(keepPayloads, keepRows ?? Number.POSITIVE_INFINITY);

        const sql = this.host.sql();

        try {
            const bucket = cdcArchiveBucket(environment);

            // Archiving is gated on ROW retention, not on a bucket alone.
            //
            // What the archive undoes is the trim. Compaction keeps the key and
            // drops the payload, and the SHAPE paths degrade gracefully to a
            // key-level delta — they read current values from the tables anyway.
            //
            // Be clear about what that does NOT cover, because the comment this
            // replaces claimed it covered everything: the CDC export tap, which
            // is the consumer this whole feature exists for, does not degrade.
            // `runShardCdcSync` refuses any page holding a doc-less non-delete
            // (`CDC_PAYLOAD_COMPACTED`) because a compacted insert is
            // indistinguishable on the wire from a delete, and `syncPage`
            // deliberately does not recover that from the archive. So payload
            // retention WITHOUT row retention is a hard re-seed cliff for the
            // tap, and binding a bucket does not soften it.
            //
            // Archiving ahead of compaction would soften it — the watermark
            // makes that mechanically possible now, where reading from the
            // oldest live row did not — but it is a different feature: it means
            // uploading rows that are never deleted, so the log and the archive
            // both hold them, with only the R2 lifecycle rule bounding either.
            // Not smuggled in here.
            if (bucket === undefined || keepRows === undefined) {
                this.applyRetention(sql, payloadWindow, keepRows, Number.POSITIVE_INFINITY, SHARD_CDC_SWEEP_MAX_ROWS);

                return;
            }

            // Archive through the cutoff of the FIRST destructive step, which is
            // compaction whenever payload retention is configured: `payloadWindow
            // <= keepRows` and a LARGER window yields a LOWER cutoff, so the
            // payload cutoff always sits at or above the trim cutoff. Reading the
            // batch at the trim cutoff instead would archive rows whose `doc`
            // this same sweep had already stripped — an archive full of
            // post-image-less inserts, which the read-back correctly refuses to
            // serve, i.e. an archive that costs storage and answers nothing.
            const cutoff = cdcSeqLeavingRows(sql, payloadWindow ?? keepRows);

            if (cutoff === undefined || cutoff <= 0) {
                return;
            }

            const through = Math.min(cutoff, this.host.retentionFloor(sql));

            // Read from the ARCHIVE WATERMARK, not from the oldest live row.
            //
            // Those differ whenever the trim is clamped by the retention floor:
            // rows get archived, survive the delete, and are still the oldest
            // rows in the log next sweep. Reading from `0` therefore re-archives
            // them, and since a segment's key is its range's last `seq`, a
            // re-archived range that ends where the previous one did OVERWRITES
            // it — with a shorter range whose payloads compaction has since
            // stripped. The rows the earlier segment held, already deleted from
            // SQLite, are then gone from both. Reading from the watermark makes
            // every segment disjoint and its key unique by construction, and
            // stops a lagging subscriber costing a full re-upload every minute.
            const archivedAlready = readCdcArchivedThrough(sql);

            // ponytail: one segment per sweep, capped by `readCdcChanges`'s own
            // 10k clamp, so a shard committing more than 10k changes per sweep
            // interval archives more slowly than it writes and its log grows.
            // The upgrade is a loop (or a wider clamp) once a real workload hits
            // it; the correctness property — nothing is destroyed before it is
            // archived — holds either way, the log just stays larger.
            const batch = readCdcChanges(sql, { limit: CDC_ARCHIVE_SEGMENT_MAX_ROWS, sinceSeq: archivedAlready }).changes.filter(
                (change) => change.seq <= through,
            );
            const archivedThrough = batch.at(-1)?.seq;

            if (archivedThrough === undefined) {
                // Nothing NEW to archive — but rows archived by an earlier sweep
                // can still be sitting in the log, waiting for a floor that has
                // since moved. Retention still has to run for them, or a shard
                // that stops writing never trims its backlog again. `maxSeq` is
                // the watermark, which is exactly what is vouched for.
                this.applyRetention(sql, payloadWindow, keepRows, archivedAlready, SHARD_CDC_SWEEP_MAX_ROWS);

                return;
            }

            // Archive first, destroy second, and never in the same turn: no row
            // may leave SQLite before object storage has acknowledged it. A
            // failed put therefore skips this cycle's retention entirely — the
            // log stays larger until the next sweep, which is exactly the
            // degradation a failed DELETE already produces here.
            //
            // The destructive step is bounded by the WATERMARK rather than by
            // this batch, because rows an earlier sweep archived may still be in
            // the log — the floor that stopped them being trimmed then may have
            // moved since. `SHARD_CDC_SWEEP_MAX_ROWS` rather than `batch.length`
            // for the same reason: the deletable set is everything archived to
            // date, not the slice just uploaded.
            const task = (async () => {
                try {
                    // Non-`undefined` because this sweep already returned for a
                    // shard without CDC, and `readCdcEpoch` mints an epoch rather
                    // than reporting none. Read synchronously here, before the
                    // first `await`, so it is still the same turn as the
                    // `enabled()` guard that proved it. A `?? ""` fallback would
                    // be worse than the assertion: it writes segments under an
                    // epoch the read path refuses, so they would cost storage
                    // forever and answer nothing.
                    const epoch = this.host.epoch() as string;

                    await archiveCdcSegment(bucket, { epoch, shard: this.host.shardKey() }, batch);

                    // Only now. The watermark is the claim "this is durable
                    // elsewhere", and advancing it over an upload that did not
                    // land would let the next sweep archive past rows that were
                    // never written — then trim them.
                    writeCdcArchivedThrough(sql, archivedThrough);

                    this.applyRetention(sql, payloadWindow, keepRows, archivedThrough, SHARD_CDC_SWEEP_MAX_ROWS);
                } catch (error) {
                    this.host.recordError("cdc:archive", error);
                }
            })();

            this.host.waitUntil?.(task);
        } catch (error) {
            // A missing table (pre-CDC shard), a stub handle, or a failed DELETE:
            // retention is maintenance, and skipping a sweep only means the log
            // stays larger until the next one.
            this.host.recordError("cdc:sweep", error);
        }
    }

    /**
     * One changelog page, falling back to the archive when the live log refuses.
     *
     * `readLive` is the caller's synchronous live-log read
     * (`ShardDO.runShardCdcSync`), passed in rather than reached for: it is
     * schema-aware in the codegen subclass and this module has no business
     * knowing that. It answers whenever it can, unchanged; this only does
     * anything on the path where it gives up.
     *
     * A consumer below the retained floor is offered the archived range instead
     * of a refusal, and gets the SAME refusal as before whenever the archive
     * cannot account for it — the error object is re-thrown verbatim rather than
     * rebuilt, so the floor and remediation a connector sees are identical
     * whether or not a bucket is configured.
     */
    public async syncPage(
        readLive: () => { changes: CdcChange[]; cursor: number },
        args: { limit?: number; sinceSeq: number },
    ): Promise<{ changes: CdcChange[]; cursor: number }> {
        try {
            return readLive();
        } catch (error) {
            // Only the "you are below what I still hold" refusal is recoverable
            // from object storage. `CDC_PAYLOAD_COMPACTED` is NOT: those rows are
            // still in the live log, so the archive holds the same doc-less
            // versions and would answer the identical corruption.
            if (!(error instanceof LunoraError) || error.code !== "CDC_LOG_TRIMMED") {
                throw error;
            }

            const bucket = cdcArchiveBucket(this.host.env());
            const epoch = this.host.epoch();

            if (bucket === undefined || epoch === undefined) {
                throw error;
            }

            let archived;

            try {
                // `limit` is left to `readArchivedCdcChanges` to default and
                // clamp, rather than repeated from `readCdcChanges` here — the
                // live and archived halves of one page have to agree on it, and
                // a literal copied across a package boundary is how they stop
                // agreeing.
                archived = await readArchivedCdcChanges(bucket, { epoch, shard: this.host.shardKey() }, args.sinceSeq, args.limit);
            } catch (archiveError) {
                // A bucket that is unreachable, revoked, or deleted must not
                // change what this path answers. The refusal already in hand is
                // a 409 carrying the retained floor and "resume from a
                // snapshot"; letting an R2 error escape instead turns that into
                // an opaque 500 for every lagging consumer, for as long as R2 is
                // unhappy — trading a documented, actionable answer for an
                // undiagnosable one at exactly the wrong moment.
                this.host.recordError("cdc:archive-read", archiveError);

                throw error;
            }

            if (archived === undefined) {
                throw error;
            }

            return archived;
        }
    }

    /**
     * The destructive half of {@link CdcRetentionRunner.sweep}: strip payloads
     * past the payload window, then delete rows past the row window.
     *
     * Split out because the archiving path has to run it AFTER an `await`, and a
     * second copy of two cutoff calculations that must agree on `Math.min(cutoff,
     * floor)` is exactly the kind of duplication that drifts into deleting rows a
     * live subscriber still needs.
     *
     * `maxSeq` is the ceiling the caller can vouch for — `POSITIVE_INFINITY` when
     * nothing is archived (every row is expendable once past its window), or the
     * last `seq` actually written to object storage when something is. The floor
     * is re-read HERE rather than passed in, because the archiving caller
     * computes its own before an `await` and a subscriber can advance or arrive
     * across that gap; a floor that is stale-high deletes a range a live
     * subscription still has to be told about.
     *
     * The caller's own pre-await floor is NOT corrected by this, and does not
     * need to be: it only ever narrows what gets ARCHIVED, and archiving too
     * little is a cost (the rows are archived next sweep instead) rather than a
     * correctness failure. Only the destructive side needs the fresh reading.
     */
    private applyRetention(sql: SqlExec, payloadWindow: number | undefined, keepRows: number | undefined, maxSeq: number, maxRows: number): void {
        const floor = this.host.retentionFloor(sql);

        if (payloadWindow !== undefined) {
            // `cdcSeqLeavingRows` IS the "is anything past the window?" probe —
            // an indexed `LIMIT 1 OFFSET keep - 1` that returns `undefined` when
            // the log is shorter than the window. The `COUNT(*)` pre-check this
            // replaces was a full b-tree walk on the write path every 60s, on
            // exactly the multi-million-row logs this sweep exists to bound.
            const cutoff = cdcSeqLeavingRows(sql, payloadWindow);

            if (cutoff !== undefined && cutoff > 0) {
                compactCdcDocs(sql, Math.min(cutoff, floor, maxSeq), maxRows);
            }
        }

        if (keepRows !== undefined) {
            const cutoff = cdcSeqLeavingRows(sql, keepRows);

            if (cutoff !== undefined && cutoff > 0) {
                trimCdcChanges(sql, Math.min(cutoff, floor, maxSeq), maxRows);
            }
        }
    }
}

export { cdcArchiveBucket, CdcRetentionRunner };
export type { CdcRetentionHost };
