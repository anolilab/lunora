/**
 * Backups in an R2 bucket, reached through the worker's admin storage routes.
 *
 * The bucket binding on the worker is the authority — the CLI never holds R2
 * credentials, and nothing about the bucket is recorded in the manifest. Bytes
 * go up through the same checksum-verified `PUT /_lunora/admin/storage` the
 * blob importer uses (the worker digests the body and refuses to write on a
 * mismatch) and come back down through `GET /_lunora/admin/storage/object`,
 * both gated by the admin bearer that every other backup verb already carries.
 *
 * The index is a `<key>.manifest.json` sidecar beside each snapshot rather than
 * one shared index object. That is the layout the platform's own scheduled
 * backup (`backupCron` / `backupStore` in `@lunora/runtime`) already writes, so
 * `lunora backup list --bucket` sees CLI-written and cron-written snapshots as
 * one history instead of two — and appending a snapshot never rewrites an
 * object another writer is also appending to.
 */
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { LunoraError } from "@lunora/errors";

import type { Logger } from "../../util/logger";
import type { BlobUploadContext } from "../data-transfer/storage-blobs";
import { listStorageObjects, uploadStorageBlob } from "../data-transfer/storage-blobs";
import type { BackupDestination, BackupManifestEntry } from "./destination";
import { isManifestEntry } from "./destination";

/** Admin route serving one object's bytes back (see `@lunora/runtime`'s storage admin routes). */
const STORAGE_OBJECT_ENDPOINT_PATH = "/_lunora/admin/storage/object";
const STORAGE_ENDPOINT_PATH = "/_lunora/admin/storage";

/** Suffix of the per-snapshot manifest sidecar. Must match `@lunora/runtime`'s scheduled backup. */
const MANIFEST_SUFFIX = ".manifest.json";

/** Default key prefix — the same one the platform's scheduled backup writes under, so both land in one history. */
const DEFAULT_BACKUP_PREFIX = "backups/";

interface R2DestinationOptions {
    /** Where to reach the worker's admin storage routes, and which bucket to address (`context.bucket`). */
    context: BlobUploadContext;
    logger: Logger;
    /** Key prefix backups live under. Defaults to {@link DEFAULT_BACKUP_PREFIX}. */
    prefix?: string;
}

const createR2Destination = (options: R2DestinationOptions): BackupDestination => {
    const { context, logger } = options;
    const prefix = options.prefix ?? DEFAULT_BACKUP_PREFIX;
    const label = `bucket ${context.bucket ?? "(default)"} under ${prefix}`;
    // The bucket the whole destination addresses lives on the context, so the
    // upload helpers and these routes cannot end up naming different buckets.
    const bucketParameter = context.bucket === undefined ? "" : `&bucket=${encodeURIComponent(context.bucket)}`;

    /** Fetch one object's bytes as text — used for the small manifest sidecars. */
    const readObject = async (key: string): Promise<string> => {
        const response = await context.fetchImpl(`${context.baseUrl}${STORAGE_OBJECT_ENDPOINT_PATH}?key=${encodeURIComponent(key)}${bucketParameter}`, {
            headers: { authorization: `Bearer ${context.token}` },
            method: "GET",
        });

        if (!response.ok) {
            const text = await response.text().catch(() => "<no body>");

            throw new LunoraError("INTERNAL", `backup: could not read ${key} (HTTP ${String(response.status)}): ${text}`);
        }

        return response.text();
    };

    return {
        commit: async (file, stagedPath, digest) => {
            try {
                // ponytail: the snapshot is buffered to upload it, because the
                // admin upload route (and the signed-PUT fallback above its 32
                // MiB cap) both take a whole body. Snapshots beyond a few
                // hundred MiB need R2 multipart before this is safe.
                const body = await readFile(stagedPath);

                await uploadStorageBlob(
                    context,
                    file,
                    body,
                    { contentType: "application/x-ndjson", id: file, sha256: digest.sha256, size: digest.bytes },
                    logger,
                );
            } finally {
                await rm(dirname(stagedPath), { force: true, recursive: true });
            }
        },
        label,
        list: async () => {
            const objects = await listStorageObjects(context, prefix);
            const manifestKeys = objects.map((object_) => object_.key).filter((key) => key.endsWith(MANIFEST_SUFFIX));
            const entries = await Promise.all(manifestKeys.map(async (key) => JSON.parse(await readObject(key)) as unknown));

            // Oldest first, matching a directory manifest's append order. Ids are
            // ISO timestamps, so a lexicographic sort is a chronological one.
            return entries.filter((entry): entry is BackupManifestEntry => isManifestEntry(entry)).toSorted((a, b) => a.id.localeCompare(b.id));
        },
        locate: (name) => `${prefix}${name}`,
        materialize: async (file) => {
            const response = await context.fetchImpl(`${context.baseUrl}${STORAGE_OBJECT_ENDPOINT_PATH}?key=${encodeURIComponent(file)}${bucketParameter}`, {
                headers: { authorization: `Bearer ${context.token}` },
                method: "GET",
            });

            if (response.status === 404) {
                return undefined;
            }

            if (!response.ok || response.body === null) {
                const text = await response.text().catch(() => "<no body>");

                throw new LunoraError("INTERNAL", `backup: could not download ${file} (HTTP ${String(response.status)}): ${text}`);
            }

            // Stream to a temp file rather than buffering: a restore reads the
            // whole snapshot, and it is exactly the case where the snapshot is
            // large.
            const directory = await mkdtemp(join(tmpdir(), "lunora-backup-"));
            const path = join(directory, file.split("/").at(-1) ?? "snapshot.ndjson");

            await pipeline(Readable.from(response.body as AsyncIterable<Uint8Array>), createWriteStream(path));

            return { path, release: async () => rm(directory, { force: true, recursive: true }) };
        },
        record: async (entry) => {
            const key = `${entry.file}${MANIFEST_SUFFIX}`;
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
        stage: async (name) => join(await mkdtemp(join(tmpdir(), "lunora-backup-")), name),
    };
};

export type { R2DestinationOptions };
export { createR2Destination };
