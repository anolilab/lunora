/**
 * `createNodeR2Bucket` — a Node implementation of the `R2BucketLike` structural
 * contract (`@lunora/platform`) over the local filesystem, so `@lunora/storage`'s
 * `createStorage({ bucket })` runs on the Node host.
 *
 * # The invariant
 *
 * **An object is exactly one file carrying a valid trailer. There is no partial
 * state and no fallback.** `directory/key` holds
 *
 * ```
 * <body bytes> <trailer JSON> <uint32be trailer length> "LNR1"
 * ```
 *
 * so the single `rename` that publishes the bytes publishes their checksum,
 * size and content-type with them, and `readTrailerFrom` is a total predicate:
 * anything that is not a well-formed object reads back as absent, never as an
 * object with guessed metadata. `head` reads the trailer only (two small
 * positioned reads); `get` holds that one handle and streams the requested
 * range through it, so neither reopens the path and neither materialises the
 * object. (The sidecar layout this replaced, and why, is in `plans/234`.)
 *
 * Because `get` holds a descriptor, the object it returns is **read once** and
 * reading closes it — `arrayBuffer()`, `text()` and draining or cancelling
 * `body` all release, and a second read raises rather than silently reopening
 * the path. R2's own body is single-use for the same reason. The one case that
 * retains a descriptor is a `get` whose result is never touched at all; use
 * `head` when only metadata is wanted.
 *
 * # Key grammar, and where it stops being injective
 *
 * `.lunora-tmp` is reserved at every depth — it is the staging tree puts are
 * renamed out of. Keys are otherwise rejected unless every `/`-separated
 * segment is a plain name: no empty, `.` or `..` segments, no backslash (a
 * separator on Windows), no NUL or other control character, no leading `/`,
 * and no more than 1024 bytes — the same grammar `@lunora/storage` enforces.
 *
 * That confines every key to the bucket directory on every platform. It does
 * **not** make the mapping injective there: on a case-insensitive filesystem
 * (APFS by default, so most dev machines) `A` and `a` are one object, and on
 * Windows a trailing dot or space is stripped and `x:y` names an alternate
 * data stream. Real R2 treats all of those as distinct keys. Percent-encoding
 * each segment would fix it at the cost of an unreadable bucket directory;
 * for a local host the readable directory wins and the divergence is stated
 * here and in the capability note rather than papered over.
 *
 * Not emulated: multipart upload (`createMultipartUpload`/`resumeMultipartUpload`
 * are absent, so `@lunora/storage` throws its clear "binding does not support
 * multipart" error) and S3 presigned URLs (those need real R2 credentials anyway).
 */

import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { LunoraError } from "@lunora/errors";
import type { R2BucketLike, R2ObjectBodyLike, R2ObjectLike, R2RangeLike } from "@lunora/platform";

import { hasControlChar } from "../../../shared/hmac-url";
import { toArrayBuffer } from "./to-array-buffer";

/** Scratch tree for atomic put staging (rename-in is atomic on POSIX). */
const TMP_DIR = ".lunora-tmp";

/** Trailer sentinel — distinguishes a bucket object from an unrelated file dropped into the directory. */
const MAGIC = "LNR1";

/** `uint32be` trailer length + {@link MAGIC}. */
const FOOTER_SIZE = 8;

/** Matches `@lunora/storage`'s ceiling, so the two layers agree on what a key may be. */
const MAX_KEY_LENGTH = 1024;

/** Per-object metadata, persisted in the object file's trailer. */
interface NodeObjectMeta {
    customMetadata?: Record<string, string>;
    httpMetadata?: { contentType?: string };
    sha256Hex: string;
    size: number;
    uploaded: string;
}

/** Options for {@link createNodeR2Bucket}. */
interface NodeR2BucketOptions {
    /** The bucket directory — created on first write. Objects live here, one file per key. */
    directory: string;
}

/**
 * Reject keys that would leave the bucket directory or collide inside it. Every
 * segment must be a plain name: `a/./b` and `a//b` would otherwise resolve to
 * the same file as `a/b`, and `..\\outside` escapes the directory entirely on
 * Windows, where `\` is a separator `split("/")` cannot see. See the header for
 * the filesystem-folding cases this cannot reach.
 */
