/**
 * `createNodeR2Bucket` — a Node implementation of the `R2BucketLike` structural
 * contract (`@lunora/platform`) over the local filesystem, so `@lunora/storage`'s
 * `createStorage({ bucket })` runs on the Node host.
 *
 * `@visulima/storage`'s providers were deliberately NOT wrapped: its `BaseStorage`
 * is a resumable-upload engine (`create` → `write` parts, checksums, sidecar meta)
 * whose surface has no `head`, a flat `list()` with no prefix/delimiter/cursor,
 * and a `delete` that throws on a missing key — all of which clash with the R2
 * contract `ctx.storage` consumes. The R2 contract is small enough to implement
 * directly over `fs/promises`, so that is what this does.
 *
 * # One file per object, metadata in a trailer
 *
 * An object is a single file at `directory/key`, laid out as
 *
 * ```
 * <body bytes> <trailer JSON> <uint32be trailer length> "LNR1"
 * ```
 *
 * A sidecar tree was the obvious first design and is wrong: bytes and metadata
 * then live in two files, and no pair of filesystem operations publishes both
 * at once. A crash between them leaves an overwritten body carrying the previous
 * checksum, size and content-type, which `get`/`head` then report as fact. With
 * the metadata inside the file, the single `rename` that publishes the bytes
 * publishes the metadata with them — an interrupted `put` leaves the previous
 * version wholly intact, never a mixture of two.
 *
 * The cost is that `directory/key` is no longer byte-identical to the object;
 * a trailer sits after the body. `head` reads the trailer only (two small
 * positioned reads, no body transfer), and `get` streams the requested byte
 * range straight off the file rather than materialising the object in memory.
 *
 * Reserved top-level name: `.lunora-tmp`, the staging tree puts are renamed out
 * of. Keys are rejected unless every `/`-separated segment is a plain name — no
 * empty, `.`, or `..` segments, no backslash (a path separator on Windows), no
 * NUL, no leading `/`. That keeps the key → path mapping injective and confined
 * to the bucket directory on every platform.
 *
 * Not emulated: multipart upload (`createMultipartUpload`/`resumeMultipartUpload`
 * are absent, so `@lunora/storage` throws its clear "binding does not support
 * multipart" error) and S3 presigned URLs (those need real R2 credentials anyway).
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { LunoraError } from "@lunora/errors";
import type { R2BucketLike, R2ObjectBodyLike, R2ObjectLike, R2RangeLike } from "@lunora/platform";

/** Scratch tree for atomic put staging (rename-in is atomic on POSIX). */
const TMP_DIR = ".lunora-tmp";

/** Trailer sentinel — distinguishes a bucket object from an unrelated file dropped into the directory. */
const MAGIC = "LNR1";

