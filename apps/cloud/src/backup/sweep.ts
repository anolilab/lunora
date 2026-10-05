/**
 * Off-database backups of the control plane (GAPS.md D1).
 *
 * D1's Time Travel already covers "someone dropped a table" — it restores any
 * point in the last 30 days, in place, with no code. What it cannot survive is
 * losing the database itself: a deleted or compromised account takes its own
 * Time Travel history with it, and the control-plane D1 is the one store whose
 * loss is unrecoverable rather than inconvenient. Every tenant's data lives in
 * its own Durable Object, but which cell a tenant is on, which script serves it,
 * and the sealed admin token that reaches it live only here.
 *
 * So this takes a full SQL dump through D1's export API and writes it to R2
 * under a timestamped key, on the six-hourly tick. The dump is what
 * `wrangler d1 execute --file` restores from, so the recovery path is the
 * documented one rather than something invented here — see `docs/RESTORE.md`.
 *
 * The copy is same-account: a Worker's R2 binding cannot reach another
 * Cloudflare account, so this survives losing the *database* but not losing the
 * account*. Getting the dump into a second cell needs R2's S3 API and a
 * credential for that account, which is the remaining half of D1 — it is a
 * deliberate first increment, not an oversight.
 */

/** The subset of an R2 bucket binding this sweep uses. */
export interface BackupBucket {
    delete: (keys: string[]) => Promise<void>;
    list: (options: { cursor?: string; prefix: string }) => Promise<BackupListing>;
    put: (key: string, value: ReadableStream | null, options?: { httpMetadata?: { contentType?: string } }) => Promise<unknown>;
}

export interface BackupListing {
    cursor?: string;
    objects: { key: string; uploaded: Date }[];
    truncated: boolean;
}

export interface BackupSweepDeps {
    bucket: BackupBucket;
    /** Names this cell's backups so one bucket can hold several cells. */
    cell: string;
    /** Injected for tests; defaults to the global. */
    fetch?: typeof globalThis.fetch;
    now: number;
    /** Starts the export and answers a presigned URL for the dump. */
    startExport: () => Promise<{ signedUrl: string }>;
}

export interface BackupSweepResult {
    /** Objects deleted because they aged past the retention window. */
    pruned: number;
    /** The key written, or null when the sweep did not write one. */
    written: null | string;
}

/** How long a dump is kept before the prune pass removes it. */
export const BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Bounds the prune listing so a bucket that grows unexpectedly cannot hang the cron. */
const MAX_PRUNE_PAGES = 20;

/** `control-plane/&lt;cell>/` — one prefix per cell, so a shared bucket stays sortable. */
export const backupPrefix = (cell: string): string => `control-plane/${cell}/`;

/**
 * The key a dump taken at `now` is written under.
 *
 * ISO-8601 with the punctuation stripped, so the lexical order of the keys is
 * the chronological order of the dumps — which is what makes the prune pass a
 * prefix listing rather than a metadata read.
 */
export const backupKey = (cell: string, now: number): string => `${backupPrefix(cell)}${new Date(now).toISOString().replaceAll(/[.:-]/gu, "")}.sql`;

/**
 * Delete dumps older than the retention window.
 *
 * Ages by the object's own `uploaded` time rather than by parsing the key: the
 * key is written by this sweep, but the retention decision is about when R2
 * actually holds the bytes, and an object whose upload was retried carries the
 * later time.
 */
const prune = async (bucket: BackupBucket, cell: string, now: number): Promise<number> => {
    const cutoff = now - BACKUP_RETENTION_MS;
    const prefix = backupPrefix(cell);
    let cursor: string | undefined;
    let pruned = 0;

    for (let page = 0; page < MAX_PRUNE_PAGES; page += 1) {
        // eslint-disable-next-line no-await-in-loop -- cursor pagination is sequential by construction
        const listing = await bucket.list(cursor === undefined ? { prefix } : { cursor, prefix });
        const expired = listing.objects.filter((object) => object.uploaded.getTime() < cutoff).map((object) => object.key);

        if (expired.length > 0) {
            // eslint-disable-next-line no-await-in-loop -- one delete per page keeps the request count bounded
            await bucket.delete(expired);
            pruned += expired.length;
        }

        if (!listing.truncated || listing.cursor === undefined) {
            break;
        }

        cursor = listing.cursor;
    }

    return pruned;
};

/**
 * Take one control-plane backup and prune expired ones.
 *
 * The prune runs even when the export fails, so a run of failed backups still
 * ages out its predecessors on schedule rather than growing the bucket forever
 * — but it runs *after* the write, so a failure never deletes the newest good
 * dump while leaving nothing in its place.
 */
export const runBackupSweep = async (deps: BackupSweepDeps): Promise<BackupSweepResult> => {
    const { bucket, cell, now } = deps;
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    const { signedUrl } = await deps.startExport();
    const dump = await fetchImpl(signedUrl);

    if (!dump.ok) {
        throw new Error(`control-plane backup download failed: HTTP ${String(dump.status)}`);
    }

    const key = backupKey(cell, now);

    // Streamed rather than buffered: the dump is the whole control plane, and a
    // Worker that reads it into memory first is one growth spurt from OOM.
    await bucket.put(key, dump.body, { httpMetadata: { contentType: "application/sql" } });

    return { pruned: await prune(bucket, cell, now), written: key };
};