const validateKey = (key: string): void => {
    if (typeof key !== "string" || key.length === 0) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: R2 key must be a non-empty string");
    }

    // The same ceiling and control-character rule `@lunora/storage` applies, so a
    // key accepted on one target is accepted on the other. Divergent key grammar
    // per host is the thing the platform-parity convention exists to prevent —
    // and without the ceiling an over-long key surfaces as a raw `ENAMETOOLONG`.
    if (key.length > MAX_KEY_LENGTH) {
        throw new LunoraError("VALIDATION_ERROR", `@lunora/platform-node: R2 key exceeds ${String(MAX_KEY_LENGTH)}-byte limit`);
    }

    if (key.includes("\0")) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: R2 key contains a NUL byte");
    }

    // `hasControlChar` is the canonical detector in `shared/hmac-url.ts`, shared
    // with `@lunora/storage`'s `validateKey` rather than re-derived here.
    if (hasControlChar(key)) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: R2 key contains a control character (including CR/LF)");
    }

    if (key.includes("\\")) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: R2 key contains a backslash (a path separator on Windows)");
    }

    if (key.startsWith("/")) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: R2 key must not start with `/`");
    }

    for (const segment of key.split("/")) {
        if (segment === "" || segment === "." || segment === "..") {
            throw new LunoraError("VALIDATION_ERROR", `@lunora/platform-node: R2 key has an empty, \`.\` or \`..\` path segment ("${key}")`);
        }

        // Reserved at every depth, not just the first: `walkObjects` skips the
        // staging tree wherever it appears, so a key like `a/.lunora-tmp/b` would
        // otherwise be writable and readable but invisible to `list()` — and
        // anything that reconciles through `list` would quietly lose it.
        if (segment === TMP_DIR) {
            throw new LunoraError("VALIDATION_ERROR", `@lunora/platform-node: R2 key is reserved (no segment may be "${TMP_DIR}")`);
        }
    }
};

/** True when an `fs/promises` error is a missing path. */
const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Name the one filesystem limitation the key grammar cannot rule out: a key and
 * a prefix of it cannot both be objects, because one has to be a directory to
 * hold the other. `a/b` then `a`, or the reverse, are both legal in R2 and
 * neither is representable here — which is worth saying rather than letting
 * `EISDIR`/`EEXIST`/`ENOTDIR` out of an `fs` call the caller never made.
 */
const asKeyCollision = (key: string, error: unknown): unknown => {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;

    if (code === "EEXIST" || code === "EISDIR" || code === "ENOTDIR") {
        return new LunoraError(
            "VALIDATION_ERROR",
            `@lunora/platform-node: R2 key "${key}" collides with an existing object at one of its path prefixes — this host stores one file per key, so a key and a prefix of it cannot both hold objects`,
        );
    }

    return error;
};

/** Serialize a trailer: the metadata JSON, its length, and the sentinel. */
const encodeTrailer = (meta: NodeObjectMeta): Buffer => {
    const json = Buffer.from(JSON.stringify(meta), "utf8");
    const footer = Buffer.alloc(FOOTER_SIZE);

    footer.writeUInt32BE(json.byteLength, 0);
    footer.write(MAGIC, 4, "ascii");

    return Buffer.concat([json, footer]);
};

/** True when a parsed trailer carries the fields every projection reads. */
const isObjectMeta = (value: unknown): value is NodeObjectMeta => {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const candidate = value as Partial<NodeObjectMeta>;

    return typeof candidate.sha256Hex === "string" && typeof candidate.size === "number" && typeof candidate.uploaded === "string";
};

/**
 * Read an object's trailer through an already-open handle, or `undefined` when
 * the file is not one of ours.
 *
 * Every rejection is the same answer — "no object here" — including a trailer
 * that carries the magic but whose JSON is corrupt or the wrong shape. Letting
 * that one throw instead would make a single damaged file take down `list()`
 * for the whole bucket, and `get`/`head` would report it as an error rather
 * than the absence it is indistinguishable from.
 */
const readTrailerFrom = async (handle: FileHandle): Promise<{ bodySize: number; meta: NodeObjectMeta } | undefined> => {
    const stats = await handle.stat();

    if (!stats.isFile() || stats.size < FOOTER_SIZE) {
        return undefined;
    }

    const footer = Buffer.alloc(FOOTER_SIZE);

    await handle.read(footer, 0, FOOTER_SIZE, stats.size - FOOTER_SIZE);

    if (footer.toString("ascii", 4, FOOTER_SIZE) !== MAGIC) {
        return undefined;
    }

    const trailerLength = footer.readUInt32BE(0);
    const bodySize = stats.size - FOOTER_SIZE - trailerLength;

    if (trailerLength === 0 || bodySize < 0) {
        return undefined;
    }

    const trailer = Buffer.alloc(trailerLength);
    const { bytesRead } = await handle.read(trailer, 0, trailerLength, bodySize);

    if (bytesRead !== trailerLength) {
        return undefined;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(trailer.toString("utf8"));
    } catch {
        return undefined;
    }

    return isObjectMeta(parsed) ? { bodySize, meta: parsed } : undefined;
};

