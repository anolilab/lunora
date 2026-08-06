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
 * directly over `fs/promises`, so that is what this does:
 *
 * - object bytes live at `directory/key` (one file per object, nested dirs
 * from `/`);
 * - metadata lives in a parallel sidecar tree `directory/.lunora-meta/key.json`
 * (content-type, custom metadata, size, upload time, SHA-256);
 * - puts are atomic (write to `.lunora-tmp/` then rename), so a crash never
 * leaves a half-written object;
 * - `head` reads only the sidecar + stat (no body transfer), matching R2 HEAD.
 *
 * Reserved top-level names: `.lunora-meta` and `.lunora-tmp`. Keys whose first
 * segment is one of those (or a `..` segment, NUL, or leading `/`) are rejected —
 * the object and metadata trees must stay disjoint and confined to the bucket
 * directory.
 *
 * Not emulated: multipart upload (`createMultipartUpload`/`resumeMultipartUpload`
 * are absent, so `@lunora/storage` throws its clear "binding does not support
 * multipart" error) and S3 presigned URLs (those need real R2 credentials anyway).
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

import { LunoraError } from "@lunora/errors";
import type { R2BucketLike, R2ObjectBodyLike, R2ObjectLike, R2RangeLike } from "@lunora/platform";

/** Metadata sidecar tree, kept disjoint from the object tree. */
const META_DIR = ".lunora-meta";

/** Scratch tree for atomic put staging (rename-in is atomic on POSIX). */
const TMP_DIR = ".lunora-tmp";

/** Per-object metadata persisted next to the bytes. */
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

/** Reject keys that would escape the bucket directory or collide with the sidecar trees. */
const validateKey = (key: string): void => {
    if (typeof key !== "string" || key.length === 0) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: R2 key must be a non-empty string");
    }

    if (key.includes("\0")) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: R2 key contains a NUL byte");
    }

    if (key.startsWith("/")) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: R2 key must not start with `/`");
    }

    const firstSegment = key.split("/")[0];

    if (firstSegment === META_DIR || firstSegment === TMP_DIR) {
        throw new LunoraError("VALIDATION_ERROR", `@lunora/platform-node: R2 key is reserved (first segment must not be "${firstSegment}")`);
    }

    for (const segment of key.split("/")) {
        if (segment === "..") {
            throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: R2 key contains a `..` path component");
        }
    }
};

/** True when an `fs/promises` error is a missing path. */
const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";

/** Read the meta sidecar for a key, or `undefined` when absent. */
const readMeta = async (directory: string, key: string): Promise<NodeObjectMeta | undefined> => {
    try {
        const raw = await readFile(join(directory, META_DIR, `${key}.json`), "utf8");

        return JSON.parse(raw) as NodeObjectMeta;
    } catch (error: unknown) {
        if (isMissing(error)) {
            return undefined;
        }

        throw error;
    }
};

/** Persist the meta sidecar for a key. */
const writeMeta = async (directory: string, key: string, meta: NodeObjectMeta): Promise<void> => {
    const metaPath = join(directory, META_DIR, `${key}.json`);

    await mkdir(dirname(metaPath), { recursive: true });
    await writeFile(metaPath, JSON.stringify(meta));
};

/** Hex → the `ArrayBuffer` shape `R2ObjectLike.checksums.sha256` carries. */
const hexToArrayBuffer = (hex: string): ArrayBuffer => {
    const buffer = Buffer.from(hex, "hex");

    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
};

/** Compute the uploaded date from meta and file stat. */
const getUploadedDate = (meta: NodeObjectMeta | undefined, fileStat?: { mtimeMs: number; size: number }): Date | undefined => {
    if (meta?.uploaded !== undefined) {
        return new Date(meta.uploaded);
    }

    if (fileStat !== undefined) {
        return new Date(fileStat.mtimeMs);
    }

    return undefined;
};

/** Build the body-free {@link R2ObjectLike} projection for a key from its sidecar + stat. */
const toObject = (key: string, meta: NodeObjectMeta | undefined, fileStat?: { mtimeMs: number; size: number }): R2ObjectLike => {
    const { sha256Hex } = meta ?? { sha256Hex: undefined };

    const checksums = sha256Hex === undefined ? undefined : { sha256: hexToArrayBuffer(sha256Hex) };
    const etag = sha256Hex ?? `stat-${String(fileStat?.size)}-${String(fileStat?.mtimeMs)}`;
    const httpEtag = sha256Hex === undefined ? undefined : `"${sha256Hex}"`;
    const sha256Base64 = sha256Hex === undefined ? undefined : Buffer.from(sha256Hex, "hex").toString("base64");

    return {
        checksums,
        customMetadata: meta?.customMetadata,
        etag,
        httpEtag,
        httpMetadata: meta?.httpMetadata,
        key,
        sha256: sha256Hex,
        sha256Base64,
        size: meta?.size ?? fileStat?.size ?? 0,
        uploaded: getUploadedDate(meta, fileStat),
    };
};

/** Stat an object file, mapping a missing key to `undefined` and a directory to a miss. */
const statObject = async (directory: string, key: string): Promise<{ mtimeMs: number; size: number } | undefined> => {
    try {
        const result = await stat(join(directory, key));

        if (result.isFile()) {
            return { mtimeMs: result.mtimeMs, size: result.size };
        }
    } catch (error: unknown) {
        if (isMissing(error)) {
            return undefined;
        }
    }

    return undefined;
};

