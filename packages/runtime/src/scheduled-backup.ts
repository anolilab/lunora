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
import { BACKUP_KEY_PREFIX, backupManifestKey, backupObjectKey, backupObjectKeyOfManifest, isBackupManifestKey } from "./backup-layout";
import type { BackupStore, ScheduledControllerLike, WorkerOptions } from "./create-worker";
import { LunoraError } from "./errors";
import type { ExportRow } from "./export-stream";
import { streamExportRows } from "./export-stream";
import type { ShardNamespaceLike } from "./resolve-shard";

/** Shared, stateless encoder — `encode()` is reusable, so one instance serves every run. */
const NDJSON_ENCODER = new TextEncoder();

/** Safety bound on the retention list loop — far above any realistic backup count. */
const MAX_PRUNE_PAGES = 1000;

/** Sidecar reads in flight while pruning. Enough to hide round-trip latency over a retention window of tens. */
const PRUNE_READ_CONCURRENCY = 8;

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

/** A snapshot the scheduled backup took: the shared fields plus which trigger produced it. */
interface BackupManifest extends BackupManifestEntry {
    cron: string;
    scheduledTime: number;
    sha256: string;
}

/** Lowercase-hex encode a digest. */
const toHex = (buffer: ArrayBuffer): string => {
    let out = "";

    for (const byte of new Uint8Array(buffer)) {
        out += byte.toString(16).padStart(2, "0");
    }

    return out;
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

/** Read one sidecar, or `undefined` when it is missing or unreadable. */
const readManifest = async (store: BackupStore, key: string): Promise<BackupManifest | undefined> => {
    try {
        const object = await store.get(key);

        if (object === null) {
            return undefined;
        }

        return JSON.parse(await object.text()) as BackupManifest;
    } catch {
        // An unreadable sidecar is not evidence that the snapshot is ours to
        // delete. Treated as "someone else's", which keeps it.
        return undefined;
    }
};

/**
 * Enforce `backupRetain` by keeping only the newest N **scheduled** snapshots
 * and deleting the older ones plus their sidecars.
 *
 * The writer check is the whole point. Both backup writers share this prefix
 * and this sidecar suffix so that `lunora backup list --bucket` shows one
 * history — which also makes an operator's snapshot indistinguishable from a
 * cron's by key alone. Pruning on key shape would therefore delete the
 * pre-migration snapshot somebody took by hand an hour ago, silently, from the
 * bucket the docs told them to use. So each candidate's sidecar is read, and
 * only entries carrying this backup's own `scheduledTime` are eligible.
 *
 * Backup keys embed an ISO timestamp with `:`/`.` swapped for `-`, which sorts
 * lexicographically by recency, so a descending sort is a recency sort. A
 * no-op when retention is unset or non-positive.
 */
const pruneBackups = async (store: BackupStore, prefix: string, retain: number | undefined): Promise<void> => {
    if (retain === undefined || retain <= 0) {
        return;
    }

    const manifestKeys: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PRUNE_PAGES; page += 1) {
        // eslint-disable-next-line no-await-in-loop -- R2 list is paged; each request resumes from the prior page's cursor.
        const listing = await store.list({ cursor, prefix });

        for (const object of listing.objects) {
            if (isBackupManifestKey(object.key)) {
                manifestKeys.push(object.key);
            }
        }

        if (!listing.truncated || listing.cursor === undefined) {
            break;
        }

        cursor = listing.cursor;
    }

    // Newest first, then keep only the ones this backup wrote.
    const ordered = manifestKeys.toSorted((a, b) => b.localeCompare(a));
    const scheduled: string[] = [];

    for (let index = 0; index < ordered.length; index += PRUNE_READ_CONCURRENCY) {
        // eslint-disable-next-line no-await-in-loop -- one window of sidecar reads at a time
        const window = await Promise.all(
            ordered.slice(index, index + PRUNE_READ_CONCURRENCY).map(async (key) => [key, await readManifest(store, key)] as const),
        );

        for (const [key, manifest] of window) {
            if (typeof manifest?.scheduledTime === "number") {
                scheduled.push(key);
            }
        }
    }

    await Promise.all(scheduled.slice(retain).flatMap((manifestKey) => [store.delete(manifestKey), store.delete(backupObjectKeyOfManifest(manifestKey))]));
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

    const prefix = options.backupPrefix ?? BACKUP_KEY_PREFIX;
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

    await store.put(backupManifestKey(fileKey), `${JSON.stringify(manifest, undefined, 2)}\n`, { httpMetadata: { contentType: "application/json" } });

    await pruneBackups(store, prefix, options.backupRetain);
};

export type { BackupManifest };
export { MAX_SCHEDULED_BACKUP_BYTES, pruneBackups, runScheduledBackup };
