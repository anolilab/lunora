/**
 * Backups in an R2 bucket, reached through the worker's admin storage routes.
 *
 * The bucket binding on the worker is the authority — the CLI never holds R2
 * credentials, and nothing about the bucket is recorded in the manifest. Bytes
 * go up through the checksum-verified `PUT /_lunora/admin/storage` (the worker
 * digests the body and refuses to write on a mismatch) and come back down
 * through `GET /_lunora/admin/storage/object`, both gated by the admin bearer
 * that every other backup verb already carries.
 *
 * The index is a `<key>.manifest.json` sidecar beside each snapshot rather than
 * one shared index object. That is the layout the platform's own scheduled
 * backup writes (`@lunora/runtime`'s `scheduled-backup`), so
 * `lunora backup list --bucket` sees CLI-written and cron-written snapshots as
 * one history instead of two — and appending a snapshot never rewrites an
 * object another writer is also appending to. Both sides take the key, the
 * suffix and the manifest shape from `@lunora/runtime`'s `backup-layout`.
 */
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { LunoraError } from "@lunora/errors";
import type { BackupManifestEntry } from "@lunora/runtime";
import { BACKUP_KEY_PREFIX, backupManifestKey, backupObjectKey, isBackupManifestKey } from "@lunora/runtime";

import type { Logger } from "../../util/logger";
import type { BlobUploadContext } from "../data-transfer/storage-blobs";
import { bucketQuery, listStorageObjects, MAX_VERIFIED_UPLOAD_BYTES, uploadStorageBlob } from "../data-transfer/storage-blobs";
import type { BackupDestination } from "./destination";
import { isManifestEntry } from "./destination";

/** Admin route serving one object's bytes back (see `@lunora/runtime`'s storage admin routes). */
const STORAGE_OBJECT_ENDPOINT_PATH = "/_lunora/admin/storage/object";
const STORAGE_ENDPOINT_PATH = "/_lunora/admin/storage";

/** Sidecar reads in flight while listing. Enough to hide round-trip latency without opening a socket per snapshot. */
const MANIFEST_READ_CONCURRENCY = 8;

interface R2DestinationOptions {
    /** Where to reach the worker's admin storage routes, and which bucket to address (`context.bucket`). */
    context: BlobUploadContext;
    logger: Logger;
    /** Key prefix backups live under. Defaults to `@lunora/runtime`'s `BACKUP_KEY_PREFIX`. */
    prefix?: string;
}

/**
 * A prefix is a key prefix, not a directory, but everyone types it like one.
 * Without this, `--prefix backups` yields `backupslunora-backup-…` — a key that
 * works, sorts oddly, and does not match anything the scheduled backup wrote.
 */
const normalizePrefix = (prefix: string): string => (prefix === "" || prefix.endsWith("/") ? prefix : `${prefix}/`);

