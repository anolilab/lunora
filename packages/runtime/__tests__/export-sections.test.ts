import type { R2MultipartUploadLike } from "@lunora/platform";
import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike, StorageObject, WorkerOptions } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { AuthDataPort } from "../src/export-sections";
import { SECTION_CHUNK_BYTES } from "../src/export-sections";
import type { KvIntrospector } from "../src/kv-admin-routes";

const ADMIN_TOKEN = "admin-bear";
const fakeContext: ExecutionContextLike = { passThroughOnException: () => undefined, waitUntil: () => undefined };

/** What a cloud restore / `lunora import` sends per request. */
const IMPORT_BATCH_BYTES = 900_000;

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
const createStores = () => {
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

const workerFor = (options: Partial<WorkerOptions>) =>
    createWorker({
        adminToken: ADMIN_TOKEN,
        listSchemaTables: () => ["todos"],
        queryCoordinator: {
            fanOut: vi.fn<() => never>(),
            orchestrateApplyCdc: vi.fn<() => never>(),
            orchestrateCdcSync: vi.fn<() => never>(),
            orchestrateExport: async () => {
                return {
                    failed: 0,
                    ok: 1,
                    shards: [{ rows: [{ doc: { _id: "t1" }, table: "todos" }], shardKey: "__root__" }],
                };
            },
            orchestrateImport: (async (_namespace: unknown, request: { batches: { rows: unknown[] }[] }) => {
                return {
                    conflicts: 0,
                    errors: [],
                    inserted: { todos: request.batches.reduce((sum, batch) => sum + batch.rows.length, 0) },
                    shards: [],
                };
            }) as never,
            orchestrateMigration: vi.fn<() => never>(),
            orchestrateRank: vi.fn<() => never>(),
            orchestrateRankPage: vi.fn<() => never>(),
            orchestrateShardTraffic: vi.fn<() => never>(),
            registry: {} as never,
        },
        shardDO: {
            get: () => {
                return { fetch: async () => new Response("unused") };
            },
            idFromName: (name) => {
                return { __name: name };
            },
        },
        ...options,
    });

const exportFrom = async (worker: ReturnType<typeof workerFor>, body: unknown = {}): Promise<string[]> => {
    const response = await worker.fetch(
        new Request("https://app.example/_lunora/admin/export", {
            body: JSON.stringify(body),
            headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
            method: "POST",
        }),
        {},
        fakeContext,
    );

    expect(response.status).toBe(200);

    const text = await response.text();

    return text.trim().split("\n");
};

type ImportSummary = { conflicts: number; errors: { code: string }[]; inserted: Record<string, number>; received: number };

/** Replay lines the way a restore does: in order, in batches under the import body cap. */
const importInto = async (worker: ReturnType<typeof workerFor>, lines: ReadonlyArray<string>): Promise<ImportSummary> => {
    const total: ImportSummary = { conflicts: 0, errors: [], inserted: {}, received: 0 };
    const batches: string[] = [];
    let batch = "";

    for (const line of lines) {
        expect(line.length + 1).toBeLessThan(IMPORT_BATCH_BYTES);

        if (batch.length + line.length + 1 > IMPORT_BATCH_BYTES) {
            batches.push(batch);
            batch = "";
        }

        batch += `${line}\n`;
    }

    batches.push(batch);

    for (const body of batches) {
        // eslint-disable-next-line no-await-in-loop -- batches go in order, like a restore
        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/import", { body, headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }),
            {},
            fakeContext,
        );
        // eslint-disable-next-line no-await-in-loop -- as above
        const result: ImportSummary = await response.json();

        total.conflicts += result.conflicts;
        total.errors.push(...result.errors);
        total.received += result.received;

        for (const [table, count] of Object.entries(result.inserted)) {
            total.inserted[table] = (total.inserted[table] ?? 0) + count;
        }
    }

    return total;
};

const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");

