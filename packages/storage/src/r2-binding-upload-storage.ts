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
 * writes (`onlyIf`), which is all a compare-and-swap needs, so the state does
 * not need a Durable Object or a new binding.
 *
 * # Part buffering
 *
 * R2 rejects a multipart upload unless every part but the last is at least
 * 5 MiB **and all of them are the same size**. Clients send whatever chunk size
 * they like (TUS defaults to 1 MiB), so chunks are coalesced into parts of
 * exactly `R2_PART_SIZE` bytes: part `n` always holds bytes
 * `[(n - 1) * R2_PART_SIZE, n * R2_PART_SIZE)` of the file. Whatever a request
 * leaves over (less than one part) is written to a small "segment" object and
 * recorded in the state; the request that completes the next part reads the
 * segments back into it. A request holds at most about two parts in memory,
 * however large its body. A file smaller than one part never starts a
 * multipart upload: its bytes are written with a single `put` when the last
 * one arrives.
 *
 * # Concurrent requests
 *
 * A write first checks the client's offset against the stored one (a mismatch
 * is a `409`, as TUS requires), then takes a lease on the upload by writing a
 * lock token into the state with a conditional put. Another request for the
 * same upload while the lease is held gets a `409` and writes nothing. Before
 * every part is stored, and before the object is made, the writer confirms the
 * lease with a compare-and-swap; after every part it records its progress the
 * same way. A writer that finds its token gone (its lease expired and another
 * request took over) stops with a `409` instead of writing on.
 */
import { Readable } from "node:stream";

import type { R2ObjectBodyLike } from "@lunora/platform";
import type { BaseStorageOptions, FileInit, FilePart, FileQuery } from "@visulima/storage";
import { AbstractBaseStorage, ERRORS, File, throwErrorCode, UploadError } from "@visulima/storage";

import { readBody } from "./byte-queue";
import { R2UploadPartWriter } from "./r2-upload-part-writer";
import { PROVIDER_OWNED_FIELDS, R2UploadStateStore } from "./r2-upload-state-store";
import type { FileRecord, R2UploadBucket, UploadLock, UploadProgress, UploadState } from "./r2-upload-types";
import type { UploadStorage } from "./upload-handler";

/** What `get()` answers; `@visulima/storage` does not export the type by name. */
type FileReturn = Awaited<ReturnType<AbstractBaseStorage["get"]>>;

/** Options for {@link createR2BindingUploadStorage}. */
interface R2BindingUploadStorageOptions extends Omit<BaseStorageOptions, "metaStorage"> {
    /**
     * Key prefix the upload state objects and buffered segments are stored
     * under, in the same bucket. Default `"_lunora/uploads/"`. No uploaded
     * object may be named under it.
     *
     * The state of a finished upload stays (a few hundred bytes, so a `HEAD`
     * can still answer that the upload is complete), and so does the state of
     * one that was abandoned. Both accumulate: add an R2 object lifecycle rule
     * that deletes objects under this prefix after a few days, longer than
     * any upload you expect to take.
     */
    statePrefix?: string;
}

const DEFAULT_STATE_PREFIX = "_lunora/uploads/";

/** How long a write's lease on an upload lasts without being renewed. */
const LEASE_MS = 60_000;

/** TUS extensions this provider cannot honor. Advertising them would let a client start an upload it cannot finish. */
const UNSUPPORTED_TUS_EXTENSIONS = new Set(["checksum", "concatenation", "creation-defer-length"]);

/** Fields `update()` takes from no caller: the provider's own, and `expiredAt` (set it through `ttl`). */
const UPDATE_IGNORED_FIELDS = new Set<string>([...PROVIDER_OWNED_FIELDS, "expiredAt"]);

const conflict = (message: string): never => throwErrorCode(ERRORS.FILE_CONFLICT, message);

const isLeaseLive = (lock: UploadLock | undefined): lock is UploadLock => lock !== undefined && lock.expiresAt > Date.now();

/**
 * The largest finished upload `get()` reads into memory. Above it `get()` is a
 * `413`: a Worker isolate has 128 MB, and uploads may be far larger.
 */