const createR2Destination = (options: R2DestinationOptions): BackupDestination => {
    const { context, logger } = options;
    const prefix = normalizePrefix(options.prefix ?? BACKUP_KEY_PREFIX);
    const label = `bucket ${context.bucket ?? "(default)"} under ${prefix}`;
    // The bucket the whole destination addresses lives on the context, so the
    // upload helpers and these routes cannot end up naming different buckets.
    const bucketParameter = bucketQuery(context);

    const objectUrl = (key: string): string => `${context.baseUrl}${STORAGE_OBJECT_ENDPOINT_PATH}?key=${encodeURIComponent(key)}${bucketParameter}`;

    /** Fetch one object's bytes as text — used for the small manifest sidecars. */
    const readObject = async (key: string): Promise<string> => {
        const response = await context.fetchImpl(objectUrl(key), { headers: { authorization: `Bearer ${context.token}` }, method: "GET" });

        if (!response.ok) {
            const text = await response.text().catch(() => "<no body>");

            throw new LunoraError("INTERNAL", `backup: could not read ${key} (HTTP ${String(response.status)}): ${text}`);
        }

        return response.text();
    };

    /** Read one sidecar, or `undefined` (with a warning) when it cannot be read or parsed. */
    const readManifestEntry = async (key: string): Promise<BackupManifestEntry | undefined> => {
        try {
            const parsed: unknown = JSON.parse(await readObject(key));

            if (isManifestEntry(parsed)) {
                return parsed;
            }

            logger.warn(`backup: ignoring ${key} — not a backup manifest`);
        } catch (error: unknown) {
            logger.warn(`backup: ignoring ${key} — ${error instanceof Error ? error.message : String(error)}`);
        }

        return undefined;
    };

    return {
        commit: async (file, stagedPath, digest) => {
            // Above the admin upload route's body cap, `uploadStorageBlob` falls
            // back to a signed PUT: no server-side digest, and only available
            // when the app configured URL signing at all. Neither is acceptable
            // for the copy an operator restores from, so a backup that would
            // take that path is refused instead — with the size named, because
            // "no signed PUT URL could be minted" is not something an operator
            // can act on.
            if (digest.bytes > MAX_VERIFIED_UPLOAD_BYTES) {
                throw new LunoraError(
                    "INTERNAL",
                    `backup: the snapshot is ${String(digest.bytes)} bytes, above the ${String(MAX_VERIFIED_UPLOAD_BYTES)}-byte limit for a checksum-verified upload — nothing was written. Narrow it with \`--tables\`, or write it to a directory with \`--dir\` and move the file yourself (\`wrangler r2 object put\`).`,
                );
            }

            // Read by value: the upload route takes one body. That is what the
            // limit above bounds.
            const body = await readFile(stagedPath);

            await uploadStorageBlob(context, file, body, { contentType: "application/x-ndjson", id: file, sha256: digest.sha256, size: digest.bytes }, logger);
        },
        label,
        list: async () => {
            const objects = await listStorageObjects(context, prefix);
            const manifestKeys = objects.map((object_) => object_.key).filter((key) => isBackupManifestKey(key));
            const entries: BackupManifestEntry[] = [];

            // One read per snapshot, in windows. A damaged or unrelated sidecar
            // is skipped with a warning rather than thrown: `restore` reads this
            // list before it can reach a snapshot named directly, so throwing
            // here would let one bad object block recovery of every good one —
            // at the one moment that must not happen.
            for (let index = 0; index < manifestKeys.length; index += MANIFEST_READ_CONCURRENCY) {
                // eslint-disable-next-line no-await-in-loop -- one window of reads at a time
                const window = await Promise.all(manifestKeys.slice(index, index + MANIFEST_READ_CONCURRENCY).map(async (key) => readManifestEntry(key)));

                entries.push(...window.filter((entry): entry is BackupManifestEntry => entry !== undefined));
            }

            // Oldest first, matching a directory manifest's append order. Ids are
            // ISO timestamps, so a lexicographic sort is a chronological one.
            return entries.toSorted((a, b) => a.id.localeCompare(b.id));
        },
        locate: (id) => backupObjectKey(prefix, id),
        materialize: async (entry, target) => {
            const key = entry?.file ?? target;
            const response = await context.fetchImpl(objectUrl(key), { headers: { authorization: `Bearer ${context.token}` }, method: "GET" });

            if (response.status === 404) {
                return undefined;
            }

            if (!response.ok || response.body === null) {
                const text = await response.text().catch(() => "<no body>");

                throw new LunoraError("INTERNAL", `backup: could not download ${key} (HTTP ${String(response.status)}): ${text}`);
            }

            // Stream to a temp file rather than buffering: a restore reads the
            // whole snapshot, and it is exactly the case where the snapshot is
            // large.
            const directory = await mkdtemp(join(tmpdir(), "lunora-backup-"));
            const path = join(directory, key.split("/").at(-1) ?? "snapshot.ndjson");

            try {
                await pipeline(Readable.from(response.body as AsyncIterable<Uint8Array>), createWriteStream(path));
            } catch (error: unknown) {
                // Nothing returns `release` on this path, so the temp directory
                // (holding however much of the snapshot arrived) would be left
                // behind on every failed download.
                await rm(directory, { force: true, recursive: true });

                throw error;
            }

            return { path, release: async () => rm(directory, { force: true, recursive: true }) };
        },
        record: async (entry) => {
            const key = backupManifestKey(entry.file);
            const response = await context.fetchImpl(`${context.baseUrl}${STORAGE_ENDPOINT_PATH}?key=${encodeURIComponent(key)}${bucketParameter}`, {
                body: `${JSON.stringify(entry, undefined, 2)}\n`,
                headers: { authorization: `Bearer ${context.token}`, "content-type": "application/json" },
                method: "PUT",
            });

            if (!response.ok) {
                const text = await response.text().catch(() => "<no body>");

                throw new LunoraError(
                    "INTERNAL",
                    `backup: snapshot ${entry.file} was written but its manifest was not (HTTP ${String(response.status)}): ${text}`,
                );
            }
        },
        stage: async (id) => {
            const directory = await mkdtemp(join(tmpdir(), "lunora-backup-"));

            return { path: join(directory, backupObjectKey("", id)), release: async () => rm(directory, { force: true, recursive: true }) };
        },
    };
};

export type { R2DestinationOptions };
export { createR2Destination };