/** A staging key whose session started `ageMs` ago. */
const stagedKey = (hash: string, ageMs: number): string =>
    `_lunora/restore/${hash.repeat(64)}/${String(9_999_999_999_999 - (Date.now() - ageMs)).padStart(13, "0")}/${"0".repeat(16)}`;

const stagingKeys = (bucket: Map<string, StoredObject>): string[] => [...bucket.keys()].filter((key) => key.startsWith("_lunora/restore/"));

const randomBytes = (size: number): Uint8Array<ArrayBuffer> => {
    const bytes = new Uint8Array(size);

    for (let index = 0; index < size; index += 65_536) {
        crypto.getRandomValues(bytes.subarray(index, Math.min(size, index + 65_536)));
    }

    return bytes;
};

describe("admin export — auth, KV and storage sections", () => {
    it("leaves the auth section out of a whole-deployment export unless it is asked for by name", async () => {
        expect.hasAssertions();

        const source = createStores();

        source.auth.get("user")!.set("u1", { email: "a@example.com", id: "u1" });

        const lines = await exportFrom(workerFor(source.options));
        const parsed = lines.map((line) => JSON.parse(line) as { doc: Record<string, unknown>; table: string });

        expect(parsed[0]).toStrictEqual({ doc: { format: 2, sections: ["kv", "storage"] }, table: "$lunora" });
        expect(parsed.some((row) => row.table === "$auth")).toBe(false);
    });

    it("round-trips every section through export and a batched import", async () => {
        expect.hasAssertions();

        const source = createStores();
        const binary = new Uint8Array([0, 255, 1, 254, 128]);
        const large = randomBytes(SECTION_CHUNK_BYTES * 2 + 12_345);
        const huge = randomBytes(SECTION_CHUNK_BYTES * 2 + 7);
        const future = Math.floor(Date.now() / 1000) + 3600;

        source.auth.get("user")!.set("u1", { email: "a@example.com", id: "u1" });
        source.auth.get("session")!.set("s1", { id: "s1", userId: "u1" });
        source.kv.get("CACHE")!.set("binary", { metadata: { kind: "bin" }, value: binary });
        source.kv.get("CACHE")!.set("text", { expiration: future, value: new TextEncoder().encode("hello") });
        source.kv.get("FLAGS")!.set("huge", { expiration: future, metadata: { big: true }, value: huge });
        source.buckets
            .get("default")!
            .set("small.txt", { bytes: new TextEncoder().encode("small"), contentType: "text/plain", customMetadata: { owner: "u1" } });
        source.buckets.get("default")!.set("empty", { bytes: new Uint8Array(0) });
        source.buckets.get("default")!.set("_lunora/uploads/state.json", { bytes: new TextEncoder().encode("{}") });
        source.buckets.get("avatars")!.set("large.bin", { bytes: large, contentType: "application/octet-stream" });

        const lines = await exportFrom(workerFor(source.options), { sections: ["auth", "kv", "storage"] });
        const parsed = lines.map((line) => JSON.parse(line) as { doc: Record<string, unknown>; table: string });

        expect(parsed[0]).toStrictEqual({ doc: { format: 2, sections: ["auth", "kv", "storage"] }, table: "$lunora" });
        expect(parsed[1]).toStrictEqual({ doc: { _id: "t1" }, table: "todos" });
        expect(parsed.filter((row) => row.table === "$storage" && row.doc["key"] === "large.bin")).toHaveLength(3);
        expect(parsed.filter((row) => row.table === "$kv" && row.doc["key"] === "huge")).toHaveLength(3);
        expect(parsed.some((row) => row.doc["key"] === "_lunora/uploads/state.json")).toBe(false);

        const target = createStores();
        const summary = await importInto(workerFor(target.options), lines);

        expect(summary.errors).toStrictEqual([]);
        expect(summary.received).toBe(lines.length);
        expect(target.auth.get("user")!.get("u1")).toStrictEqual({ email: "a@example.com", id: "u1" });
        expect(target.auth.get("session")!.get("s1")).toStrictEqual({ id: "s1", userId: "u1" });
        expect(target.kv.get("CACHE")!.get("binary")).toStrictEqual({ metadata: { kind: "bin" }, value: binary });
        expect(target.kv.get("CACHE")!.get("text")).toStrictEqual({ expiration: future, value: new TextEncoder().encode("hello") });
        expect(target.kv.get("FLAGS")!.get("huge")).toStrictEqual({ expiration: future, metadata: { big: true }, value: huge });
        expect(target.buckets.get("default")!.get("small.txt")).toStrictEqual({
            bytes: new TextEncoder().encode("small"),
            contentType: "text/plain",
            customMetadata: { owner: "u1" },
        });
        expect(target.buckets.get("default")!.get("empty")?.bytes).toStrictEqual(new Uint8Array(0));
        expect(target.buckets.get("avatars")!.get("large.bin")?.bytes).toStrictEqual(large);
        // The staged chunks are cleaned up once the object is assembled.
        expect([...target.buckets.get("avatars")!.keys()]).toStrictEqual(["large.bin"]);
        expect([...target.buckets.get("default")!.keys()].filter((key) => key.startsWith("_lunora/"))).toStrictEqual([]);

        // Append-only: a second restore writes nothing and counts every record as present.
        const again = await importInto(workerFor(target.options), lines);

        expect(again.inserted["$auth"] ?? 0).toBe(0);
        // Only the chunks in front of a large value's last are written (to staging):
        // whether the key exists is checked once, when the value is assembled.
        expect(again.inserted["$kv"] ?? 0).toBe(2);
        expect(again.conflicts).toBeGreaterThanOrEqual(2 + 2 + 3);
    });

    it("writes the format-1 stream unchanged when no section is configured, or tables are named", async () => {
        expect.hasAssertions();

        const plain = await exportFrom(workerFor({}));
        const named = await exportFrom(workerFor(createStores().options), { tables: ["todos"] });

        expect(plain).toStrictEqual(['{"doc":{"_id":"t1"},"table":"todos"}']);
        expect(named).toStrictEqual(plain);
    });

    it("exports only the sections asked for", async () => {
        expect.hasAssertions();

        const stores = createStores();

        stores.kv.get("CACHE")!.set("k", { value: new Uint8Array([1]) });

        const lines = await exportFrom(workerFor(stores.options), { sections: ["kv"], tables: ["todos"] });

        expect(lines.map((line) => (JSON.parse(line) as { table: string }).table)).toStrictEqual(["$lunora", "todos", "$kv"]);
    });

    it("refuses an unknown section name", async () => {
        expect.assertions(1);

        const response = await workerFor({}).fetch(
            new Request("https://app.example/_lunora/admin/export", {
                body: JSON.stringify({ sections: ["vectorize"] }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);
    });

    it("refuses a header from a newer format before writing anything", async () => {
        expect.assertions(2);

        const stores = createStores();
        const response = await workerFor(stores.options).fetch(
            new Request("https://app.example/_lunora/admin/import", {
                body: `${JSON.stringify({ doc: { format: 3 }, table: "$lunora" })}\n${JSON.stringify({ doc: { key: "k", namespace: "CACHE", value: "AQ==" }, table: "$kv" })}\n`,
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);
        expect(stores.kv.get("CACHE")!.size).toBe(0);
    });

    it("reports section rows a worker cannot write instead of dropping them", async () => {
        expect.hasAssertions();

        const summary = await importInto(workerFor({}), [
            JSON.stringify({ doc: { row: { id: "u1" }, table: "user" }, table: "$auth" }),
            JSON.stringify({ doc: { key: "k", namespace: "CACHE", value: "AQ==" }, table: "$kv" }),
            JSON.stringify({ doc: { data: "AQ==", key: "a", last: true, offset: 0, size: 1 }, table: "$storage" }),
        ]);

        expect(summary.errors.map((error) => error.code)).toStrictEqual(["AUTH_NOT_CONFIGURED", "KV_NOT_CONFIGURED", "STORAGE_NOT_CONFIGURED"]);
    });

    it("audits a section import on the default shard as counts, never values", async () => {
        expect.hasAssertions();

        const stores = createStores();
        const sent: { body: { args: Record<string, unknown>; functionPath: string }; shard: string }[] = [];
        const worker = workerFor({
            ...stores.options,
            shardDO: {
                get: (id) => {
                    return {
                        fetch: async (request: Request) => {
                            sent.push({ body: await request.json(), shard: (id as { __name: string }).__name });

                            return Response.json({ result: { recorded: true } });
                        },
                    };
                },
                idFromName: (name) => {
                    return { __name: name };
                },
            },
        });

        await importInto(worker, [
            JSON.stringify({ doc: { row: { email: "secret@example.com", id: "u1" }, table: "user" }, table: "$auth" }),
            JSON.stringify({ doc: { key: "k", namespace: "CACHE", value: "AQ==" }, table: "$kv" }),
        ]);

        expect(sent).toStrictEqual([
            {
                body: {
                    args: { conflicts: 0, errors: 0, inserted: { $auth: 1, $kv: 1 }, op: "importSections" },
                    functionPath: "__lunora_admin__:recordImportAudit",
                },
                shard: "__root__",
            },
        ]);
    });

    it("reports a section audit the default shard refused as a warning, not a failed import", async () => {
        expect.hasAssertions();

        const stores = createStores();
        const worker = workerFor({
            ...stores.options,
            shardDO: {
                get: () => {
                    return { fetch: async () => new Response("nope", { status: 403 }) };
                },
                idFromName: (name) => {
                    return { __name: name };
                },
            },
        });
        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/import", {
                body: JSON.stringify({ doc: { key: "k", namespace: "CACHE", value: "AQ==" }, table: "$kv" }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            inserted: { $kv: 1 },
            warnings: [expect.stringContaining("importSections audit entry was not recorded")],
        });
    });

    it("reports an object whose earlier chunks never arrived", async () => {
        expect.hasAssertions();

        const stores = createStores();
        const summary = await importInto(workerFor(stores.options), [
            JSON.stringify({ doc: { data: "AQ==", key: "partial", last: true, offset: 4, size: 5 }, table: "$storage" }),
        ]);

        expect(summary.errors.map((error) => error.code)).toStrictEqual(["STORAGE_RESTORE_INCOMPLETE"]);
        expect(stores.buckets.get("default")!.has("partial")).toBe(false);
    });

    it("restores an object over 32 MiB through a multipart upload of equal 5 MiB parts", async () => {
        expect.hasAssertions();

        const source = createStores();
        const big = randomBytes(33 * 1024 * 1024 + 3);

        source.buckets.get("default")!.set("big.bin", { bytes: big, contentType: "application/zip", customMetadata: { a: "1" }, sha256: await sha256Hex(big) });

        const lines = await exportFrom(workerFor(source.options), { sections: ["storage"] });
        const target = createStores();
        const summary = await importInto(workerFor(target.options), lines);
        const { bytes, ...restored } = target.buckets.get("default")!.get("big.bin")!;

        expect(summary.errors).toStrictEqual([]);
        expect(restored).toStrictEqual({ contentType: "application/zip", customMetadata: { a: "1" } });
        // Not a deep equality: a 33 MiB diff is more than the reporter can print.
        expect(Buffer.from(bytes).equals(big)).toBe(true);
        // Seven parts: six of exactly 5 MiB and the remainder; one part held at a time.
        expect(target.multipart).toStrictEqual({ aborted: 0, largestPart: 5 * 1024 * 1024, parts: 7 });
        expect(stagingKeys(target.buckets.get("default")!)).toStrictEqual([]);
    });

    it("aborts the multipart upload when the restored bytes do not match the exported sha256", async () => {
        expect.hasAssertions();

        const source = createStores();

        source.buckets.get("default")!.set("big.bin", { bytes: randomBytes(33 * 1024 * 1024), sha256: "0".repeat(64) });

        const lines = await exportFrom(workerFor(source.options), { sections: ["storage"] });
        const target = createStores();
        const summary = await importInto(workerFor(target.options), lines);

        expect(summary.errors.map((error) => error.code)).toStrictEqual(["STORAGE_SHA256_MISMATCH"]);
        expect(target.buckets.get("default")!.has("big.bin")).toBe(false);
        expect(target.multipart.aborted).toBe(1);
        expect(stagingKeys(target.buckets.get("default")!)).toStrictEqual([]);
    });

    it("refuses an object over 32 MiB without a multipart upload, staging nothing past the ceiling", async () => {
        expect.hasAssertions();

        const source = createStores();

        source.buckets.get("default")!.set("big.bin", { bytes: randomBytes(33 * 1024 * 1024) });

        const lines = await exportFrom(workerFor(source.options), { sections: ["storage"] });
        const target = createStores();
        const summary = await importInto(workerFor({ ...target.options, storageMultipartUpload: undefined }), lines);

        expect(summary.errors.map((error) => error.code)).toStrictEqual(["STORAGE_OBJECT_TOO_LARGE"]);
        expect(target.buckets.get("default")!.has("big.bin")).toBe(false);
    });

    it("refuses a chunked KV value whose bytes do not match its sha256, and drops its staging", async () => {
        expect.hasAssertions();

        const source = createStores();

        source.kv.get("CACHE")!.set("big", { value: randomBytes(SECTION_CHUNK_BYTES * 2) });

        const exported = await exportFrom(workerFor(source.options), { sections: ["kv"] });
        const lines = exported.map((line) => {
            const row = JSON.parse(line) as { doc: Record<string, unknown>; table: string };

            return row.doc["last"] === true ? JSON.stringify({ ...row, doc: { ...row.doc, sha256: "0".repeat(64) } }) : line;
        });
        const target = createStores();
        const summary = await importInto(workerFor(target.options), lines);

        expect(summary.errors.map((error) => error.code)).toStrictEqual(["KV_SHA256_MISMATCH"]);
        expect(target.kv.get("CACHE")!.has("big")).toBe(false);
        expect(stagingKeys(target.buckets.get("default")!)).toStrictEqual([]);
    });

    it("sweeps staging older than a day when the next import starts, and nothing else under _lunora/", async () => {
        expect.hasAssertions();

        const stores = createStores();
        const blob = { bytes: new Uint8Array([1]) };
        const fresh = stagedKey("b", 60 * 60 * 1000);

        stores.buckets.get("default")!.set(stagedKey("a", 25 * 60 * 60 * 1000), blob);
        stores.buckets.get("default")!.set(fresh, blob);
        // An earlier layout's leftover, with no session segment.
        stores.buckets.get("default")!.set(`_lunora/restore/${"c".repeat(64)}/${"0".repeat(16)}`, blob);
        stores.buckets.get("default")!.set("_lunora/uploads/state.json", blob);
        stores.buckets.get("avatars")!.set(stagedKey("d", 48 * 60 * 60 * 1000), blob);

        const summary = await importInto(workerFor(stores.options), [JSON.stringify({ doc: { format: 2, sections: ["storage"] }, table: "$lunora" })]);

        expect(summary.errors).toStrictEqual([]);
        expect(new Set(stores.buckets.get("default")!.keys())).toStrictEqual(new Set(["_lunora/uploads/state.json", fresh]));
        expect([...stores.buckets.get("avatars")!.keys()]).toStrictEqual([]);
    });
});
