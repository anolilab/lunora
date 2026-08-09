/**
 * The built-in backup that runs on a Cron Trigger (`backupCron` +
 * `backupStore`), extracted from `create-worker.ts` the way `./export-stream`
 * and `./storage-admin-routes` were. Self-contained: it reaches the worker's
 * options and shard binding through arguments, never through closure.
 *
 * The layout it writes — key, sidecar suffix, manifest fields — comes from
 * `./backup-layout`, shared with `lunora backup create --bucket`, because the
 * two write into the same bucket on purpose.
 */
import type { BackupManifestEntry } from "./backup-layout";
import { BACKUP_KEY_PREFIX, backupManifestKey, backupObjectKey, backupObjectKeyOfManifest, isBackupManifestKey, normalizeBackupPrefix } from "./backup-layout";
import type { BackupStore, ScheduledControllerLike, WorkerOptions } from "./create-worker";
import { LunoraError } from "./errors";
import type { ExportRow } from "./export-stream";
import { streamExportRows } from "./export-stream";
import type { ShardNamespaceLike } from "./resolve-shard";
import { toHex } from "./storage-admin-routes";

/** Shared, stateless encoder — `encode()` is reusable, so one instance serves every run. */
const NDJSON_ENCODER = new TextEncoder();

/** Safety bound on the retention list loop — far above any realistic backup count. */
const MAX_PRUNE_PAGES = 1000;

/** How many keys a retention line names before summarising the rest. */
const MAX_LOGGED_PRUNED_KEYS = 10;

/**
 * Snapshots one prune run will remove.
 *
 * Each costs two R2 calls, against a Worker's subrequest budget — and this
 * number can be large exactly once: a daily cron kept for two years leaves
 * ~700 snapshots past a 14-day window the first time anyone prunes. Hitting the
 * budget mid-run would leave the bucket half-deleted, so the run stops at a
 * bound it can finish and reports what is left for the next one.
 */
const MAX_PRUNE_DELETES = 200;

/** Deletes in flight at once. Enough to hide round-trip latency, few enough to stay polite. */
const PRUNE_DELETE_CONCURRENCY = 8;

/**
 * Custom-metadata key stamped on every sidecar this backup writes, holding the
 * cron expression that produced it.
 *
 * Retention reads it off the object listing, which is what makes the writer
 * check free — no per-sidecar request. It carries the *expression* rather than
 * a boolean because "some cron wrote this" is not narrow enough: two
 * deployments sharing a bucket would prune each other's snapshots.
 */
const BACKUP_CRON_METADATA_KEY = "lunoraBackupCron";

/**
 * Largest snapshot this run will assemble, measured on the encoded NDJSON.
 *
 * Read what this does and does not promise. It is a cap on the snapshot's own
 * size, checked as rows are encoded. It is **not** a bound on peak isolate
 * memory: `orchestrateExport` resolves every shard's rows into one array before
 * the first row reaches the encoder, so for shard-local tables the row set is
 * already resident when the first check runs, and the buffer built here sits on
 * top of it. The check only bounds anything incrementally on the `.global()`
 * branch, which streams from a generator.
 *
 * So the number is deliberately well under a Worker's ~128 MB: 24 MiB of NDJSON
 * plus the decoded rows it came from plus one contiguous copy has room to
 * finish. A backup that trips this needs `backupTables`, or the off-platform
 * tier. Raising it means making the export fan-out stream per shard — the
 * upload is not what constrains this.
 */
const MAX_SCHEDULED_BACKUP_BYTES: number = 24 * 1_048_576;

/** What {@link selectStaleBackups} found: every sidecar this cron owns, and the subset past the retention window. */
interface StaleBackups {
    /** Sidecars under the prefix carrying this cron's marker — the population retention chooses from. */
    eligible: number;
    /** The ones past the window, newest-first ordering already applied. */
    stale: string[];
}

/** What a prune did. Keys are sidecar keys; each names a snapshot at the same key without the suffix. */
interface PrunedBackups {
    /** Removed, snapshot and sidecar both. */
    deleted: string[];
    /** Attempted and not removed. The snapshot may already be gone — the sidecar survives, so the next run retries. */
    failed: string[];
    /** Confirmed keys retention no longer owns: already pruned, or no longer eligible. */
    ignored: number;
    /** Still past the window afterwards — they appeared after the preview, or the run stopped at its cap. Run again. */
    remaining: number;
}