/** `uint32be` trailer length + {@link MAGIC}. */
const FOOTER_SIZE = 8;

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
 * Reject keys that do not map injectively onto a path inside the bucket
 * directory. Every segment must be a plain name: `a/./b` and `a//b` would
 * otherwise resolve to the same file as `a/b`, and `..\\outside` escapes the
 * directory entirely on Windows, where `\` is a separator `split("/")` cannot see.
 */
const validateKey = (key: string): void => {
    if (typeof key !== "string" || key.length === 0) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: R2 key must be a non-empty string");
    }

    if (key.includes("\0")) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: R2 key contains a NUL byte");
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
    }

    if (key.split("/")[0] === TMP_DIR) {
        throw new LunoraError("VALIDATION_ERROR", `@lunora/platform-node: R2 key is reserved (first segment must not be "${TMP_DIR}")`);
    }
};

/** True when an `fs/promises` error is a missing path. */
const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";

/** Serialize a trailer: the metadata JSON, its length, and the sentinel. */
const encodeTrailer = (meta: NodeObjectMeta): Buffer => {
    const json = Buffer.from(JSON.stringify(meta), "utf8");
    const footer = Buffer.alloc(FOOTER_SIZE);

    footer.writeUInt32BE(json.byteLength, 0);
    footer.write(MAGIC, 4, "ascii");

    return Buffer.concat([json, footer]);
};

/** Read an object's trailer and the length of the body preceding it, or `undefined` when the key holds no object. */
const readTrailer = async (filePath: string): Promise<{ bodySize: number; meta: NodeObjectMeta } | undefined> => {
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

        await handle.read(trailer, 0, trailerLength, bodySize);

        return { bodySize, meta: JSON.parse(trailer.toString("utf8")) as NodeObjectMeta };
    } finally {
        await handle.close();
    }
};

/**
 * Copy a `Buffer`'s bytes into a standalone `ArrayBuffer`. The slice is what
 * makes it a copy — a `Buffer` is a view into Node's shared allocation pool, so
 * handing out `.buffer` would expose unrelated memory.
 */
const toArrayBuffer = (buffer: Buffer): ArrayBuffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

/** Hex → the `ArrayBuffer` shape `R2ObjectLike.checksums.sha256` carries. */
const hexToArrayBuffer = (hex: string): ArrayBuffer => toArrayBuffer(Buffer.from(hex, "hex"));

/** Build the body-free {@link R2ObjectLike} projection for a key from its trailer. */
const toObject = (key: string, meta: NodeObjectMeta): R2ObjectLike => {
    const { sha256Hex } = meta;

    return {
        checksums: { sha256: hexToArrayBuffer(sha256Hex) },
        customMetadata: meta.customMetadata,
        etag: sha256Hex,
        httpEtag: `"${sha256Hex}"`,
        httpMetadata: meta.httpMetadata,
        key,
        sha256: sha256Hex,
        sha256Base64: Buffer.from(sha256Hex, "hex").toString("base64"),
        size: meta.size,
        uploaded: new Date(meta.uploaded),
    };
};

/** Resolve an {@link R2RangeLike} into absolute `[start, end)` body offsets. */
const resolveRange = (bodySize: number, range?: R2RangeLike): { end: number; start: number } => {
    if (range === undefined) {
        return { end: bodySize, start: 0 };
    }

    if ("suffix" in range) {
        return { end: bodySize, start: bodySize - Math.min(Math.max(0, range.suffix), bodySize) };
    }

    const start = Math.min(Math.max(0, range.offset ?? 0), bodySize);
    const end = range.length === undefined ? bodySize : Math.min(start + Math.max(0, range.length), bodySize);

    return { end, start };
};

/**
 * Stream one window of an object file as a web `ReadableStream`. Written over
 * the file stream's async iterator rather than `Readable.toWeb`, which Node
 * still marks experimental below 22.17 while this package supports ^22.15.
 */
const streamSlice = (filePath: string, start: number, end: number): ReadableStream => {
    const source: AsyncIterator<Buffer> = createReadStream(filePath, { end: end - 1, start })[Symbol.asyncIterator]();

    return new ReadableStream({
        cancel: async () => {
            await source.return?.();
        },
        pull: async (controller) => {
            const result = await source.next();

            if (result.done === true) {
                controller.close();
            } else {
                controller.enqueue(result.value);
            }
        },
    });
};

/** Read one window of an object file. Only the requested bytes are ever in memory. */
const readSlice = async (filePath: string, start: number, end: number): Promise<Buffer> => {
    const length = end - start;

    if (length <= 0) {
        return Buffer.alloc(0);
    }

    const handle = await open(filePath, "r");

    try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);

        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
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

            const filePath = join(directory, key);
            const stored = await readTrailer(filePath);

            if (stored === undefined) {
                return null; // eslint-disable-line unicorn/no-null
            }

            const { end, start } = resolveRange(stored.bodySize, getOptions?.range);

            return {
                ...toObject(key, stored.meta),
                arrayBuffer: async (): Promise<ArrayBuffer> => toArrayBuffer(await readSlice(filePath, start, end)),
                body: end > start ? streamSlice(filePath, start, end) : new Blob([]).stream(),
                text: async (): Promise<string> => {
                    const slice = await readSlice(filePath, start, end);

                    return slice.toString("utf8");
                },
            };
        },

        head: async (key: string): Promise<R2ObjectLike | null> => {
            validateKey(key);

            const stored = await readTrailer(join(directory, key));

            return stored === undefined ? null : toObject(key, stored.meta); // eslint-disable-line unicorn/no-null
        },

        list: async (listOptions: { cursor?: string; delimiter?: string; limit?: number; prefix?: string } = {}) => {
            const limit = Math.min(Math.max(1, Math.floor(listOptions.limit ?? 1000)), 1000);

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

            return { cursor: truncated ? objects.at(-1)?.key : undefined, objects, truncated };
        },

        put: async (
            key: string,
            body: ReadableStream | ArrayBuffer | Blob | string | null,
            putOptions?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } },
        ): Promise<R2ObjectLike> => {
            validateKey(key);

            const filePath = join(directory, key);
            const temporaryPath = join(directory, TMP_DIR, randomUUID());

            await mkdir(dirname(filePath), { recursive: true });
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
            await rename(temporaryPath, filePath);

            return toObject(key, meta);
        },
    };
};

export { createNodeR2Bucket };
export type { NodeR2BucketOptions };