/** Open an object file for reading, or `undefined` when the key holds no object. The handle is the caller's to close. */
const openObject = async (filePath: string): Promise<{ bodySize: number; handle: FileHandle; meta: NodeObjectMeta } | undefined> => {
    let handle: FileHandle;

    try {
        handle = await open(filePath, "r");
    } catch (error: unknown) {
        if (isMissing(error)) {
            return undefined;
        }

        throw error;
    }

    try {
        const stored = await readTrailerFrom(handle);

        if (stored === undefined) {
            await handle.close();

            return undefined;
        }

        return { ...stored, handle };
    } catch (error: unknown) {
        await handle.close();

        throw error;
    }
};

/** Metadata-only read: opens, reads the trailer, closes. */
const readTrailer = async (filePath: string): Promise<{ bodySize: number; meta: NodeObjectMeta } | undefined> => {
    const opened = await openObject(filePath);

    if (opened === undefined) {
        return undefined;
    }

    await opened.handle.close();

    return { bodySize: opened.bodySize, meta: opened.meta };
};

/** Build the body-free {@link R2ObjectLike} projection for a key from its trailer. */
const toObject = (key: string, meta: NodeObjectMeta): R2ObjectLike => {
    const { sha256Hex } = meta;
    // One decode feeds both encodings the contract derives from `checksums`.
    const digest = Buffer.from(sha256Hex, "hex");

    return {
        checksums: { sha256: toArrayBuffer(digest) },
        customMetadata: meta.customMetadata,
        etag: sha256Hex,
        httpEtag: `"${sha256Hex}"`,
        httpMetadata: meta.httpMetadata,
        key,
        sha256: sha256Hex,
        sha256Base64: digest.toString("base64"),
        size: meta.size,
        uploaded: new Date(meta.uploaded),
    };
};

/** Clamp a caller-supplied byte count into `[0, limit]`, treating a non-finite one as absent. */
const clamp = (value: number | undefined, fallback: number, limit: number): number => {
    if (value === undefined || !Number.isFinite(value)) {
        return fallback;
    }

    return Math.min(Math.max(0, Math.floor(value)), limit);
};

/** Resolve an {@link R2RangeLike} into absolute `[start, end)` body offsets. */
const resolveRange = (bodySize: number, range?: R2RangeLike): { end: number; start: number } => {
    if (range === undefined) {
        return { end: bodySize, start: 0 };
    }

    // Every arm clamps, so a `NaN` offset/length cannot reach `Buffer.alloc` and
    // surface as a raw `ERR_OUT_OF_RANGE` from somewhere the caller can't place.
    if ("suffix" in range) {
        return { end: bodySize, start: bodySize - clamp(range.suffix, bodySize, bodySize) };
    }

    const start = clamp(range.offset, 0, bodySize);
    const end = range.length === undefined || !Number.isFinite(range.length) ? bodySize : Math.min(start + clamp(range.length, 0, bodySize), bodySize);

    return { end, start };
};

/**
 * Stream one window of an open object file as a web `ReadableStream`, closing
 * the handle when the stream ends, errors, or is cancelled.
 *
 * Written over the file stream's async iterator rather than `Readable.toWeb`,
 * which Node still marks experimental below 22.17 while this package supports
 * ^22.15.
 */
const streamSlice = (handle: FileHandle, start: number, end: number, release: () => Promise<void>): ReadableStream => {
    const source: AsyncIterator<Buffer> = handle.createReadStream({ autoClose: false, end: end - 1, start })[Symbol.asyncIterator]();

    return new ReadableStream({
        cancel: async () => {
            await source.return?.();
            await release();
        },
        pull: async (controller) => {
            let result;

            try {
                result = await source.next();
            } catch (error: unknown) {
                await release();

                throw error;
            }

            if (result.done === true) {
                controller.close();
                await release();
            } else {
                controller.enqueue(result.value);
            }
        },
    });
};

/** Read one window of an open object file. Only the requested bytes are ever in memory. */
const readSlice = async (handle: FileHandle, start: number, end: number): Promise<Buffer> => {
    const length = end - start;

    if (length <= 0) {
        return Buffer.alloc(0);
    }

    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);

    return buffer.subarray(0, bytesRead);
};