/** What retention would delete on the next run, and the configuration that decides it. */
interface BackupRetentionPreview {
    /** The trigger retention belongs to. `undefined` when no scheduled backup is configured. */
    cron?: string;

    /**
     * Snapshots this cron owns — legacy sidecars and other writers' are not
     * counted, because retention never touches them. `0` when there is no
     * window (`keep === 0`): with nothing to select against, the bucket is not
     * listed at all.
     */
    eligible: number;
    /** `backupRetain`; `0` when unset, which is what makes the selection empty. */
    keep: number;
    prefix: string;
    /** Sidecar keys, newest-first. Each names a snapshot at the same key without the suffix. */
    wouldDelete: string[];
}

/** A snapshot the scheduled backup took: the shared fields plus which trigger produced it. */
interface BackupManifest extends BackupManifestEntry {
    cron: string;
    scheduledTime: number;
    sha256: string;
}

/**
 * Name up to {@link MAX_LOGGED_PRUNED_KEYS} snapshots, summarising the rest.
 *
 * Snapshot keys, not sidecar keys: the sidecar is an implementation detail of
 * the index, and the file an operator goes looking for is the `.ndjson`. The
 * CLI prints the same form, so a prediction, a confirmation and this record
 * name one string for one snapshot.
 */
const nameSnapshots = (manifestKeys: ReadonlyArray<string>): string => {
    const shown = manifestKeys.slice(0, MAX_LOGGED_PRUNED_KEYS).map((key) => backupObjectKeyOfManifest(key));
    const rest = manifestKeys.length - shown.length;

    return `${shown.join(", ")}${rest > 0 ? ` (+${String(rest)} more)` : ""}`;
};

/** Join the encoded rows into the exact bytes that get hashed and stored. */
const concatChunks = (chunks: ReadonlyArray<Uint8Array>, totalBytes: number): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(new ArrayBuffer(totalBytes));
    let offset = 0;

    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return out;
};

/**
 * The sidecars this cron's retention would delete, newest-first ordering
 * already applied — the selection, with no deletion in it.
 *
 * Three callers, one rule: `previewBackupRetention` (what would go),
 * `pruneBackups` (what goes), and `runScheduledBackup` (what it reports and
 * leaves alone). A preview that can disagree with the prune is worse than no
 * preview, and this branch has already shown twice what happens when one rule
 * gets written in two places. Nothing here deletes, so neither reader can.
 *
 * The writer check is the whole point. Both backup writers share this prefix
 * and this sidecar suffix so `lunora backup list --bucket` shows one history —
 * which also makes an operator's snapshot indistinguishable from a cron's by
 * key alone. Pruning on key shape would delete the pre-migration snapshot
 * somebody took by hand an hour ago, silently, from the bucket the docs told
 * them to use. And "written by a cron" is not narrow enough either: two
 * deployments sharing one bucket would prune each other, and each would quietly
 * get half the retention it asked for. So a snapshot is eligible only when its
 * sidecar carries this worker's own cron expression.
 *
 * The marker is read off the object listing rather than by reading each
 * sidecar, so retention costs one `list` page per 1000 objects and no
 * per-object requests — which matters against the Worker subrequest ceiling
 * once a bucket has accumulated snapshots.
 *
 * Sidecars written before this marker existed carry no metadata and are never
 * eligible: retention cannot tell them from an operator's, and keeping data is
 * the safe direction. Delete those by hand once.
 *
 * Backup keys embed an ISO timestamp with `:`/`.` swapped for `-`, which sorts
 * lexicographically by recency, so a descending sort is a recency sort.
 *
 * Empty unless `retain` is a positive integer. `Number.isInteger` rather than
 * `> 0`, because `NaN` passes every comparison — `backupRetain:
 * Number(env.BACKUP_RETAIN)` with the variable unset or misspelled would
 * otherwise slip through and `slice(NaN)` coerces to `slice(0)`, selecting the
 * entire eligible population for deletion. "No window" must never be
 * confusable with "a window of zero".
 */
