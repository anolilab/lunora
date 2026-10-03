/**
 * A `@visulima/storage` provider that writes resumable uploads through a
 * Worker's **R2 binding**, for `createUploadHandler`.
 *
 * `createR2UploadStorage` talks to R2's S3 API, so it needs S3 credentials and
 * a real bucket: under `wrangler dev` / miniflare, in tests and in CI there is
 * no S3 endpoint and the resumable path cannot run. This provider uses only the
 * binding (`get` / `put` / `delete` / `list` and the multipart API), so it
 * behaves the same under miniflare as in production.
 *
 * # Where the upload state lives
 *
 * In the bucket itself, as one JSON object per upload under `statePrefix`. A
 * request for the same upload can land on any isolate, so nothing is kept in
 * memory between requests. R2 is strongly consistent and supports conditional
 * writes (`onlyIf: { etagMatches }`), which is all a compare-and-swap needs, so
 * the state does not need a Durable Object or a new binding.
 *
 * # Part buffering
 *
 * R2 rejects a multipart upload unless every part but the last is at least
 * 5 MiB **and all of them are the same size**. Clients send whatever chunk size
 * they like (TUS defaults to 1 MiB), so chunks are coalesced into parts of
 * exactly `R2_PART_SIZE` bytes: part `n` always holds bytes
 * `[(n - 1) * R2_PART_SIZE, n * R2_PART_SIZE)` of the file. Whatever a request
 * leaves over (less than one part) is written to its own small "segment" object
 * and recorded in the state; the request that completes the next part reads the
 * segments back into it. A request holds at most about two parts in memory,
 * however large its body, and no byte is rewritten while it waits. A file
 * smaller than one part never starts a multipart upload: its bytes are written
 * with a single `put` when the last one arrives.
 *
 * # Concurrent requests
 *
 * A write first checks the client's offset against the stored one (a mismatch
 * is a `409`, as TUS requires), then takes a lease on the upload by writing a
 * lock token into the state with a conditional put. Another request for the
 * same upload while the lease is held gets a `409` and writes nothing. The
 * lease is renewed while the body streams and released by the conditional
 * write that records the new offset; a writer that finds its token gone (its
 * lease expired and another request took over) gives up instead of committing.
 * Because parts are aligned to fixed offsets, a part stored by a writer that
 * lost its lease holds the same bytes the new writer stores under that part
 * number, so it cannot corrupt the upload.
 */
import type { BaseStorageOptions, FileInit, FilePart, FileQuery } from "@visulima/storage";
import { AbstractBaseStorage, ERRORS, File, isUploadError, throwErrorCode, UploadError } from "@visulima/storage";

import { readBody } from "./byte-queue";
import { R2UploadPartWriter } from "./r2-upload-part-writer";
import type { StoredState } from "./r2-upload-state-store";
import { R2UploadStateStore } from "./r2-upload-state-store";
import type { FileRecord, R2UploadBucket, UploadProgress, UploadState } from "./r2-upload-types";
import type { UploadStorage } from "./upload-handler";

/** What `get()` answers; `@visulima/storage` does not export the type by name. */
type FileReturn = Awaited<ReturnType<AbstractBaseStorage["get"]>>;

/** Options for {@link createR2BindingUploadStorage}. */
interface R2BindingUploadStorageOptions extends Omit<BaseStorageOptions, "metaStorage"> {
    /**
     * Key prefix the upload state objects and buffered segments are stored
     * under, in the same bucket. Default `"_lunora/uploads/"`. They show up in a
     * listing of the bucket; an R2 lifecycle rule on this prefix cleans up
     * uploads that were started and never finished.
     */
    statePrefix?: string;
}

const DEFAULT_STATE_PREFIX = "_lunora/uploads/";

/** How long a write's lease on an upload lasts without being renewed. */
const LEASE_MS = 60_000;

/** Fields of the file record this provider owns: `update()` never takes them from a caller. */
const PROVIDER_OWNED_FIELDS = new Set(["bytesWritten", "id", "name", "size", "status"]);

