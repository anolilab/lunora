/**
 * One deployment's non-table state for the section tests — in-memory KV
 * namespaces, storage buckets (with R2's multipart rules) and auth tables,
 * behind the worker options that reach them. Listings page one KV key / two
 * objects at a time, so a caller has to follow the cursor.
 */
import type { R2MultipartUploadLike } from "@lunora/platform";

import type { StorageObject, WorkerOptions } from "../../src/create-worker";
import type { AuthDataPort } from "../../src/export-sections";
import type { KvIntrospector } from "../../src/kv-admin-routes";

type KvEntry = { expiration?: number; metadata?: unknown; value: Uint8Array };
type StoredObject = { bytes: Uint8Array<ArrayBuffer>; contentType?: string; customMetadata?: Record<string, string>; sha256?: string };

const MIN_PART_BYTES = 5 * 1024 * 1024;

/** What the multipart double saw: its peak buffer, and the uploads that never became an object. */
type MultipartStats = { aborted: number; largestPart: number; parts: number };

/**
 * R2's `createMultipartUpload` under the rules R2 enforces — every part but the
 * last at least 5 MiB and all of them equal, ascending part numbers, matching
 * ETags — with the object invisible until `complete`.
 */
const fakeMultipart = (): {
    create: (bucket: Map<string, StoredObject>, key: string, opts?: { contentType?: string; customMetadata?: Record<string, string> }) => R2MultipartUploadLike;
    stats: MultipartStats;
} => {
    const stats: MultipartStats = { aborted: 0, largestPart: 0, parts: 0 };

    const create = (
        bucket: Map<string, StoredObject>,
        key: string,
        opts?: { contentType?: string; customMetadata?: Record<string, string> },
    ): R2MultipartUploadLike => {
        const staged = new Map<number, { body: Uint8Array; etag: string }>();

        return {
            abort: async () => {
                stats.aborted += 1;
                staged.clear();
            },
            complete: async (parts) => {
                const bodies = parts.map((part, index) => {
                    const stored = staged.get(part.partNumber);

                    if (stored?.etag !== part.etag || (index > 0 && part.partNumber <= parts[index - 1]!.partNumber)) {
                        throw new Error(`InvalidPart: part ${String(part.partNumber)}`);
                    }

                    return stored.body;
                });

                for (const body of bodies.slice(0, -1)) {
                    if (body.byteLength < MIN_PART_BYTES || body.byteLength !== bodies[0]!.byteLength) {
                        throw new Error("InvalidPart: a non-final part is under 5 MiB or differs in size");
                    }
                }

                const bytes = new Uint8Array(bodies.reduce((sum, body) => sum + body.byteLength, 0));
                let offset = 0;

                for (const body of bodies) {
                    bytes.set(body, offset);
                    offset += body.byteLength;
                }

                bucket.set(key, {
                    bytes,
                    ...(opts?.contentType === undefined ? {} : { contentType: opts.contentType }),
                    ...(opts?.customMetadata === undefined ? {} : { customMetadata: opts.customMetadata }),
                });

                return { etag: "multipart", key, size: bytes.byteLength };
            },
            key,
            uploadId: "upload-1",
            uploadPart: async (partNumber, value) => {
                if (!(value instanceof Uint8Array)) {
                    throw new TypeError("the import uploads parts as bytes");
                }

                const body = Uint8Array.from(value);
                const etag = `etag-${String(partNumber)}`;

                stats.parts += 1;
                stats.largestPart = Math.max(stats.largestPart, body.byteLength);
                staged.set(partNumber, { body, etag });

                return { etag, partNumber };
            },
        };
    };

    return { create, stats };
};

