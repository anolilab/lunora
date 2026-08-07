/**
 * Moving a foreign bucket into R2.
 *
 * Two producers, one sink. Supabase objects are listed and downloaded live
 * through its Storage REST API with a service-role key; Firebase objects are
 * read from a directory the operator downloaded with `gcloud storage cp -r`,
 * because `gcloud` already owns Google's auth and re-implementing it in the CLI
 * buys nothing. Both then take the identical path into R2: content-hash key,
 * checksum-verified upload, skip-if-present, delete-on-mismatch — all of it
 * inherited from the Convex blob migration rather than rebuilt.
 *
 * Every transfer is checkpointed, so a run that dies at object 40,000 resumes
 * without re-downloading the first 39,999.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { LunoraError } from "@lunora/errors";

import type { Logger } from "../../../util/logger";
import type { StreamingFetchLike } from "../shared";
import type { BlobUploadContext, StorageMetadataRow } from "../storage-blobs";
import { listStorageObjects, uploadStorageBlob } from "../storage-blobs";
import { progressFileFor, readTransferProgress, recordTransfer } from "./storage-progress";

/** One object waiting to move, with its bytes fetched lazily so a skipped object costs no download. */
interface SourceObject {
    bytes: () => Promise<Buffer>;
    contentType?: string;
    /** Provider-side path, e.g. `avatars/user-1.png`. The checkpoint key and the value a document column holds. */
    path: string;
}

/** Credentials for a live Supabase project. */
interface SupabaseStorageCredentials {
    serviceKey: string;
    url: string;
}

const SUPABASE_LIST_PAGE_SIZE = 100;

/** Percent-encode each path segment without encoding the separators. */
const encodeObjectPath = (path: string): string =>
    path
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");

