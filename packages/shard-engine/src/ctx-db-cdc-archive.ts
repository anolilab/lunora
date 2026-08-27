/**
 * Cold tier for the `__cdc_log` changelog: the segments a retention sweep writes
 * to R2 on the way out, and the read-back that serves a consumer whose cursor
 * has fallen below what the shard still holds.
 *
 * Retention without this is a CLIFF. `trimCdcChanges` deletes and
 * `compactCdcDocs` strips payloads, and every read path then answers a consumer
 * sitting below the surviving floor with `CDC_LOG_TRIMMED` /
 * `CDC_PAYLOAD_COMPACTED` — "resume from a snapshot". That is correct (a served
 * gap would silently corrupt a warehouse table) but it is also the whole cost:
 * a connector offline over a weekend, a stalled relay, or a new replica pays a
 * full re-seed of the shard because a few megabytes of changelog were deleted to
 * keep SQLite small. Writing those rows to object storage before destroying them
 * turns the cliff into a tier — hot rows in SQLite where they must be fast, cold
 * rows in R2 where they are almost free.
 *
 * Sits beside {@link file://./ctx-db-cdc.ts}, which owns the live changelog and
 * every other CDC concept — the floors, the epoch, the trim and compaction this
 * file exists to survive. It takes a bucket rather than an environment, and so
 * knows nothing about how a host decides archiving is on; `@lunora/do` makes
 * that call from the binding and drives the ordering.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-cdc-archive" mirrors "ctx-db-cdc.ts", the module it extends (which carries the same disable for the same reason). */

import type { R2BucketLike } from "@lunora/platform";

import type { CdcChange } from "./ctx-db-cdc";

/**
 * Zero-padding width for a `seq` in a segment key.
 *
 * The keys are read back with an R2 `list({ startAfter })`, which orders and
 * compares them as STRINGS — so the padding is what makes `seq 9` sort before
 * `seq 10` instead of after it. Without it the read-back would silently skip
 * every segment whose unpadded key happens to sort below the cursor's, and
 * report a gap for changes it is holding. 16 digits covers the full range an
 * `AUTOINCREMENT` rowid reaches in practice.
 */
const SEQ_KEY_WIDTH = 16;

/**
 * How many segments one read-back may fetch before giving up and letting the
 * caller re-seed.
 *
 * This is the knob that decides HOW FAR BEHIND a consumer can be and still be
 * served, because a read must reach the consumer's cursor within one listing or
 * it refuses. At one segment per sweep and a 60s sweep interval, 32 covers
 * roughly half an hour of continuous trimming — comfortably past a deploy, a
 * restart, or a brief connector outage, which are the lags this exists for.
 * A consumer further behind than that pays the re-seed it would have paid
 * anyway; raising this trades isolate memory for a longer recoverable window.
 */
const MAX_SEGMENTS_PER_READ = 32;

/**
 * Ceiling on the changes one archive page may return, mirroring the `[1, 10000]`
 * clamp `readCdcChanges` applies to the live path so both answer a caller's
 * `limit` the same way. Without it the archive page is bounded only by
 * {@link MAX_SEGMENTS_PER_READ} × {@link CdcSegment} size.
 */
const MAX_ARCHIVE_PAGE_ROWS = 10_000;

/** Page size when the caller names none — the same default `readCdcChanges` applies on the live path. */
const DEFAULT_ARCHIVE_PAGE_ROWS = 1000;

/** One archived run of changelog entries, exactly as it is stored. */
interface CdcSegment {
    changes: CdcChange[];
    /** `seq` of the first change in {@link CdcSegment.changes}. */
    from: number;
    /** `seq` of the last change — also what the object's key is derived from. */
    to: number;
}

/** Which shard's changelog, on which timeline. */
interface CdcArchiveScope {
    /**
     * The shard's CDC epoch. Part of the key PREFIX rather than a metadata field,
     * because an epoch change means the timeline forked (a PITR restore rolled
     * the log back) and every segment written before it describes changes that no
     * longer happened. Keying by epoch makes those segments unreachable by
     * construction instead of relying on a reader to remember to check a field —
     * a forked shard finds an empty archive and falls back to the re-seed it
     * would have demanded anyway.
     */
    epoch: string;
    /** The DO's shard key, or `__root__` for the single-DO default. */
    shard: string;
}