/** Yield every supported R2 put body as byte chunks, without collecting them. */
const toChunks = async function* (body: ReadableStream | ArrayBuffer | ArrayBufferView | Blob | string | null | undefined): AsyncGenerator<Uint8Array> {
    if (body === null || body === undefined) {
        return;
    }

    if (typeof body === "string") {
        yield new TextEncoder().encode(body);

        return;
    }

    if (body instanceof ArrayBuffer) {
        yield new Uint8Array(body);

        return;
    }

    if (ArrayBuffer.isView(body)) {
        yield new Uint8Array(body.buffer, body.byteOffset, body.byteLength);

        return;
    }

    if (body instanceof Blob) {
        yield* toChunks(body.stream());

        return;
    }

    if (body instanceof ReadableStream) {
        for await (const chunk of body) {
            if (chunk instanceof Uint8Array) {
                yield chunk;
            } else if (chunk instanceof ArrayBuffer) {
                yield new Uint8Array(chunk);
            } else {
                throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: R2 put stream must yield byte chunks");
            }
        }

        return;
    }

    throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: unsupported R2 put body");
};

/** Recursively collect object keys under the bucket directory, skipping the staging tree. */
const walkObjects = async (directory: string): Promise<string[]> => {
    const keys: string[] = [];

    const walk = async (currentPath: string, relative: string): Promise<void> => {
        let entries;

        try {
            entries = await readdir(currentPath, { withFileTypes: true });
        } catch (error: unknown) {
            if (isMissing(error)) {
                return;
            }

            throw error;
        }

        const promises: Promise<void>[] = [];

        for (const entry of entries) {
            if (entry.name === TMP_DIR) {
                continue;
            }

            // Keys always join with `/`, never the platform separator — `sep` would
            // hand back `a\b` on Windows for a key stored as `a/b`.
            const relativePath = relative === "" ? entry.name : `${relative}/${entry.name}`;

            if (entry.isDirectory()) {
                promises.push(walk(join(currentPath, entry.name), relativePath));
            } else {
                keys.push(relativePath);
            }
        }

        await Promise.all(promises);
    };

    await walk(directory, "");
    // Codepoint order, matching the `<=` comparison `firstIndexGreaterThan` uses
    // to place the cursor. `localeCompare` would order them differently and the
    // binary search would land in the wrong place.
    keys.sort((a, b) => (a < b ? -1 : Number(a > b)));

    return keys;
};