const selectStaleBackups = async (store: BackupStore, prefix: string, retain: number | undefined, cron: string): Promise<StaleBackups> => {
    if (retain === undefined || !Number.isInteger(retain) || retain <= 0) {
        return { eligible: 0, stale: [] };
    }

    const mine: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PRUNE_PAGES; page += 1) {
        // eslint-disable-next-line no-await-in-loop -- R2 list is paged; each request resumes from the prior page's cursor.
        const listing = await store.list({ cursor, include: ["customMetadata"], prefix });

        for (const object of listing.objects) {
            if (isBackupManifestKey(object.key) && object.customMetadata?.[BACKUP_CRON_METADATA_KEY] === cron) {
                mine.push(object.key);
            }
        }

        if (!listing.truncated || listing.cursor === undefined) {
            break;
        }

        cursor = listing.cursor;
    }

    // Newest first; everything past the retention window goes.
    return { eligible: mine.length, stale: mine.toSorted((a, b) => b.localeCompare(a)).slice(retain) };
};

/**
 * Delete the snapshots an operator confirmed, and only those.
 *
 * `confirmed` carries the sidecar keys the operator was shown and agreed to.
 * The server still decides eligibility — it re-runs the selection, so a caller
 * cannot name a key retention does not own — but the deletion is the
 * **intersection**. Without that, the confirmed list and the deleted list are
 * two computations separated by however long a human takes to read a prompt: a
 * cron fire inside that window writes a newer snapshot, pushes one more past
 * the window, and the prune removes a snapshot the operator was shown as kept.
 * Irreversibly.
 *
 * The two sides can differ either way, and both are reported rather than
 * silently absorbed: keys that stopped being eligible (`ignored`), and eligible
 * snapshots this run did not touch — because they appeared after the preview,
 * or because they were past {@link MAX_PRUNE_DELETES} (`remaining`).
 */
const pruneBackups = async (
    store: BackupStore,
    prefix: string,
    retain: number | undefined,
    cron: string,
    confirmed: ReadonlyArray<string>,
): Promise<PrunedBackups> => {
    const { stale } = await selectStaleBackups(store, prefix, retain, cron);
    const wanted = new Set(confirmed);
    const agreed = stale.filter((manifestKey) => wanted.has(manifestKey));
    const batch = agreed.slice(0, MAX_PRUNE_DELETES);
    // Eligible but untouched: appeared since the preview, or past the cap.
    const remaining = stale.length - batch.length;
    const ignored = confirmed.length - agreed.length;

    if (batch.length === 0) {
        return { deleted: [], failed: [], ignored, remaining };
    }

    const deleted: string[] = [];
    const failed: string[] = [];

    for (let index = 0; index < batch.length; index += PRUNE_DELETE_CONCURRENCY) {
        // eslint-disable-next-line no-await-in-loop -- one window at a time is what bounds the in-flight requests
        const settled = await Promise.allSettled(
            batch.slice(index, index + PRUNE_DELETE_CONCURRENCY).map(async (manifestKey) => {
                // Snapshot first, sidecar second. A sidecar without its snapshot
                // is a listable entry that fails to restore; a snapshot without
                // its sidecar is invisible to retention forever, because the
                // marker retention prunes on lives on the sidecar. If only one
                // delete lands, this order is the recoverable one — the next run
                // sees the sidecar again and retries.
                await store.delete(backupObjectKeyOfManifest(manifestKey));
                await store.delete(manifestKey);

                return manifestKey;
            }),
        );

        for (const [offset, outcome] of settled.entries()) {
            if (outcome.status === "fulfilled") {
                deleted.push(outcome.value);
            } else {
                // Reported, not thrown: `allSettled` rather than `all` because a
                // failure partway through has already destroyed backups, and
                // rejecting here would skip the record of what went and hand the
                // operator a bare 500.
                failed.push(batch[index + offset] as string);
            }
        }
    }

    // Say what was destroyed. Both retention defects found in review (pruning
    // an operator's snapshots, then another deployment's) were silent
    // successes, reconstructed afterwards from a missing file — so a prune
    // leaves a record even though an operator asked for this one.
    if (deleted.length > 0) {
        // eslint-disable-next-line no-console -- server-side diagnostic, same channel as the retention-report warning; a Worker has no other operator-visible sink here.
        console.info(`[lunora] backup prune kept the newest ${String(retain)} and deleted ${String(deleted.length)}: ${nameSnapshots(deleted)}`);
    }

    if (failed.length > 0) {
        // eslint-disable-next-line no-console -- see above; a partial failure has already deleted snapshots and must not be silent
        console.warn(`[lunora] backup prune failed to remove ${String(failed.length)}: ${nameSnapshots(failed)}`);
    }

    return { deleted, failed, ignored, remaining };
};