/** One page of Supabase's list endpoint, which is POST-with-a-body and pages by offset. */
const fetchSupabaseListPage = async (
    credentials: SupabaseStorageCredentials,
    bucket: string,
    fetchImpl: StreamingFetchLike,
    prefix: string,
    offset: number,
): Promise<{ id?: null | string; metadata?: { mimetype?: string; size?: number }; name: string }[]> => {
    const response = await fetchImpl(`${credentials.url}/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
        body: JSON.stringify({ limit: SUPABASE_LIST_PAGE_SIZE, offset, prefix }),
        headers: { authorization: `Bearer ${credentials.serviceKey}`, "content-type": "application/json" },
        method: "POST",
    });

    if (!response.ok) {
        const text = await response.text().catch(() => "<no body>");

        throw new LunoraError("INTERNAL", `Supabase storage list failed for bucket ${bucket} (HTTP ${String(response.status)}): ${text}`);
    }

    return (await response.json()) as { id?: null | string; metadata?: { mimetype?: string; size?: number }; name: string }[];
};

/** Walk a bucket depth-first, since the list endpoint returns one level at a time. */
const listSupabaseBucketObjects = async (
    credentials: SupabaseStorageCredentials,
    bucket: string,
    fetchImpl: StreamingFetchLike,
    prefix = "",
): Promise<{ contentType?: string; name: string }[]> => {
    const objects: { contentType?: string; name: string }[] = [];
    let offset = 0;

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- offset paging is sequential by definition
        const page = await fetchSupabaseListPage(credentials, bucket, fetchImpl, prefix, offset);

        for (const entry of page) {
            const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

            // A folder placeholder has a null `id`; recursing into it is how the
            // whole tree is walked, since the list endpoint is one level deep.
            if (entry.id === null || entry.id === undefined) {
                // eslint-disable-next-line no-await-in-loop -- depth-first walk of the bucket
                objects.push(...(await listSupabaseBucketObjects(credentials, bucket, fetchImpl, path)));
            } else {
                objects.push({ contentType: entry.metadata?.mimetype, name: path });
            }
        }

        if (page.length < SUPABASE_LIST_PAGE_SIZE) {
            return objects;
        }

        offset += page.length;
    }
};

/** Every object in every bucket the project exposes. */
const listSupabaseObjects = async (credentials: SupabaseStorageCredentials, fetchImpl: StreamingFetchLike, logger: Logger): Promise<SourceObject[]> => {
    const response = await fetchImpl(`${credentials.url}/storage/v1/bucket`, {
        headers: { authorization: `Bearer ${credentials.serviceKey}` },
        method: "GET",
    });

    if (!response.ok) {
        const text = await response.text().catch(() => "<no body>");

        throw new LunoraError(
            "INTERNAL",
            `Supabase bucket list failed (HTTP ${String(response.status)}): ${text} — check the project URL and that the key is the service-role key, not the anon key`,
        );
    }

    const buckets = (await response.json()) as { name: string }[];
    const objects: SourceObject[] = [];

    for (const bucket of buckets) {
        // eslint-disable-next-line no-await-in-loop -- one bucket at a time keeps the listing memory bounded
        const entries = await listSupabaseBucketObjects(credentials, bucket.name, fetchImpl);

        logger.info(`supabase bucket ${bucket.name}: ${String(entries.length)} object(s)`);

        for (const entry of entries) {
            const path = `${bucket.name}/${entry.name}`;

            objects.push({
                contentType: entry.contentType,
                bytes: async () => {
                    const download = await fetchImpl(
                        `${credentials.url}/storage/v1/object/${encodeURIComponent(bucket.name)}/${encodeObjectPath(entry.name)}`,
                        {
                            headers: { authorization: `Bearer ${credentials.serviceKey}` },
                            method: "GET",
                        },
                    );

                    if (!download.ok) {
                        const text = await download.text().catch(() => "<no body>");

                        throw new LunoraError("INTERNAL", `Supabase download failed for ${path} (HTTP ${String(download.status)}): ${text}`);
                    }

                    if (download.arrayBuffer === undefined) {
                        throw new LunoraError("INTERNAL", "the fetch implementation cannot read response bytes, which the storage transfer requires");
                    }

                    return Buffer.from(await download.arrayBuffer());
                },
                path,
            });
        }
    }

    return objects;
};

/**
 * Every file under a locally-downloaded bucket directory.
 *
 * The directory is operator-supplied, so each entry is resolved and checked to
 * still sit inside it before being read — a symlink out of the tree would
 * otherwise upload an unrelated local file to the bucket.
 */
const listLocalObjects = async (directory: string): Promise<SourceObject[]> => {
    const root = resolve(directory);
    const objects: SourceObject[] = [];

    const walk = async (current: string): Promise<void> => {
        const entries = await readdir(current, { withFileTypes: true }).catch(() => undefined);

        if (entries === undefined) {
            throw new LunoraError(
                "INTERNAL",
                `${directory} is not a readable directory — download the bucket first with \`gcloud storage cp -r gs://<bucket> <dir>\``,
            );
        }

        for (const entry of entries) {
            const full = resolve(current, entry.name);

            if (full !== root && !full.startsWith(root + sep)) {
                throw new LunoraError("INTERNAL", `${entry.name} resolves outside ${directory} — refusing to upload it`);
            }

            if (entry.isDirectory()) {
                // eslint-disable-next-line no-await-in-loop -- depth-first walk
                await walk(full);
            } else if (entry.isFile()) {
                objects.push({ bytes: async () => readFile(full), path: relative(root, full).split(sep).join("/") });
            }
        }
    };

    await walk(root);

    return objects;
};

/**
 * Download one object, upload it under its content hash, and checkpoint it.
 *
 * The checkpoint is written only after the upload returns, which is what makes a
 * resume exact: a recorded object is one that is definitely in R2.
 */