/** Index of the first element strictly greater than `value` in a sorted array. */
const firstIndexGreaterThan = (values: ReadonlyArray<string>, value: string): number => {
    let low = 0;
    let high = values.length;

    while (low < high) {
        const mid = low + Math.floor((high - low) / 2);
        const candidate = values[mid];

        if (candidate === undefined || candidate <= value) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    return low;
};

const unlinkIfPresent = async (path: string): Promise<void> => {
    try {
        await unlink(path);
    } catch (error: unknown) {
        if (!isMissing(error)) {
            throw error;
        }
    }
};

/**
 * Create an `R2BucketLike` over the local filesystem. Any object shape
 * `createStorage({ bucket })` accepts — `put`/`get`/`head`/`delete`/`list` —
 * maps directly onto a file operation.
 */
const createNodeR2Bucket = (options: NodeR2BucketOptions): R2BucketLike => {
    const { directory } = options;

    return {
        delete: async (key: string): Promise<void> => {
            validateKey(key);

            await unlinkIfPresent(join(directory, key));
        },

        get: async (key: string, getOptions?: { range?: R2RangeLike }): Promise<R2ObjectBodyLike | null> => {
            validateKey(key);

            const opened = await openObject(join(directory, key));

            if (opened === undefined) {
                return null; // eslint-disable-line unicorn/no-null
            }

            // The body is read through the handle the trailer came from, never by
            // reopening the path. An overwrite between the two would otherwise
            // serve the *new* file's bytes — trailer included — under the old
            // one's size and checksum. On POSIX the `rename` that publishes a new
            // version swaps the directory entry while this handle keeps pointing
            // at the version whose metadata was returned.
            const { bodySize, handle, meta } = opened;
            const { end, start } = resolveRange(bodySize, getOptions?.range);

            let released = false;
            const release = async (): Promise<void> => {
                if (!released) {
                    released = true;
                    await handle.close();
                }
            };

            // Reading closes the handle, so an object is read once — matching R2,
            // whose `body` is a stream that cannot be consumed twice either.
            const claim = (): void => {
                if (released) {
                    throw new LunoraError("BAD_REQUEST", `@lunora/platform-node: R2 object "${key}" body has already been consumed`);
                }
            };

            const readWhole = async (): Promise<Buffer> => {
                claim();

                try {
                    return await readSlice(handle, start, end);
                } finally {
                    await release();
                }
            };

            return {
                ...toObject(key, meta),
                arrayBuffer: async (): Promise<ArrayBuffer> => toArrayBuffer(await readWhole()),
                // A getter, so a caller that only reads metadata or calls
                // `text()` never opens a stream — an eagerly-built one that
                // nobody drains holds the descriptor until the process exits.
                get body(): ReadableStream {
                    claim();

                    if (end <= start) {
                        // Nothing to stream, so release now — the returned empty
                        // stream has no end event to hang the close off.
                        release().catch(() => undefined);

                        return new Blob([]).stream();
                    }

                    return streamSlice(handle, start, end, release);
                },
                text: async (): Promise<string> => {
                    const whole = await readWhole();

                    return whole.toString("utf8");
                },
            };
        },

        head: async (key: string): Promise<R2ObjectLike | null> => {
            validateKey(key);

            const stored = await readTrailer(join(directory, key));

            return stored === undefined ? null : toObject(key, stored.meta); // eslint-disable-line unicorn/no-null
        },

        list: async (listOptions: { cursor?: string; delimiter?: string; limit?: number; prefix?: string } = {}) => {
            const limit = Math.max(1, clamp(listOptions.limit, 1000, 1000));

            if (listOptions.prefix?.includes("\0")) {
                throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: R2 list prefix contains a NUL byte");
            }

            const all = await walkObjects(directory);
            const prefix = listOptions.prefix ?? "";
            const filtered = all.filter(
                (key) => key.startsWith(prefix) && (listOptions.delimiter === undefined || !key.slice(prefix.length).includes(listOptions.delimiter)),
            );

            const startIndex = listOptions.cursor === undefined ? 0 : firstIndexGreaterThan(filtered, listOptions.cursor);
            const page = filtered.slice(startIndex, startIndex + limit);
            const truncated = startIndex + limit < filtered.length;
            // A key can vanish (or turn out to be an unrelated file) between the
            // walk and the trailer read; those drop out of the page rather than
            // failing the whole listing.
            const found = await Promise.all(
                page.map(async (key) => {
                    const stored = await readTrailer(join(directory, key));

                    return stored === undefined ? undefined : toObject(key, stored.meta);
                }),
            );
            const objects = found.filter((object) => object !== undefined);

            // The cursor is the last key *considered*, not the last object
            // *returned*. Those differ whenever an entry drops out above, and
            // taking it from `objects` then rewinds the next page over keys
            // already served — or, if the whole page dropped out, hands back
            // `undefined` while claiming `truncated`, which strands the caller.
            return { cursor: truncated ? page.at(-1) : undefined, objects, truncated };
        },

        put: async (
            key: string,
            body: ReadableStream | ArrayBuffer | Blob | string | null,
            putOptions?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } },
        ): Promise<R2ObjectLike> => {
            validateKey(key);

            const filePath = join(directory, key);
            const temporaryPath = join(directory, TMP_DIR, randomUUID());

            try {
                await mkdir(dirname(filePath), { recursive: true });
            } catch (error: unknown) {
                throw asKeyCollision(key, error);
            }

            await mkdir(dirname(temporaryPath), { recursive: true });

            const hash = createHash("sha256");
            let size = 0;
            let meta: NodeObjectMeta;

            try {
                const handle = await open(temporaryPath, "w");

                try {
                    for await (const chunk of toChunks(body)) {
                        hash.update(chunk);
                        size += chunk.byteLength;
                        await handle.write(chunk);
                    }

                    meta = {
                        customMetadata: putOptions?.customMetadata,
                        httpMetadata: putOptions?.httpMetadata,
                        sha256Hex: hash.digest("hex"),
                        size,
                        uploaded: new Date().toISOString(),
                    };

                    await handle.write(encodeTrailer(meta));
                } finally {
                    await handle.close();
                }
            } catch (error: unknown) {
                await unlinkIfPresent(temporaryPath);

                throw error;
            }

            // The one operation that publishes the object — body and metadata are
            // in this file together, so there is no window where they disagree.
            try {
                await rename(temporaryPath, filePath);
            } catch (error: unknown) {
                await unlinkIfPresent(temporaryPath);

                throw asKeyCollision(key, error);
            }

            return toObject(key, meta);
        },
    };
};

export { createNodeR2Bucket };
export type { NodeR2BucketOptions };