/** TUS extensions this provider cannot honor. Advertising them would let a client start an upload it cannot finish. */
const UNSUPPORTED_TUS_EXTENSIONS = new Set(["checksum", "concatenation", "creation-defer-length"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

const deepMerge = (target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> => {
    const merged: Record<string, unknown> = { ...target };

    for (const [key, value] of Object.entries(source)) {
        const existing = merged[key];

        merged[key] = isPlainObject(value) && isPlainObject(existing) ? deepMerge(existing, value) : value;
    }

    return merged;
};

const conflict = (message: string): never => throwErrorCode(ERRORS.FILE_CONFLICT, message);

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/**
 * Resumable-upload storage over a Worker's R2 binding. Build it with
 * {@link createR2BindingUploadStorage}.
 */
class R2BindingUploadStorage extends AbstractBaseStorage {
    protected override meta: R2UploadStateStore;

    private readonly bucket: R2UploadBucket;

    public constructor(bucket: R2UploadBucket, options: R2BindingUploadStorageOptions = {}) {
        super(options);

        this.bucket = bucket;
        this.meta = new R2UploadStateStore(bucket, options.statePrefix ?? DEFAULT_STATE_PREFIX);
    }

    public override get tusExtension(): string[] {
        return super.tusExtension.filter((extension) => !UNSUPPORTED_TUS_EXTENSIONS.has(extension));
    }

    public async create(fileInit: FileInit): Promise<File> {
        return this.instrumentOperation("create", async () => {
            const file: FileRecord = new File(fileInit);

            file.name = this.namingFunction(file);
            AbstractBaseStorage.assertSafeId(file.id);
            await this.validate(file);

            // Same id, same upload: a client re-sending its create resumes it,
            // as the S3 providers do.
            const existing = await this.meta.read(file.id);

            if (existing !== undefined) {
                return existing.state.file;
            }

            if (typeof fileInit.ttl === "number" && Number.isFinite(fileInit.ttl)) {
                file.expiredAt = Date.now() + fileInit.ttl;
            }

            file.bytesWritten = 0;
            file.status = "created";
            this.updateTimestamps(file);

            // `File` reads a declared size of 0 as "no size". A zero-byte upload
            // never receives a write, so it is finished here.
            if (fileInit.size !== undefined && Number(fileInit.size) === 0) {
                await this.bucket.put(file.name, new Uint8Array(0), { httpMetadata: { contentType: file.contentType } });
                file.size = 0;
                file.status = "completed";
            }

            await this.meta.write(file.id, { file, upload: { parts: [], segments: [] } });
            await this.onCreate(file);

            return file;
        });
    }

    public async write(part: File | FilePart | FileQuery): Promise<File> {
        return this.instrumentOperation("write", async () => {
            const stored = await this.meta.read(part.id);

            if (stored === undefined) {
                return throwErrorCode(ERRORS.FILE_NOT_FOUND);
            }

            const file = await this.checkIfExpired(stored.state.file);

            if (file.status === "completed" || !("body" in part) || !("start" in part)) {
                return file;
            }

            this.checkPart(file, part);

            const token = await this.acquireLease(file.id, stored);

            try {
                return await this.writeLeased(file, stored.state.upload, part.body, token);
            } catch (error) {
                await this.releaseLease(file.id, token).catch(() => undefined);

                throw error;
            }
        });
    }

    public async get({ id }: FileQuery): Promise<FileReturn> {
        return this.instrumentOperation("get", async () => {
            const file = await this.checkIfExpired(await this.getMeta(id));
            const object = file.status === "completed" ? await this.bucket.get(file.name) : undefined;

            if (object === undefined || object === null) {
                return throwErrorCode(ERRORS.FILE_NOT_FOUND);
            }

            const content = Buffer.from(await object.arrayBuffer());

            return {
                content,
                contentType: file.contentType,
                ETag: object.etag,
                expiredAt: file.expiredAt,
                id,
                metadata: file.metadata,
                modifiedAt: file.modifiedAt,
                name: file.name,
                originalName: file.originalName,
                size: content.byteLength,
            };
        });
    }

    public async delete({ id }: FileQuery): Promise<File> {
        return this.instrumentOperation("delete", async () => {
            const stored = await this.meta.read(id);

            if (stored === undefined) {
                return throwErrorCode(ERRORS.FILE_NOT_FOUND);
            }

            const { file, upload } = stored.state;

            if (upload.lock !== undefined && upload.lock.expiresAt > Date.now()) {
                return conflict("A request is writing to this upload");
            }

            if (file.status === "completed") {
                await this.bucket.delete(file.name);
            } else if (upload.uploadId !== undefined) {
                await this.bucket
                    .resumeMultipartUpload(file.name, upload.uploadId)
                    .abort()
                    .catch(() => undefined);
            }

            await this.deleteSegments(id);
            await this.deleteMeta(id);

            const deleted: FileRecord = { ...file, status: "deleted" };

            await this.onDelete(deleted);

            return deleted;
        });
    }

    /**
     * Merge `changes` into the file record under a compare-and-swap. The fields
     * that track the upload's progress (`bytesWritten`, `size`, `status`, …)
     * belong to this provider and are ignored.
     */
    public override async update({ id }: FileQuery, changes: Partial<File>): Promise<File> {
        return this.instrumentOperation("update", async () => {
            const { ttl, ...rest } = changes as Partial<File> & { ttl?: unknown };
            const next = await this.meta.swap(id, (state) => {
                let file: Record<string, unknown> = { ...state.file };

                for (const [key, value] of Object.entries(rest)) {
                    if (!PROVIDER_OWNED_FIELDS.has(key)) {
                        const current = file[key];

                        file = { ...file, [key]: isPlainObject(value) && isPlainObject(current) ? deepMerge(current, value) : value };
                    }
                }

                if (typeof ttl === "number" && Number.isFinite(ttl)) {
                    file = { ...file, expiredAt: Date.now() + ttl };
                }

                return { ...state, file: file as FileRecord };
            });

            const result: FileRecord = { ...next.file, status: "updated" };

            await this.onUpdate(result);

            return result;
        });
    }

    public override async list(): Promise<File[]> {
        return this.instrumentOperation("list", async () => {
            const { prefix, suffix } = this.meta;
            const objects = await this.listObjects(prefix);

            return objects
                .filter((object) => object.key.endsWith(suffix) && !object.key.slice(prefix.length).includes("/"))
                .map((object) => {
                    const file: FileRecord = new File({ id: this.meta.getIdFromMetaName(object.key), metadata: {} });

                    file.createdAt = object.uploaded.toISOString();
                    file.modifiedAt = file.createdAt;

                    return file;
                });
        });
    }

    /** Not supported: this provider stores uploads. Copy stored objects with `ctx.storage`. */
    public copy(): Promise<File> {
        return this.unsupported("copy");
    }

    /** Not supported: this provider stores uploads. Move stored objects with `ctx.storage`. */
    public move(): Promise<File> {
        return this.unsupported("move");
    }

    private unsupported(operation: string): Promise<never> {
        return Promise.reject(new UploadError(ERRORS.METHOD_NOT_ALLOWED, `${this.constructor.name} does not implement ${operation}()`));
    }

    /** Refuse a chunk at the wrong offset (`409`), with a checksum, or past the declared length (`413`). */
    // eslint-disable-next-line class-methods-use-this -- a step of write(), kept beside it
    private checkPart(file: FileRecord, part: FilePart): void {
        if (part.start !== file.bytesWritten) {
            conflict(`Upload-Offset ${String(part.start)} does not match the upload's offset ${String(file.bytesWritten)}`);
        }

        if (part.checksumAlgorithm !== undefined && part.checksumAlgorithm !== "") {
            throwErrorCode(ERRORS.UNSUPPORTED_CHECKSUM_ALGORITHM);
        }

        if (file.size !== undefined && part.contentLength !== undefined && part.start + part.contentLength > file.size) {
            throwErrorCode(ERRORS.REQUEST_ENTITY_TOO_LARGE, "The chunk runs past the declared upload length");
        }
    }

    /** Take the upload's lease with a conditional write. A live lease, or losing the race for it, is a `409`. */
    private async acquireLease(id: string, stored: StoredState): Promise<string> {
        const { lock } = stored.state.upload;

        if (lock !== undefined && lock.expiresAt > Date.now()) {
            return conflict("Another request is writing to this upload");
        }

        const token = crypto.randomUUID();
        const upload: UploadProgress = { ...stored.state.upload, lock: { expiresAt: Date.now() + LEASE_MS, token } };
        const etag = await this.meta.write(id, { ...stored.state, upload }, stored.etag);

        if (etag === undefined) {
            return conflict("Another request is writing to this upload");
        }

        return token;
    }

    /**
     * Change the upload's state while holding the lease `token`. Retries past
     * an unrelated write (a metadata `update()`); a missing token means the
     * lease was lost, and nothing is written.
     */
    private async changeLeased(id: string, token: string, change: (state: UploadState) => UploadState): Promise<UploadState> {
        return this.meta.swap(id, (state) => {
            if (state.upload.lock?.token !== token) {
                return conflict("This request's lease on the upload expired; resume from the current offset");
            }

            return change(state);
        });
    }

    private async releaseLease(id: string, token: string): Promise<void> {
        await this.changeLeased(id, token, (state) => {
            const upload = { ...state.upload };

            delete upload.lock;

            return { ...state, upload };
        });
    }

    private async renewLease(id: string, token: string): Promise<void> {
        await this.changeLeased(id, token, (state) => {
            return { ...state, upload: { ...state.upload, lock: { expiresAt: Date.now() + LEASE_MS, token } } };
        });
    }

    private async listObjects(prefix: string): Promise<{ key: string; uploaded: Date }[]> {
        const objects: { key: string; uploaded: Date }[] = [];
        let cursor: string | undefined;

        do {
            // eslint-disable-next-line no-await-in-loop -- R2 lists one page at a time
            const page = await this.bucket.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });

            objects.push(...page.objects);
            cursor = page.truncated ? page.cursor : undefined;
        } while (cursor !== undefined);

        return objects;
    }

    /** Delete every segment of an upload. Listed to the end first, so deleting cannot shift the listing. */
    private async deleteSegments(id: string): Promise<void> {
        const objects = await this.listObjects(this.meta.segmentPrefix(id));
        const keys = objects.map((object) => object.key);

        // R2 deletes at most 1000 keys per call.
        for (let index = 0; index < keys.length; index += 1000) {
            // eslint-disable-next-line no-await-in-loop -- one bulk delete per batch
            await this.bucket.delete(keys.slice(index, index + 1000));
        }
    }

    /**
     * Read `body` into `writer`, renewing the lease as it goes. Answers the
     * error that cut the body short (the client went away, a part failed), or
     * `undefined` when it ended cleanly. A body running past the declared length
     * throws.
     */
    private async pump(writer: R2UploadPartWriter, body: unknown, limit: number, id: string, token: string): Promise<unknown> {
        let received = 0;
        let renewedAt = Date.now();

        try {
            for await (const chunk of readBody(body)) {
                received += chunk.byteLength;

                if (received > limit) {
                    return throwErrorCode(ERRORS.REQUEST_ENTITY_TOO_LARGE, "The chunk runs past the declared upload length");
                }

                await writer.push(chunk);

                if (Date.now() - renewedAt >= LEASE_MS / 3) {
                    renewedAt = Date.now();
                    await this.renewLease(id, token);
                }
            }

            return undefined;
        } catch (error) {
            if (isUploadError(error) && error.UploadErrorCode === ERRORS.REQUEST_ENTITY_TOO_LARGE) {
                throw error;
            }

            return error;
        }
    }

    /** Stream `body` into parts and segments while holding the lease, then record the new offset. */
    private async writeLeased(file: FileRecord, progress: UploadProgress, body: unknown, token: string): Promise<File> {
        const writer = new R2UploadPartWriter(this.bucket, file, progress, this.meta.segmentPrefix(file.id));
        const limit = file.size === undefined ? Number.POSITIVE_INFINITY : file.size - file.bytesWritten;
        // TUS keeps what arrived before the body was cut short, so those bytes
        // are committed below and the client resumes from there.
        const interrupted = await this.pump(writer, body, limit, file.id, token);
        // With a declared size, the last byte arriving finishes the upload even
        // if the stream failed afterwards; without one, only a clean end does.
        const completed = file.size === undefined ? interrupted === undefined : writer.offset === file.size;
        const size = writer.offset;
        let etag: string | undefined;

        if (completed) {
            etag = await writer.finish();
        } else {
            // Best effort after an interruption: if this fails, the offset just
            // stops at what the parts and earlier segments already hold.
            await writer.keepTail(token).catch((error: unknown) => {
                if (interrupted === undefined) {
                    throw error;
                }
            });
        }

        const next: FileRecord = {
            ...file,
            bytesWritten: completed ? size : writer.stored,
            modifiedAt: new Date().toISOString(),
            status: completed ? "completed" : "part",
            ...(completed && file.size === undefined ? { size } : {}),
            ...(etag === undefined ? {} : { ETag: etag }),
        };

        await this.changeLeased(file.id, token, (state) => {
            const upload: UploadProgress = completed
                ? { parts: [], segments: [] }
                : { parts: writer.parts, segments: writer.segments, ...(writer.uploadId === undefined ? {} : { uploadId: writer.uploadId }) };

            return {
                file: { ...state.file, bytesWritten: next.bytesWritten, ETag: next.ETag, modifiedAt: next.modifiedAt, size: next.size, status: next.status },
                upload,
            };
        });

        // Only now that the stored state no longer lists them.
        await (completed ? this.deleteSegments(file.id) : this.bucket.delete(writer.consumed)).catch(() => undefined);

        if (interrupted !== undefined) {
            throw toError(interrupted);
        }

        return next;
    }
}

/**
 * Build a resumable-upload provider for `createUploadHandler` over a Worker's
 * R2 binding: no S3 credentials, and the same behaviour under `wrangler dev` /
 * miniflare as in production.
 *
 * Speaks TUS (without the `checksum`, `concatenation` and
 * `creation-defer-length` extensions), chunked REST with chunks sent in order
 * (as `@visulima/storage-client` sends them; a chunk at any other offset is a
 * `409`), and multipart forms.
 */
const createR2BindingUploadStorage = (bucket: R2UploadBucket, options: R2BindingUploadStorageOptions = {}): UploadStorage =>
    new R2BindingUploadStorage(bucket, options);

export { R2_PART_SIZE } from "./r2-upload-part-writer";
export type { R2BindingUploadStorageOptions };
export { createR2BindingUploadStorage };

export type { R2UploadBucket, R2UploadBucketMultipartUpload, R2UploadBucketObject, R2UploadBucketObjectBody } from "./r2-upload-types";