const moveOneObject = async (
    context: BlobUploadContext,
    entry: SourceObject,
    options: { cwd: string; keyPrefix: string; source: string },
    alreadyStored: Map<string, { size?: number }>,
    logger: Logger,
): Promise<string> => {
    const bytes = await entry.bytes();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const key = `${options.keyPrefix}${sha256}`;

    if (alreadyStored.get(key)?.size !== bytes.length) {
        const metadata: StorageMetadataRow = { contentType: entry.contentType, id: entry.path, sha256, size: bytes.length };

        await uploadStorageBlob(context, bytes, metadata, options.keyPrefix, logger);
    }

    await recordTransfer(options.cwd, options.source, { key, path: entry.path, size: bytes.length });

    return key;
};

/**
 * Report progress at a readable cadence.
 *
 * A line per object drowns the run; a line only at the end tells an operator
 * nothing while a multi-hour transfer is in flight. Every 25 objects, plus the
 * last, is enough to see it moving and to estimate what is left.
 */
const createProgressReporter = (total: number, logger: Logger): ((done: number) => void) => {
    const every = total > 500 ? 100 : 25;

    return (done: number): void => {
        if (done === total || done % every === 0) {
            const percent = total === 0 ? 100 : Math.round((done / total) * 100);

            logger.info(`transferred ${String(done)}/${String(total)} object(s) (${String(percent)}%)`);
        }
    };
};

/**
 * Move every object into R2, checkpointing as it goes, and return the
 * `sourcePath → R2 key` map the document rewrite needs.
 *
 * The order matters: check the checkpoint before downloading (a resumed run
 * should not pay for bytes it already moved), then the bucket listing (a first
 * run against a partly-populated bucket should not re-upload either).
 */
const transferStorageObjects = async (
    context: BlobUploadContext,
    objects: ReadonlyArray<SourceObject>,
    options: { cwd: string; keyPrefix: string; source: string },
    logger: Logger,
): Promise<Map<string, string>> => {
    const transferred = new Map<string, string>();
    const done = await readTransferProgress(options.cwd, options.source, logger);
    const stored = await listStorageObjects(context, options.keyPrefix);
    const alreadyStored = new Map(stored.map((entry) => [entry.key, entry]));

    if (done.size > 0 && stored.length === 0) {
        logger.warn(
            `the checkpoint records ${String(done.size)} transferred object(s) but the target holds none under \`${options.keyPrefix}\` — re-transferring (a different deployment, a wiped bucket, or a changed keyPrefix)`,
        );
    }
    const report = createProgressReporter(objects.length, logger);
    let completed = 0;

    logger.info(`transferring ${String(objects.length)} object(s) to R2...`);

    for (const entry of objects) {
        const checkpoint = done.get(entry.path);

        // The checkpoint says "this run moved it"; the listing says "it is still
        // there". Both have to hold. A checkpoint carries no record of which
        // deployment it was written against, so trusting it alone means a resume
        // against a different or wiped bucket skips every upload and then
        // rewrites documents to keys that do not exist — exit 0, `--verify`
        // green, every file reference broken.
        if (checkpoint !== undefined && alreadyStored.has(checkpoint.key)) {
            transferred.set(entry.path, checkpoint.key);
            completed += 1;
            report(completed);

            continue;
        }

        try {
            // eslint-disable-next-line no-await-in-loop -- one object at a time; the checkpoint is only exact if the upload precedes the next read
            const key = await moveOneObject(context, entry, options, alreadyStored, logger);

            transferred.set(entry.path, key);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);

            logger.error(`failed transferring ${entry.path} after ${String(completed)} object(s): ${message}`);
            logger.error(`progress is saved — re-run the same command to continue from here (delete ${progressFileFor(options.source)} to start over)`);

            throw error;
        }

        completed += 1;
        report(completed);
    }

    logger.success(`transferred ${String(objects.length)} object(s) to R2`);

    return transferred;
};

export type { SourceObject, SupabaseStorageCredentials };
export { listLocalObjects, listSupabaseObjects, transferStorageObjects };