const padSeq = (seq: number): string => String(seq).padStart(SEQ_KEY_WIDTH, "0");

/** `cdc/<shard>/<epoch>/` — everything one timeline of one shard ever archived. */
const scopePrefix = (scope: CdcArchiveScope): string => `cdc/${encodeURIComponent(scope.shard)}/${encodeURIComponent(scope.epoch)}/`;

/**
 * Keyed by the segment's LAST `seq`, so "every segment a consumer at `sinceSeq`
 * still needs" is exactly `startAfter: <prefix><pad(sinceSeq)>.json` — one list
 * call, no manifest object to keep consistent with the segments it describes,
 * and no scan whose cost grows with the size of the archive. A segment ending
 * exactly at the cursor sorts equal to `startAfter` and is excluded, which is
 * right: the consumer has seen it.
 */
const segmentKey = (scope: CdcArchiveScope, to: number): string => `${scopePrefix(scope)}${padSeq(to)}.json`;

/**
 * Write `changes` as one segment. The caller must not destroy the rows until
 * this resolves — that ordering is the entire durability contract here, and it
 * lives at the call site (`ShardDO.sweepCdcRetention`) because only the caller
 * knows what it is about to destroy.
 *
 * Segments are NOT guaranteed disjoint. A sweep archives the oldest live rows
 * and then trims them, but the trim is clamped by the retention floor, so rows
 * that were archived can survive in the live log and be archived again — under a
 * different key, since keys are derived from the range's last `seq`. The
 * read-back owns that: it de-overlaps against its running cursor rather than
 * trusting each segment's bounds. Do not "fix" it here by trying to make the
 * writer produce disjoint ranges; the floor moves for reasons this call site
 * cannot see.
 *
 * Nothing here ever deletes a segment. The archive grows without bound by
 * design — an operator who wants it bounded sets an R2 lifecycle rule on the
 * bucket, and the read-back degrades correctly (a refusal, never a gap) when an
 * expired segment leaves a hole.
 */
const archiveCdcSegment = async (bucket: R2BucketLike, scope: CdcArchiveScope, changes: CdcChange[]): Promise<void> => {
    const from = changes[0]?.seq;
    const to = changes.at(-1)?.seq;

    if (from === undefined || to === undefined) {
        return;
    }

    await bucket.put(segmentKey(scope, to), JSON.stringify({ changes, from, to } satisfies CdcSegment), {
        httpMetadata: { contentType: "application/json" },
    });
};

/** Parse a stored segment, returning `undefined` for anything that is not one (a truncated write, a foreign object under the prefix). */
const parseSegment = (raw: string): CdcSegment | undefined => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }

    if (typeof parsed !== "object" || parsed === null) {
        return undefined;
    }

    const candidate = parsed as Partial<CdcSegment>;

    return typeof candidate.from === "number" && typeof candidate.to === "number" && Array.isArray(candidate.changes) ? (candidate as CdcSegment) : undefined;
};

/**
 * The changes in one segment that sit strictly above `servedThrough`, or
 * `undefined` when the segment cannot be served at all.
 *
 * `servedThrough` is the RUNNING cursor — the last seq already collected on this
 * read — not the cursor the consumer asked from. Segments are not guaranteed
 * disjoint (see {@link readArchivedCdcChanges}), so filtering against the
 * request's cursor would re-emit rows an earlier segment in the same page had
 * already supplied, with `seq` running backwards mid-page. For a change-feed
 * consumer applying ops in order that is a corrupted stream, not a redundant
 * one: a delete followed by a re-insert, replayed backwards, inverts the final
 * state of the row.
 *
 * The other refusal is for a row that was payload-compacted before it was
 * archived: it stores an insert/update with no post-image, which is exactly the
 * corruption `CDC_PAYLOAD_COMPACTED` exists to prevent on the live path. Going
 * through object storage makes it no less corrupting, so the same test is
 * applied here rather than trusted to have been applied upstream.
 */
const serveableChanges = (segment: CdcSegment, servedThrough: number): CdcChange[] | undefined => {
    const changes: CdcChange[] = [];

    for (const change of segment.changes) {
        if (change.seq <= servedThrough) {
            continue;
        }

        if (change.op !== "delete" && change.doc === undefined) {
            return undefined;
        }

        changes.push(change);
    }

    return changes;
};