const MAX_BUFFERED_GET_BYTES: number = 32 * 1024 * 1024;

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

    /**
     * Start an upload. Its size has to be declared, as a non-negative integer:
     * every byte limit hangs off it, and `creation-defer-length` is not offered.
     */
    public async create(fileInit: FileInit): Promise<File> {
        return this.instrumentOperation("create", async () => {
            const size = fileInit.size === undefined || fileInit.size === "" ? Number.NaN : Number(fileInit.size);

            if (!Number.isSafeInteger(size) || size < 0) {
                return throwErrorCode(ERRORS.INVALID_FILE_SIZE, "An upload must declare its size as a non-negative integer");
            }

            const file: FileRecord = new File(fileInit);

            // `File` reads a declared size of 0 as "no size".
            file.size = size;
            file.name = this.namingFunction(file);
            AbstractBaseStorage.assertSafeId(file.id);

            if (file.name.includes(this.meta.prefix)) {
                return throwErrorCode(ERRORS.INVALID_FILE_NAME, "An upload cannot be stored under the upload state prefix");
            }

            await this.validate(file);

            // Same id, same upload: a client re-sending its create resumes it,
            // as the S3 providers do.
            const existing = await this.meta.read(file.id);

            if (existing !== undefined) {
                return existing.state.file;
            }

            file.bytesWritten = 0;
            file.status = "created";
            this.updateTimestamps(file);

            // A zero-byte upload never receives a write, so it is finished here.
            if (size === 0) {
                await this.bucket.put(file.name, new Uint8Array(0), { httpMetadata: { contentType: file.contentType } });
                file.status = "completed";
            }

            // Create-only, so of two racing creates for one id, one writes the
            // state and the other answers what it wrote.
            if (!(await this.meta.create(file.id, { file, upload: { parts: [], segments: [] } }))) {
                const raced = await this.meta.read(file.id);

                return raced?.state.file ?? conflict("The upload is being created by another request");
            }

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

            const token = await this.acquireLease(file.id, stored.state, stored.etag);

            try {
                return await this.writeLeased(file, stored.state.upload, part.body, token);
            } catch (error) {
                await this.releaseLease(file.id, token).catch(() => undefined);

                throw error;
            }
        });
    }

    /**
     * A finished upload's bytes, buffered: refused (`413`) above
     * {@link MAX_BUFFERED_GET_BYTES}, before any byte is read. None of the
     * upload handlers reach this; it is here for code that holds the provider.
     * Stream with {@link R2BindingUploadStorage.getStream}, or serve large
     * files with `ctx.storage.download()` or a signed URL.
     */
    public async get({ id }: FileQuery): Promise<FileReturn> {
        return this.instrumentOperation("get", async () => {
            const { file, object } = await this.completedObject(id);

            if (object.size > MAX_BUFFERED_GET_BYTES) {
                await object.body?.cancel();

                return throwErrorCode(
                    ERRORS.REQUEST_ENTITY_TOO_LARGE,
                    `get() buffers the whole file and refuses one over ${String(MAX_BUFFERED_GET_BYTES)} bytes; use getStream(), ctx.storage.download() or a signed URL`,
                );
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

    /** A finished upload's bytes as a stream straight from R2: nothing is buffered, whatever the size. */
    public override async getStream({ id }: FileQuery): Promise<{ headers?: Record<string, string>; size?: number; stream: Readable }> {
        return this.instrumentOperation("getStream", async () => {
            const { file, object } = await this.completedObject(id);
            // Read through the body's own reader, so nothing is buffered.
            const stream = Readable.from(readBody(object.body));

            return {
                headers: { "Content-Length": String(object.size), "Content-Type": file.contentType, ETag: object.etag },
                size: object.size,
                stream,
            };
        });
    }

    /**
     * Forget an upload. One still in progress is aborted, with its parts and
     * segments, under the lease (a `409` while a request is writing to it).
     * For a finished upload only the state goes: the stored object is a file
     * now, and removing it is `ctx.storage.delete`. That also keeps
     * `expiration`, whose sweep deletes through here, from deleting files.
     */
    public async delete({ id }: FileQuery): Promise<File> {
        return this.instrumentOperation("delete", async () => {
            const stored = await this.meta.read(id);

            if (stored === undefined) {
                return throwErrorCode(ERRORS.FILE_NOT_FOUND);
            }

            const { file, upload } = stored.state;

            if (file.status !== "completed") {
                await this.acquireLease(id, stored.state, stored.etag);

                if (upload.uploadId !== undefined) {
                    await this.bucket
                        .resumeMultipartUpload(file.name, upload.uploadId)
                        .abort()
                        .catch(() => undefined);
                }

                await this.deleteSegments(id);
            }

            await this.deleteMeta(id);

            const deleted: FileRecord = { ...file, status: "deleted" };

            await this.onDelete(deleted);

            return deleted;
        });
    }

    /**
     * The base class's update (its merge, its `ttl` parsing, its `originalName`
     * re-derivation), minus the fields that track the upload's progress; the
     * state store lays the result over the stored record under a
     * compare-and-swap.
     */
    public override async update(query: FileQuery, changes: Partial<File>): Promise<File> {
        const allowed = Object.fromEntries(Object.entries(changes).filter(([key]) => !UPDATE_IGNORED_FIELDS.has(key))) as Partial<File>;

        return super.update(query, allowed);
    }

    /** The uploads with state in the bucket. Segment keys sit one level down and are rolled up by the delimiter, never read. */
    public override async list(): Promise<File[]> {
        return this.instrumentOperation("list", async () => {
            const { prefix, suffix } = this.meta;
            const files: File[] = [];
            let cursor: string | undefined;

            do {
                // eslint-disable-next-line no-await-in-loop -- R2 lists one page at a time
                const page = await this.bucket.list({ delimiter: "/", prefix, ...(cursor === undefined ? {} : { cursor }) });

                for (const object of page.objects) {
                    if (object.key.endsWith(suffix)) {
                        const file: FileRecord = new File({ id: this.meta.getIdFromMetaName(object.key), metadata: {} });

                        file.createdAt = (object.uploaded ?? new Date()).toISOString();
                        file.modifiedAt = file.createdAt;
                        files.push(file);
                    }
                }

                cursor = page.truncated === true ? page.cursor : undefined;
            } while (cursor !== undefined);

            return files;
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

    /** A finished upload's record and its stored object; `404` for anything else. */
    private async completedObject(id: string): Promise<{ file: File; object: R2ObjectBodyLike }> {
        const file = await this.checkIfExpired(await this.getMeta(id));
        const object = file.status === "completed" ? await this.bucket.get(file.name) : undefined;

        if (object === undefined || object === null) {
            return throwErrorCode(ERRORS.FILE_NOT_FOUND);
        }

        return { file, object };
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

        if (part.contentLength !== undefined && part.start + part.contentLength > (file.size ?? 0)) {
            throwErrorCode(ERRORS.REQUEST_ENTITY_TOO_LARGE, "The chunk runs past the declared upload length");
        }
    }

    /** Take the upload's lease with a conditional write. A live lease, or losing the race for it, is a `409`. */
    private async acquireLease(id: string, state: UploadState, etag: string): Promise<string> {
        if (isLeaseLive(state.upload.lock)) {
            return conflict("Another request is writing to this upload");
        }

        const token = crypto.randomUUID();
        const upload: UploadProgress = { ...state.upload, lock: { expiresAt: Date.now() + LEASE_MS, token } };

        if ((await this.meta.write(id, { ...state, upload }, etag)) === undefined) {
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

    /** Confirm the lease is still this request's, and extend it. */
    private async renewLease(id: string, token: string): Promise<void> {
        await this.changeLeased(id, token, (state) => {
            return { ...state, upload: { ...state.upload, lock: { expiresAt: Date.now() + LEASE_MS, token } } };
        });
    }

    private async deleteSegments(id: string): Promise<void> {
        const keys: string[] = [];
        let cursor: string | undefined;

        // Listed to the end first, so deleting cannot shift the listing.
        do {
            // eslint-disable-next-line no-await-in-loop -- R2 lists one page at a time
            const page = await this.bucket.list({ prefix: this.meta.segmentPrefix(id), ...(cursor === undefined ? {} : { cursor }) });

            keys.push(...page.objects.map((object) => object.key));
            cursor = page.truncated === true ? page.cursor : undefined;
        } while (cursor !== undefined);

        // R2 deletes at most 1000 keys per call.
        for (let index = 0; index < keys.length; index += 1000) {
            // eslint-disable-next-line no-await-in-loop -- one bulk delete per batch
            await this.bucket.delete(keys.slice(index, index + 1000));
        }
    }

    /**
     * Read `body` into `writer`, renewing the lease as it goes. Answers the
     * error that cut the body short (the client went away), or `undefined` when
     * it ended cleanly. A lost lease or a body past the declared length throws.
     */
    private async pump(writer: R2UploadPartWriter, body: unknown, limit: number, id: string, token: string): Promise<Error | undefined> {
        const chunks = readBody(body);
        let received = 0;
        let renewedAt = Date.now();

        try {
            for (;;) {
                let next: IteratorResult<Uint8Array>;

                // Only a failure READING the body is the client going away. A
                // failure storing it (an R2 call, the lease) is thrown on, so
                // write() releases the lease and the state stays at the last
                // part it recorded, rather than half a part being kept as a
                // segment.
                try {
                    // eslint-disable-next-line no-await-in-loop -- a body is read one chunk at a time
                    next = await chunks.next();
                } catch (error) {
                    return error instanceof Error ? error : new Error(String(error));
                }

                if (next.done === true) {
                    return undefined;
                }

                received += next.value.byteLength;

                if (received > limit) {
                    return throwErrorCode(ERRORS.REQUEST_ENTITY_TOO_LARGE, "The chunk runs past the declared upload length");
                }

                if (Date.now() - renewedAt >= LEASE_MS / 3) {
                    renewedAt = Date.now();
                    // eslint-disable-next-line no-await-in-loop -- the lease is renewed between chunks
                    await this.renewLease(id, token);
                }

                // eslint-disable-next-line no-await-in-loop -- chunks are stored in order
                await writer.push(next.value);
            }
        } finally {
            // Releases the body's reader when storing failed mid-stream.
            await chunks.return(undefined).catch(() => undefined);
        }
    }

    /** Stream `body` into parts and segments while holding the lease, then record the new offset. */
    private async writeLeased(file: FileRecord, progress: UploadProgress, body: unknown, token: string): Promise<File> {
        const size = file.size ?? 0;
        const writer = new R2UploadPartWriter(this.bucket, file, progress, this.meta.segmentPrefix(file.id), {
            confirm: async () => this.renewLease(file.id, token),
            save: async (saved, stored) => {
                await this.changeLeased(file.id, token, (state) => {
                    return { file: { ...state.file, bytesWritten: stored, status: "part" }, upload: { ...saved, lock: state.upload.lock } };
                });
            },
            token,
        });
        // TUS keeps what arrived before the body was cut short, so those bytes
        // are committed below and the client resumes from there.
        const interrupted = await this.pump(writer, body, size - file.bytesWritten, file.id, token);
        // The last byte arriving finishes the upload, even if the stream failed afterwards.
        const completed = writer.offset === size;
        const etag = completed ? await writer.finish() : undefined;

        if (!completed) {
            try {
                await writer.keepTail();
            } catch (error) {
                // After an interruption this is best effort: the offset then
                // stops at what the parts and earlier segments already hold.
                if (interrupted === undefined) {
                    throw error;
                }
            }
        }

        const record: Partial<FileRecord> = {
            bytesWritten: completed ? size : writer.stored,
            modifiedAt: new Date().toISOString(),
            status: completed ? "completed" : "part",
            ...(etag === undefined ? {} : { ETag: etag }),
        };
        const upload: UploadProgress = completed ? { parts: [], segments: [] } : writer.progress();

        await this.changeLeased(file.id, token, (state) => {
            return { file: { ...state.file, ...record }, upload };
        });

        await (completed ? this.deleteSegments(file.id).catch(() => undefined) : writer.dropConsumed());

        if (interrupted !== undefined) {
            throw interrupted;
        }

        return { ...file, ...record };
    }
}

/**
 * Build a resumable-upload provider for `createUploadHandler` over a Worker's
 * R2 binding: no S3 credentials, and the same behaviour under `wrangler dev` /
 * miniflare as in production.
 *
 * Speaks TUS (without the `checksum`, `concatenation` and
 * `creation-defer-length` extensions), chunked REST with chunks sent in order
 * (a chunk at any other offset is a `409`), and multipart forms.
 *
 * Chunked REST is broken upstream, see visulima/visulima#884 and the
 * `@lunora/storage` docs ("Chunked REST is broken upstream").
 */
const createR2BindingUploadStorage = (bucket: R2UploadBucket, options: R2BindingUploadStorageOptions = {}): UploadStorage =>
    new R2BindingUploadStorage(bucket, options);

export { R2_PART_SIZE } from "./r2-upload-part-writer";
export type { R2UploadBucket } from "./r2-upload-types";
export type { R2BindingUploadStorageOptions };
export { createR2BindingUploadStorage };