/** Apply an {@link R2RangeLike} window to a byte buffer. */
const applyRange = (bytes: Uint8Array, range?: R2RangeLike): Uint8Array => {
    if (range === undefined) {
        return bytes;
    }

    const total = bytes.length;

    if ("suffix" in range) {
        return bytes.slice(total - Math.min(range.suffix, total));
    }

    const offset = range.offset ?? 0;
    const length = range.length ?? total - offset;

    return bytes.slice(offset, Math.min(offset + length, total));
};

/** Fold every supported R2 put body into one byte buffer. */
const toBytes = async (body: ReadableStream | ArrayBuffer | Blob | string | null | undefined): Promise<Uint8Array> => {
    if (body === null || body === undefined) {
        return new Uint8Array(0);
    }

    if (typeof body === "string") {
        return new TextEncoder().encode(body);
    }

    if (body instanceof ArrayBuffer) {
        return new Uint8Array(body);
    }

    if (ArrayBuffer.isView(body)) {
        return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    }

    if (body instanceof Blob) {
        return new Uint8Array(await body.arrayBuffer());
    }

    if (body instanceof ReadableStream) {
        const chunks: Uint8Array[] = [];

        for await (const chunk of body) {
            if (chunk instanceof Uint8Array) {
                chunks.push(chunk);
            } else if (chunk instanceof ArrayBuffer) {
                chunks.push(new Uint8Array(chunk));
            } else {
                throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: R2 put stream must yield byte chunks");
            }
        }

        const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const out = new Uint8Array(total);
        let offset = 0;

        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.byteLength;
        }

        return out;
    }

    throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: unsupported R2 put body");
};

/** Recursively collect object keys under the bucket directory, skipping the sidecar + staging trees. */
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
            if (entry.name === META_DIR || entry.name === TMP_DIR) {
                continue;
            }

            const relativePath = relative === "" ? entry.name : `${relative}${sep}${entry.name}`;

            if (entry.isDirectory()) {
                promises.push(walk(join(currentPath, entry.name), relativePath));
            } else {
                keys.push(relativePath);
            }
        }

        await Promise.all(promises);
    };

    await walk(directory, "");
    keys.sort((a, b) => a.localeCompare(b));

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
            await unlinkIfPresent(join(directory, META_DIR, `${key}.json`));
        },

        get: async (key: string, getOptions?: { range?: R2RangeLike }): Promise<R2ObjectBodyLike | null> => {
            validateKey(key);

            const fileStat = await statObject(directory, key);

            if (fileStat === undefined) {
                return null; // eslint-disable-line unicorn/no-null
            }

            const bytes = await readFile(join(directory, key));
            const ranged = Buffer.from(applyRange(bytes, getOptions?.range));
            const meta = await readMeta(directory, key);
            const object = toObject(key, meta, fileStat);
            const rangedBuffer = ranged.buffer.slice(ranged.byteOffset, ranged.byteOffset + ranged.byteLength);

            return {
                ...object,
                arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(rangedBuffer),
                body: new Blob([rangedBuffer]).stream(),
                text: (): Promise<string> => Promise.resolve(ranged.toString("utf8")),
            };
        },

        head: async (key: string): Promise<R2ObjectLike | null> => {
            validateKey(key);

            const fileStat = await statObject(directory, key);

            if (fileStat === undefined) {
                return null; // eslint-disable-line unicorn/no-null
            }

            return toObject(key, await readMeta(directory, key), fileStat);
        },

        list: async (listOptions: { cursor?: string; delimiter?: string; limit?: number; prefix?: string } = {}) => {
            const limit = Math.min(Math.max(1, Math.floor(listOptions.limit ?? 1000)), 1000);

            if (listOptions.prefix?.includes("\0")) {
                throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: R2 list prefix contains a NUL byte");
            }

            const all = await walkObjects(directory);
            const prefix = listOptions.prefix ?? "";
            const filtered = all.filter((key) => key.startsWith(prefix) && (listOptions.delimiter === undefined || !key.slice(prefix.length).includes(listOptions.delimiter)));

            const startIndex = listOptions.cursor === undefined ? 0 : firstIndexGreaterThan(filtered, listOptions.cursor);
            const page = filtered.slice(startIndex, startIndex + limit);
            const truncated = startIndex + limit < filtered.length;
            const objects = await Promise.all(page.map(async (key) => toObject(key, await readMeta(directory, key), await statObject(directory, key))));

            return { cursor: truncated ? objects.at(-1)?.key : undefined, objects, truncated };
        },

        put: async (
            key: string,
            body: ReadableStream | ArrayBuffer | Blob | string | null,
            putOptions?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } },
        ): Promise<R2ObjectLike> => {
            validateKey(key);

            const bytes = await toBytes(body);
            const sha256Hex = createHash("sha256").update(bytes).digest("hex");
            const filePath = join(directory, key);
            const temporaryPath = join(directory, TMP_DIR, randomUUID());

            await mkdir(dirname(filePath), { recursive: true });
            await mkdir(dirname(temporaryPath), { recursive: true });
            await writeFile(temporaryPath, bytes);
            await rename(temporaryPath, filePath);

            const meta: NodeObjectMeta = {
                customMetadata: putOptions?.customMetadata,
                httpMetadata: putOptions?.httpMetadata,
                sha256Hex,
                size: bytes.length,
                uploaded: new Date().toISOString(),
            };

            await writeMeta(directory, key, meta);

            return toObject(key, meta);
        },
    };
};

export { createNodeR2Bucket };
export type { NodeR2BucketOptions };