/** One deployment's non-table state: KV namespaces, storage buckets, auth rows. */
const createStores = (): {
    auth: Map<string, Map<string, Record<string, unknown>>>;
    buckets: Map<string, Map<string, StoredObject>>;
    kv: Map<string, Map<string, KvEntry>>;
    multipart: MultipartStats;
    options: Partial<WorkerOptions>;
} => {
    const kv = new Map<string, Map<string, KvEntry>>([
        ["CACHE", new Map()],
        ["FLAGS", new Map()],
    ]);
    const buckets = new Map<string, Map<string, StoredObject>>([
        ["avatars", new Map()],
        ["default", new Map()],
    ]);
    const auth = new Map<string, Map<string, Record<string, unknown>>>([
        ["session", new Map()],
        ["user", new Map()],
    ]);

    const bucketOf = (name?: string): Map<string, StoredObject> => buckets.get(name ?? "default")!;
    const multipart = fakeMultipart();

    const kvIntrospector: KvIntrospector = {
        deleteKey: async ({ key, namespace }) => {
            kv.get(namespace)?.delete(key);
        },
        getValue: async ({ encoding, key, namespace }) => {
            const entry = kv.get(namespace)?.get(key);

            if (!entry) {
                return { metadata: null, value: null };
            }

            return {
                metadata: entry.metadata ?? null,
                value: encoding === "base64" ? Buffer.from(entry.value).toString("base64") : Buffer.from(entry.value).toString("utf8"),
            };
        },
        listKeys: async ({ cursor, namespace }) => {
            const names = [...(kv.get(namespace)?.keys() ?? [])].toSorted((a, b) => a.localeCompare(b));
            // One key per page, so the export has to follow the cursor.
            const start = cursor === undefined ? 0 : Number(cursor);
            const name = names[start];
            const keys = name === undefined ? [] : [{ expiration: kv.get(namespace)?.get(name)?.expiration, metadata: undefined, name }];

            return start + 1 < names.length ? { cursor: String(start + 1), keys, listComplete: false } : { keys, listComplete: true };
        },
        listNamespaces: async () =>
            [...kv.keys()].map((binding) => {
                return { binding };
            }),
        putValue: async ({ encoding, expiration, key, metadata, namespace, value }) => {
            kv.get(namespace)?.set(key, {
                ...(expiration === undefined ? {} : { expiration }),
                ...(metadata === undefined ? {} : { metadata }),
                value: encoding === "base64" ? new Uint8Array(Buffer.from(value, "base64")) : new TextEncoder().encode(value),
            });
        },
    };

    const authData: AuthDataPort = {
        exportRows: async function* exportRows() {
            for (const [table, rows] of auth) {
                for (const doc of rows.values()) {
                    yield { doc, table };
                }
            }
        },
        replaceRows: async (rows) => {
            const deleted = [...auth.values()].reduce((total, table) => total + table.size, 0);

            for (const table of auth.values()) {
                table.clear();
            }

            for (const { doc, table } of rows) {
                auth.get(table)?.set(String(doc["id"]), doc);
            }

            return { deleted, errors: [], inserted: rows.length };
        },
        importRows: async (rows) => {
            let inserted = 0;
            let conflicts = 0;

            for (const { doc, table } of rows) {
                const target = auth.get(table)!;

                if (target.has(String(doc["id"]))) {
                    conflicts += 1;
                } else {
                    target.set(String(doc["id"]), doc);
                    inserted += 1;
                }
            }

            return { conflicts, errors: [], inserted };
        },
    };

    const options: Partial<WorkerOptions> = {
        authData,
        kvIntrospector,
        storageBuckets: [...buckets.keys()],
        storageDelete: (key, opts) => {
            bucketOf(opts?.bucket).delete(key);
        },
        storageDownload: async (key, opts) => {
            const object = bucketOf(opts?.bucket).get(key);

            return object
                ? { body: new Blob([object.bytes]).stream(), httpMetadata: { contentType: object.contentType }, size: object.bytes.byteLength }
                : null;
        },
        storageList: async (prefix, opts) => {
            const keys = [...bucketOf(opts?.bucket).keys()].filter((key) => key.startsWith(prefix ?? "")).toSorted((a, b) => a.localeCompare(b));
            const start = opts?.cursor === undefined ? 0 : Number(opts.cursor);
            const pageSize = Math.min(2, opts?.limit ?? 2);
            const page = keys.slice(start, start + pageSize);
            const objects: StorageObject[] = page.map((key) => {
                const object = bucketOf(opts?.bucket).get(key)!;

                return {
                    customMetadata: object.customMetadata,
                    etag: "e",
                    httpMetadata: { contentType: object.contentType },
                    key,
                    ...(object.sha256 === undefined ? {} : { sha256: object.sha256 }),
                    size: object.bytes.byteLength,
                };
            });
            const more = start + pageSize < keys.length;

            return { objects, truncated: more, ...(more ? { cursor: String(start + pageSize) } : {}) };
        },
        storageMultipartUpload: async (key, opts) => multipart.create(bucketOf(opts?.bucket), key, opts),
        storageUpload: async (key, body, opts) => {
            bucketOf(opts?.bucket).set(key, {
                bytes: new Uint8Array(body),
                ...(opts?.contentType === undefined ? {} : { contentType: opts.contentType }),
                ...(opts?.customMetadata === undefined ? {} : { customMetadata: opts.customMetadata }),
            });

            return { key };
        },
    };

    return { auth, buckets, kv, multipart: multipart.stats, options };
};

export { createStores, MIN_PART_BYTES };
export type { KvEntry, MultipartStats, StoredObject };
