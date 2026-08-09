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

/** How many deleted keys the retention log names before summarising the rest. */
const MAX_LOGGED_PRUNED_KEYS = 10;

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

/** What a prune removed: the sidecar keys it deleted, each naming a snapshot at the same key without the suffix. */
interface PrunedBackups {
    deleted: string[];
}

/** What retention would delete on the next run, and the configuration that decides it. */
interface BackupRetentionPreview {
    /** The trigger retention belongs to. `undefined` when no scheduled backup is configured. */
    cron?: string;
    /** Snapshots this cron owns — legacy sidecars and other writers' are not counted, because retention never touches them. */
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
 * Retention and `GET /_lunora/admin/backup/retention` both call this, and that
 * is the point: a preview that can disagree with the prune is worse than no
 * preview, and this branch has already shown twice what happens when one rule
 * gets written in two places. Nothing here deletes, so the preview cannot.
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
 * lexicographically by recency, so a descending sort is a recency sort. Empty
 * when retention is unset or non-positive — nothing is ever deleted without
 * `backupRetain`.
 */
const selectStaleBackups = async (store: BackupStore, prefix: string, retain: number | undefined, cron: string): Promise<StaleBackups> => {
    if (retain === undefined || retain <= 0) {
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
 * Enforce `backupRetain` by deleting every snapshot {@link selectStaleBackups}
 * picks, plus its sidecar.
 */
const pruneBackups = async (store: BackupStore, prefix: string, retain: number | undefined, cron: string): Promise<PrunedBackups> => {
    const { stale } = await selectStaleBackups(store, prefix, retain, cron);

    if (stale.length === 0) {
        return { deleted: [] };
    }

    await Promise.all(
        stale.map(async (manifestKey) => {
            // Snapshot first, sidecar second. A sidecar without its snapshot
            // is a listable entry that fails to restore; a snapshot without
            // its sidecar is invisible to retention forever, because the
            // marker retention prunes on lives on the sidecar. If only one
            // delete lands, this order is the recoverable one — the next run
            // sees the sidecar again and retries.
            await store.delete(backupObjectKeyOfManifest(manifestKey));
            await store.delete(manifestKey);
        }),
    );

    // Say what was destroyed. Both retention defects found in review (pruning
    // an operator's snapshots, then another deployment's) were silent
    // successes, reconstructed afterwards from a missing file — so a prune
    // leaves a record even though an operator asked for this one.
    //
    // Keys are capped because a first prune on an old bucket can remove many,
    // and a log line nobody can read is its own kind of silence.
    const shown = stale.slice(0, MAX_LOGGED_PRUNED_KEYS);
    const rest = stale.length - shown.length;

    // eslint-disable-next-line no-console -- server-side diagnostic, same channel as the retention-failure warning; a Worker has no other operator-visible sink here.
    console.info(
        `[lunora] backup prune kept the newest ${String(retain)} and deleted ${String(stale.length)}: ${shown.join(", ")}${rest > 0 ? ` (+${String(rest)} more)` : ""}`,
    );

    return { deleted: stale };
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

    // Both objects have landed by here, so the backup succeeded whatever
    // retention does next. Failing the cron invocation for a failed prune would
    // report a broken backup to an operator whose backup is fine, and bury the
    // real symptom — that retention stopped.
    try {
        await pruneBackups(store, prefix, options.backupRetain, controller.cron);
    } catch (error: unknown) {
        // eslint-disable-next-line no-console -- server-side diagnostic; the alternative is a silently broken retention
        console.warn(`[lunora] backup ${fileKey} was written, but retention failed:`, error);
    }
};

export type { BackupManifest, BackupRetentionPreview };
export { previewBackupRetention, runScheduledBackup };