/** Fetch and parse one segment, or `undefined` when it is absent or is not a segment. */
const fetchSegment = async (bucket: R2BucketLike, key: string): Promise<CdcSegment | undefined> => {
    const body = await bucket.get(key);

    return body === null ? undefined : parseSegment(await body.text());
};

/**
 * Serve up to `limit` changes past `sinceSeq` from the archive, or `undefined`
 * when the archive cannot account for the range.
 *
 * `undefined` is the important return, and it is deliberately not an empty page:
 * the caller re-throws the retention error it was about to throw, so a consumer
 * that cannot be served correctly is still told to re-seed. Every way the
 * archive can fall short collapses to it — the archive was enabled AFTER the
 * range was destroyed and nothing covers it; a segment is missing from the front
 * of the range (a failed put in an older sweep, an object lifecycle-expired out
 * of the bucket); or the range opens on a payload-compacted row (see
 * {@link serveableChanges}).
 *
 * Contiguity is checked rather than assumed, because "the archive returned rows"
 * and "the archive returned the rows this consumer missed" are different claims
 * and only the second one is safe to act on.
 *
 * Segments may OVERLAP, and this is the function that has to cope with it. The
 * sweep archives the oldest live rows and then trims them, but the trim is
 * clamped by the retention floor — so a subscriber lagging inside the archived
 * range leaves already-archived rows in the live log, and the next sweep's
 * segment starts inside the previous one. This loop therefore treats the
 * running cursor, not each segment's own bounds, as the truth about what has
 * been served.
 */
const readArchivedCdcChanges = async (
    bucket: R2BucketLike,
    scope: CdcArchiveScope,
    sinceSeq: number,
    limit: number | undefined,
): Promise<{ changes: CdcChange[]; cursor: number } | undefined> => {
    const prefix = scopePrefix(scope);

    // Clamped like `readCdcChanges` clamps the live path, and for a sharper
    // reason: nothing downstream bounds this. A caller-supplied `limit` is
    // honoured by collecting whole segments until it is reached, so an
    // unclamped one would materialize up to `MAX_SEGMENTS_PER_READ`
    // segments' worth of post-images into the isolate to answer one request.
    const pageLimit = Math.max(1, Math.min(limit ?? DEFAULT_ARCHIVE_PAGE_ROWS, MAX_ARCHIVE_PAGE_ROWS));

    const listing = await bucket.list({ limit: MAX_SEGMENTS_PER_READ, prefix, startAfter: `${prefix}${padSeq(sinceSeq)}.json` });

    const changes: CdcChange[] = [];
    let expectedFrom = sinceSeq + 1;

    for (const object of listing.objects) {
        // Sequential rather than fanned out: the loop stops at the first hole or
        // once `limit` is reached, and the common catch-up is one or two
        // segments — fetching all 32 in parallel would pay for the whole window
        // to answer a page that only needs the head of it.
        // eslint-disable-next-line no-await-in-loop -- bounded early-exit scan, not a fan-out; see above
        const segment = await fetchSegment(bucket, object.key);

        // A hole. Whatever was collected before it is still a correct PREFIX of
        // what the consumer missed, so serve that and let the consumer's next
        // call refuse at the hole — one round trip later, but with the rows in
        // between actually delivered.
        if (segment === undefined || segment.from > expectedFrom) {
            break;
        }

        // `expectedFrom - 1` is the running cursor: everything strictly below it
        // is already in `changes`. Passing `sinceSeq` here instead is what lets
        // an overlapping segment re-emit rows out of order.
        const serveable = serveableChanges(segment, expectedFrom - 1);

        if (serveable === undefined) {
            return undefined;
        }

        changes.push(...serveable);

        // `Math.max`, because a segment can be wholly CONTAINED in one already
        // read — it sorts first by its own `to` but adds nothing — and letting
        // the cursor move backwards there would re-admit its rows on the next
        // iteration.
        expectedFrom = Math.max(expectedFrom, segment.to + 1);

        if (changes.length >= pageLimit) {
            break;
        }
    }

    // The first change served must be the very next one the consumer expects.
    // Anything else is a gap dressed up as a page.
    if (changes[0]?.seq !== sinceSeq + 1) {
        return undefined;
    }

    const served = changes.slice(0, pageLimit);

    return { changes: served, cursor: served.at(-1)?.seq ?? sinceSeq };
};

export { archiveCdcSegment, readArchivedCdcChanges };
export type { CdcArchiveScope };