/**
 * What retention would do on the next run, without doing any of it.
 *
 * The worker is the only party that knows its own `backupCron` and
 * `backupRetain`, so this cannot be computed client-side — and the answer is
 * not obvious even to an operator reading the config, because eligibility turns
 * on the `lunoraBackupCron` marker that legacy sidecars lack. Until now the only
 * way to find out was to let a run happen and read what was gone.
 */
const previewBackupRetention = async (options: WorkerOptions): Promise<BackupRetentionPreview> => {
    const store = options.backupStore;

    if (!store) {
        throw new LunoraError("backup retention preview requires a `backupStore` on the worker", { code: "BACKUP_NOT_CONFIGURED", status: 500 });
    }

    const prefix = normalizeBackupPrefix(options.backupPrefix ?? BACKUP_KEY_PREFIX);
    const cron = options.backupCron;
    // No cron means no scheduled backup, so nothing carries this worker's
    // marker and retention has nothing of its own to delete. Reported as an
    // empty selection rather than an error: "it would delete nothing" is the
    // true answer, and the config it comes from is in the response.
    const { eligible, stale } = cron === undefined ? { eligible: 0, stale: [] } : await selectStaleBackups(store, prefix, options.backupRetain, cron);

    return { cron, eligible, keep: options.backupRetain ?? 0, prefix, wouldDelete: stale };
};

/**
 * Run the built-in backup: export every selected table to NDJSON and write it
 * (plus a manifest sidecar) to `backupStore`. The snapshot is keyed by the
 * trigger's `scheduledTime`, so it is named after the moment it represents.
 *
 * Requires `backupStore`, `queryCoordinator` and an admin token — the export
 * fans out to each shard's admin gate, which the bearer authenticates. Missing
 * prerequisites throw so the platform records a failed cron invocation rather
 * than silently skipping the backup.
 */
