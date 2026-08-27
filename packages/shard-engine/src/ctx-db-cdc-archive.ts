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
import { sql as dsql } from "drizzle-orm";

import type { SqlExec } from "./ctx-db";
import type { CdcChange } from "./ctx-db-cdc";
import { runDrizzle } from "./do-exec";

/**
 * Zero-padding width for a `seq` in a segment key.
 *
 * The keys are read back with an R2 `list({ startAfter })`, which orders and
 * compares them as STRINGS — so the padding is what makes `seq 9` sort before
 * `seq 10` instead of after it. Without it the read-back would silently skip
 * every segment whose unpadded key happens to sort below the cursor's, and
 * report a gap for changes it is holding. 16 digits is not a guess about how
 * large a rowid gets: `CdcChange.seq` is a JS number, so any seq this module can
 * ever see is at most `Number.MAX_SAFE_INTEGER`, which is 16 digits.
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

/** Single-row table holding how far this shard's changelog has been archived. */
const CDC_ARCHIVE_TABLE = "__cdc_archive";

/**
 * Create the archive watermark table. Called on the archiving path only, so a
 * shard with no bucket bound never grows it.
 */
const migrateCdcArchive = (sql: SqlExec): void => {
    runDrizzle(
        sql,
        dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(CDC_ARCHIVE_TABLE)} (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            seq INTEGER NOT NULL
        )`,
    );
};

/**
 * The highest `seq` written to object storage, or `0` when nothing has been.
 *
 * This is what makes segments disjoint, and it is deliberately SHARD state
 * rather than something derived from the bucket. R2 lists ascending with no
 * reverse, so "what is the newest segment" is a walk to the end of the archive —
 * a cost that grows with everything ever written, paid on a write path, to
 * answer a question the shard already knows.
 *
 * A restore that rolls the changelog back also rolls this back with it, which is
 * correct: the epoch changes at the same moment (see {@link CdcArchiveScope}),
 * so the new timeline writes under a fresh prefix and cannot collide with what
 * the old one left behind.
 */
const readCdcArchivedThrough = (sql: SqlExec): number => {
    migrateCdcArchive(sql);

    const rows = runDrizzle<{ seq: null | number }>(sql, dsql`SELECT seq FROM ${dsql.identifier(CDC_ARCHIVE_TABLE)} WHERE id = 1`).toArray();

    return rows[0]?.seq ?? 0;
};

/**
 * Record that everything at or below `seq` is in object storage.
 *
 * Must be called only after the `put` resolves, and before anything destructive
 * runs. Advancing it on a failed upload would let the next sweep skip past rows
 * that were never written — the one ordering this whole module exists to
 * enforce, stated once more because it is invisible from the call site.
 */
const writeCdcArchivedThrough = (sql: SqlExec, seq: number): void => {
    migrateCdcArchive(sql);

    runDrizzle(sql, dsql`INSERT INTO ${dsql.identifier(CDC_ARCHIVE_TABLE)} (id, seq) VALUES (1, ${seq}) ON CONFLICT (id) DO UPDATE SET seq = ${seq}`);
};

/**
 * Write `changes` as one segment. The caller must not destroy the rows until
 * this resolves — that ordering is the entire durability contract here, and it
 * lives at the call site (`CdcRetentionRunner.sweep`) because only the caller
 * knows what it is about to destroy.
 *
 * Segments MUST be disjoint and ascending, and the caller is what guarantees it:
 * it archives strictly above {@link readCdcArchivedThrough} rather than "the
 * oldest rows still live". That is not a style preference. Keys are derived from
 * the range's last `seq`, so two segments ending at the same `seq` are one
 * object — and the second `put` wins. A sweep that re-archived survivors (rows
 * archived but not yet trimmed, because the retention floor clamped the delete)
 * would overwrite the segment holding the rows it HAD trimmed, with a shorter
 * range whose payloads compaction has since stripped. Those rows are then gone
 * from SQLite and from R2 both.
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
 * The refusal is for a row that was payload-compacted before it was archived: it
 * stores an insert/update with no post-image, which is exactly the corruption
 * `CDC_PAYLOAD_COMPACTED` exists to prevent on the live path. Going through
 * object storage makes it no less corrupting, so the same test is applied here
 * rather than trusted to have been applied upstream.
 *
 * `servedThrough` is the RUNNING cursor, not the one the consumer asked from.
 * The writer produces disjoint segments, so for anything it wrote the two are
 * the same — but this filter is also what keeps a foreign object from injecting
 * rows below the cursor, and that is not the writer's to guarantee.
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

/**
 * Append the leading run of `serveable` that continues `servedThrough` without a
 * gap, and return how far that reached.
 *
 * Coverage is decided by what a segment CONTAINS, never by the `from`/`to` it
 * declares. Those are two independent claims and only the contents are the data:
 * a segment asserting `from: 1, to: 1000` while holding one row would otherwise
 * advance the cursor over 999 changes nobody was handed — the silent warehouse
 * gap this module exists to make impossible. For a segment the writer produced
 * the two agree, so nothing is lost by ignoring the cheaper claim; for a foreign
 * object under the prefix, ignoring it is the whole defence.
 */
const appendContiguousRun = (changes: CdcChange[], serveable: CdcChange[], servedThrough: number): number => {
    let reached = servedThrough;

    for (const change of serveable) {
        if (change.seq !== reached + 1) {
            break;
        }

        changes.push(change);
        reached = change.seq;
    }

    return reached;
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
 * The writer produces disjoint, ascending segments (see
 * {@link archiveCdcSegment}), so for anything it wrote a segment's declared
 * bounds and its contents agree. This loop still refuses to rely on that: the
 * bucket is an operator-supplied binding that nothing forces to be dedicated, so
 * `from` and `to` are a CLAIM by whoever wrote the object, and coverage is taken
 * from the rows actually present instead. That costs nothing for honest
 * segments and is the whole defence against a foreign one.
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
    let servedThrough = sinceSeq;

    for (const object of listing.objects) {
        // Sequential rather than fanned out: the loop stops at the first hole or
        // once `limit` is reached, and the common catch-up is one or two
        // segments — fetching all 32 in parallel would pay for the whole window
        // to answer a page that only needs the head of it.
        // eslint-disable-next-line no-await-in-loop -- bounded early-exit scan, not a fan-out; see above
        const segment = await fetchSegment(bucket, object.key);

        if (segment === undefined) {
            break;
        }

        const serveable = serveableChanges(segment, servedThrough);

        if (serveable === undefined) {
            return undefined;
        }

        // Coverage is decided by what the segment CONTAINS, never by the `from`
        // and `to` it declares. Those are two independent claims, and only the
        // contents are the data — a segment asserting `from: 1, to: 1000` while
        // holding one row would otherwise advance the cursor over 999 changes
        // nobody was handed, which is the silent warehouse gap this module is
        // built to make impossible. For a segment this writer produced the two
        // agree, so nothing is lost by ignoring the cheaper claim; for a foreign
        // object under the prefix, ignoring it is the whole defence.
        servedThrough = appendContiguousRun(changes, serveable, servedThrough);

        // `servedThrough !== segment.to` means this segment did not deliver the
        // range its key and body claim — a hole opened either before its first
        // row or inside its run. Whatever was collected up to there is still a
        // correct PREFIX of what the consumer missed, so serve that and let the
        // consumer's next call refuse at the hole: one round trip later, but
        // with the rows in between actually delivered.
        if (changes.length >= pageLimit || servedThrough !== segment.to) {
            break;
        }
    }

    // The consumer must be served from the very next change it expects. Anything
    // else is a gap dressed up as a page.
    if (changes[0]?.seq !== sinceSeq + 1) {
        return undefined;
    }

    const served = changes.slice(0, pageLimit);

    return { changes: served, cursor: served.at(-1)?.seq ?? sinceSeq };
};

export { archiveCdcSegment, readArchivedCdcChanges, readCdcArchivedThrough, writeCdcArchivedThrough };
export type { CdcArchiveScope };