const runScheduledBackup = async (
    options: WorkerOptions,
    shardDO: ShardNamespaceLike,
    adminToken: string | undefined,
    controller: ScheduledControllerLike,
): Promise<void> => {
    const store = options.backupStore;
    const coordinator = options.queryCoordinator;

    if (!store) {
        throw new LunoraError("scheduled backup requires a `backupStore` on the worker", { code: "BACKUP_NOT_CONFIGURED", status: 500 });
    }

    if (!coordinator) {
        throw new LunoraError("scheduled backup requires a `queryCoordinator` on the worker", { code: "BACKUP_NOT_CONFIGURED", status: 500 });
    }

    if (!adminToken || adminToken.length === 0) {
        throw new LunoraError("scheduled backup requires an `adminToken` (or `env.LUNORA_ADMIN_TOKEN`) to authenticate the per-shard export gate", {
            code: "BACKUP_NOT_CONFIGURED",
            status: 500,
        });
    }

    // The export fans out to each shard's `/rpc` admin op; the shard gate checks
    // this bearer. No end-user identity is involved.
    const forwardedHeaders: Record<string, string> = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };
    const tables = options.backupTables;

    let rows = 0;
    let bytes = 0;
    let chunks: Uint8Array[] = [];

    const writeRow = (row: ExportRow): void => {
        // Encode once: these are the exact bytes that get hashed and stored, so
        // the manifest's `bytes` is the object's real length rather than a
        // UTF-16 string length.
        const chunk = NDJSON_ENCODER.encode(`${JSON.stringify(row)}\n`);

        rows += 1;
        bytes += chunk.byteLength;

        if (bytes > MAX_SCHEDULED_BACKUP_BYTES) {
            throw new LunoraError(
                `scheduled backup reached ${String(bytes)} bytes of NDJSON, past the ${String(MAX_SCHEDULED_BACKUP_BYTES)}-byte limit for a snapshot assembled inside a Worker — nothing was written. Narrow it with \`backupTables\`, or take this snapshot off-platform with \`lunora backup create --bucket\`.`,
                { code: "BACKUP_TOO_LARGE", status: 507 },
            );
        }

        chunks.push(chunk);
    };

    // An error from the export (including the size guard) propagates out of
    // here, so no partial object and no manifest is ever written.
    await streamExportRows(options, coordinator, forwardedHeaders, tables, writeRow, shardDO);

    const prefix = normalizeBackupPrefix(options.backupPrefix ?? BACKUP_KEY_PREFIX);
    const id = new Date(controller.scheduledTime).toISOString();
    const fileKey = backupObjectKey(prefix, id);
    const body = concatChunks(chunks, bytes);

    // Release the per-row chunks now that one contiguous copy exists; they are
    // the larger half of the two.
    chunks = [];

    // Digest the snapshot and hand it to R2 with the body: R2 verifies the
    // digest on write and records it, so a corrupted upload fails closed and
    // `head`/`list` can report a checksum afterwards. Recording it in the
    // manifest too is what lets `lunora backup restore --verify` check a
    // cron-written snapshot — without it the unattended tier would be the one
    // nobody can verify, which is backwards.
    const sha256 = toHex(await crypto.subtle.digest("SHA-256", body));

    await store.put(fileKey, body, { httpMetadata: { contentType: "application/x-ndjson" }, sha256 });

    const manifest: BackupManifest = {
        bytes,
        createdAt: id,
        cron: controller.cron,
        file: fileKey,
        id,
        rows,
        scheduledTime: controller.scheduledTime,
        sha256,
        ...(tables ? { tables: tables.join(",") } : {}),
    };

    await store.put(backupManifestKey(fileKey), `${JSON.stringify(manifest, undefined, 2)}\n`, {
        // Retention's writer check reads this back off the object listing.
        customMetadata: { [BACKUP_CRON_METADATA_KEY]: controller.cron },
        httpMetadata: { contentType: "application/json" },
    });

    // The backup has landed. Retention is reported, never applied: a scheduled
    // job that deletes backups as a side effect of writing one is the thing
    // plan 313 §4.4 rules out, and this subsystem's two worst defects were both
    // that deletion going wrong quietly. `lunora backup prune` is the only
    // thing that removes a backup now.
    //
    // Reporting is not optional decoration. Without automatic pruning a bucket
    // grows until somebody acts, and swapping "unexpected deletion" for
    // "unbounded storage nobody mentioned" would not be an improvement — so
    // every run that has snapshots past the window says so, and names the
    // command. A failed count is a warning, never a failed backup.
    try {
        const { stale } = await selectStaleBackups(store, prefix, options.backupRetain, controller.cron);

        if (stale.length > 0) {
            const shown = stale.slice(0, MAX_LOGGED_PRUNED_KEYS);
            const rest = stale.length - shown.length;

            // eslint-disable-next-line no-console -- server-side diagnostic, the same channel the prune itself uses; a Worker has no other operator-visible sink here.
            console.info(
                `[lunora] backup retention: ${String(stale.length)} snapshot(s) past the newest ${String(options.backupRetain)} — run \`lunora backup prune\` to remove them: ${shown.join(", ")}${rest > 0 ? ` (+${String(rest)} more)` : ""}`,
            );
        }
    } catch (error: unknown) {
        // eslint-disable-next-line no-console -- server-side diagnostic; the alternative is a silently missing retention report
        console.warn(`[lunora] backup ${fileKey} was written, but the retention report failed:`, error);
    }
};

/**
 * Delete every snapshot past the retention window — the one thing in the
 * runtime that removes a backup, and only when an operator asks.
 *
 * `confirmed` is the set the operator was shown and agreed to; only the
 * intersection with what is still eligible is removed.
 *
 * Refuses without `backupRetain`: there is no window, so nothing is past it,
 * and inventing a default here would be the implicit deletion this exists to
 * end. `Number.isInteger` for the same reason `selectStaleBackups` uses it —
 * `NaN` slips a `<= 0` check and then selects everything.
 */
const runBackupPrune = async (options: WorkerOptions, confirmed: ReadonlyArray<string>): Promise<PrunedBackups> => {
    const store = options.backupStore;

    if (!store) {
        throw new LunoraError("backup prune requires a `backupStore` on the worker", { code: "BACKUP_NOT_CONFIGURED", status: 500 });
    }

    const cron = options.backupCron;

    const retain = options.backupRetain;

    if (cron === undefined || retain === undefined || !Number.isInteger(retain) || retain <= 0) {
        throw new LunoraError(
            "backup prune needs a retention window: set `backupRetain` (and `backupCron`, which decides whose snapshots retention owns) on the worker. Without one there is nothing past the window to remove.",
            { code: "BACKUP_RETENTION_NOT_CONFIGURED", status: 400 },
        );
    }

    return pruneBackups(store, normalizeBackupPrefix(options.backupPrefix ?? BACKUP_KEY_PREFIX), retain, cron, confirmed);
};

export type { BackupManifest, BackupRetentionPreview, PrunedBackups };
export { previewBackupRetention, runBackupPrune, runScheduledBackup };
