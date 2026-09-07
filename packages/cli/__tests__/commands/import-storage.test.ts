/**
 * `lunora import --with-storage` — the Convex blob-migration half of the import
 * command: reading the `_storage` sidecar, uploading each blob through the
 * checksum-verified admin route, rewriting the references that pointed at Convex
 * storage ids, and the `--scan` / `--verify` guards around it.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StreamingFetchLike } from "../../src/commands/data-transfer";
import { runImportCommand } from "../../src/commands/data-transfer";
import type { Logger } from "../../src/util/logger";

const sha256Hex = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");

interface CapturedLogs {
    error: string[];
    warn: string[];
}

const capturingLogger = (): { logger: Logger; logs: CapturedLogs } => {
    const logs: CapturedLogs = { error: [], warn: [] };

    return {
        logger: {
            error: (message: string) => logs.error.push(message),
            info: () => {},
            success: () => {},
            warn: (message: string) => logs.warn.push(message),
        },
        logs,
    };
};

/** One object as the fake worker's bucket holds it. */
interface StoredObject {
    bytes: string;
    sha256: string;
    size: number;
}

interface FakeWorker {
    bucket: Map<string, StoredObject>;
    deleted: string[];
    fetchImpl: StreamingFetchLike;
    imported: { doc: Record<string, unknown>; table: string }[];
    /** Objects returned per list page — small values force the cursor to be followed. */
    listPageSize: number;
    /** Keys reached through the signed-PUT fallback rather than the verified route. */
    signedPuts: string[];
    uploads: string[];
}

/**
 * A worker stand-in for the three routes the storage import touches: the object
 * list, the checksum-verified upload, and the NDJSON import sink.
 */
const fakeWorker = (): FakeWorker => {
    const bucket = new Map<string, StoredObject>();
    const imported: { doc: Record<string, unknown>; table: string }[] = [];
    const uploads: string[] = [];
    const signedPuts: string[] = [];
    const deleted: string[] = [];
    const worker = { bucket, deleted, imported, listPageSize: Number.POSITIVE_INFINITY, signedPuts, uploads };

    const json = (value: unknown) => {
        return {
            body: null,
            json: async () => value,
            ok: true,
            status: 200,
            text: async () => JSON.stringify(value),
        };
    };

    /** `POST /_lunora/admin/import` — record the rows and report them inserted. */
    const handleImport = (body: string | Uint8Array | undefined) => {
        const inserted: Record<string, number> = {};

        for (const line of (typeof body === "string" ? body : "").split("\n").filter((entry) => entry.trim().length > 0)) {
            const row = JSON.parse(line) as { doc: Record<string, unknown>; table: string };

            imported.push(row);
            inserted[row.table] = (inserted[row.table] ?? 0) + 1;
        }

        return json({ conflicts: 0, errors: [], inserted, received: imported.length });
    };

    /** `GET /_lunora/admin/storage` — one page per `listPageSize`, cursor-driven. */
    const handleList = (url: URL) => {
        const prefix = url.searchParams.get("prefix") ?? "";
        const matching = [...bucket.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, object_]) => {
                return { key, sha256: object_.sha256, size: object_.size };
            });

        const from = Number(url.searchParams.get("cursor") ?? "0");
        const page = matching.slice(from, from + worker.listPageSize);
        const next = from + page.length;

        return json({ cursor: String(next), objects: page, truncated: next < matching.length });
    };

    /** `PUT /_lunora/admin/storage` — mirror the route's reject-before-write check. */
    const handleVerifiedUpload = (url: URL, body: string | Uint8Array | undefined) => {
        const key = url.searchParams.get("key") as string;
        const bytes = new TextDecoder().decode(body as Uint8Array);
        const digest = sha256Hex(bytes);

        if (digest !== url.searchParams.get("expectedSha256") || String(bytes.length) !== url.searchParams.get("expectedSize")) {
            return {
                body: null,
                json: async () => {
                    return {};
                },
                ok: false,
                status: 400,
                text: async () => "STORAGE_CHECKSUM_MISMATCH",
            };
        }

        uploads.push(key);
        bucket.set(key, { bytes, sha256: digest, size: bytes.length });

        return json({ key, sha256: digest });
    };

    const fetchImpl: StreamingFetchLike = async (input, init) => {
        const url = new URL(input);
        const method = init?.method ?? "GET";

        if (url.pathname === "/_lunora/admin/import") {
            return handleImport(init?.body);
        }

        // The signed-URL minter, and the app-served endpoint the minted URL
        // points at. Both are needed to reach the >32 MiB fallback.
        if (url.pathname === "/_lunora/admin/storage/url") {
            const key = url.searchParams.get("key") as string;

            return json({ key, url: `https://cdn.test/signed/${encodeURIComponent(key)}?method=${url.searchParams.get("method") ?? "GET"}` });
        }

        if (url.hostname === "cdn.test" && method === "PUT") {
            const key = decodeURIComponent(url.pathname.replace("/signed/", ""));
            const bytes = new TextDecoder().decode(init?.body as Uint8Array);

            signedPuts.push(key);
            bucket.set(key, { bytes, sha256: sha256Hex(bytes), size: bytes.length });

            return json({ key });
        }

        if (url.pathname === "/_lunora/admin/storage" && method === "DELETE") {
            const key = url.searchParams.get("key") as string;

            deleted.push(key);
            bucket.delete(key);

            return json({ deleted: true, key });
        }

        if (url.pathname === "/_lunora/admin/storage") {
            return method === "GET" ? handleList(url) : handleVerifiedUpload(url, init?.body);
        }

        throw new Error(`unexpected request: ${method} ${input}`);
    };

    return Object.assign(worker, { fetchImpl });
};

let workDir: string;

/** Write a `npx convex export --include-file-storage` layout. */
const writeConvexExport = (
    blobs: Record<string, string>,
    tables: Record<string, Record<string, unknown>[]>,
    sha256Encoding: "base64" | "hex" = "hex",
): string => {
    const root = join(workDir, "convex-export");

    mkdirSync(join(root, "_storage"), { recursive: true });

    const metadata = Object.entries(blobs).map(([id, content]) => {
        writeFileSync(join(root, "_storage", id), content, "utf8");

        const digest = createHash("sha256").update(content);

        return JSON.stringify({
            _creationTime: 1,
            _id: id,
            contentType: "text/plain",
            sha256: sha256Encoding === "hex" ? digest.digest("hex") : digest.digest("base64"),
            size: Buffer.byteLength(content),
        });
    });

    writeFileSync(join(root, "_storage", "documents.jsonl"), `${metadata.join("\n")}\n`, "utf8");

    for (const [table, rows] of Object.entries(tables)) {
        mkdirSync(join(root, table), { recursive: true });
        writeFileSync(join(root, table, "documents.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    }

    return root;
};

const writeMapping = (storageColumns: Record<string, string[]>, keyPrefix = ""): void => {
    mkdirSync(join(workDir, "lunora"), { recursive: true });
    writeFileSync(join(workDir, "lunora", "import-convex.json"), JSON.stringify({ keyPrefix, storageColumns }), "utf8");
};

describe("lunora import --with-storage", () => {
    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), "lunora-cli-import-storage-"));
    });

    afterEach(() => {
        rmSync(workDir, { force: true, recursive: true });
    });

    it("uploads every blob under its content hash and rewrites both reference shapes", async () => {
        expect.assertions(5);

        const avatarHash = sha256Hex("avatar-bytes");
        const coverHash = sha256Hex("cover-bytes");
        const root = writeConvexExport(
            { kg_avatar: "avatar-bytes", kg_cover: "cover-bytes" },
            {
                posts: [{ _id: "p1", cover: { $storage: "kg_cover" }, title: "hello" }],
                users: [{ _id: "u1", avatarId: "kg_avatar" }],
            },
        );

        writeMapping({ users: ["avatarId"] });

        const worker = fakeWorker();

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            file: root,
            logger: capturingLogger().logger,
            token: "t",
            url: "http://localhost:8787",
            withStorage: true,
        });

        expect(result.code).toBe(0);

        const byName = (a: string, b: string) => a.localeCompare(b);

        expect(worker.uploads.toSorted(byName)).toStrictEqual([avatarHash, coverHash].toSorted(byName));
        expect(worker.bucket.get(avatarHash)?.bytes).toBe("avatar-bytes");
        expect(worker.imported.find((row) => row.table === "users")?.doc).toStrictEqual({ _id: "u1", avatarId: avatarHash });
        expect(worker.imported.find((row) => row.table === "posts")?.doc).toStrictEqual({ _id: "p1", cover: coverHash, title: "hello" });
    });

    it("stops telling the operator to upload blobs by hand once it has uploaded them", async () => {
        expect.assertions(2);

        const root = writeConvexExport({ kg_a: "bytes" }, { files: [{ _id: "f1", blob: { $storage: "kg_a" } }] });
        const migrated = capturingLogger();

        await runImportCommand({
            cwd: workDir,
            fetchImpl: fakeWorker().fetchImpl,
            file: root,
            logger: migrated.logger,
            token: "t",
            url: "http://localhost:8787",
            withStorage: true,
        });

        const skipped = capturingLogger();

        await runImportCommand({
            cwd: workDir,
            fetchImpl: fakeWorker().fetchImpl,
            file: root,
            logger: skipped.logger,
            token: "t",
            url: "http://localhost:8787",
        });

        expect(migrated.logs.warn.join("\n")).not.toContain("_storage");
        expect(skipped.logs.warn.join("\n")).toContain("Re-run with --with-storage");
    });

    it("accepts a base64 `sha256` from the export and still keys by hex", async () => {
        expect.assertions(2);

        const root = writeConvexExport({ kg_a: "some-bytes" }, { files: [{ _id: "f1", blob: { $storage: "kg_a" } }] }, "base64");
        const worker = fakeWorker();

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            file: root,
            logger: capturingLogger().logger,
            token: "t",
            url: "http://localhost:8787",
            withStorage: true,
        });

        expect(result.code).toBe(0);
        expect(worker.uploads).toStrictEqual([sha256Hex("some-bytes")]);
    });

    it("rewrites storage references nested in objects and arrays", async () => {
        expect.assertions(1);

        const hash = sha256Hex("attachment");
        const root = writeConvexExport(
            { kg_a: "attachment" },
            { posts: [{ _id: "p1", attachments: [{ $storage: "kg_a" }], meta: { hero: { $storage: "kg_a" } } }] },
        );
        const worker = fakeWorker();

        await runImportCommand({
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            file: root,
            logger: capturingLogger().logger,
            token: "t",
            url: "http://localhost:8787",
            withStorage: true,
        });

        expect(worker.imported[0]?.doc).toStrictEqual({ _id: "p1", attachments: [hash], meta: { hero: hash } });
    });

    it("rewrites plain strings nested under a mapped column", async () => {
        expect.assertions(1);

        const hash = sha256Hex("bytes");
        const root = writeConvexExport({ kg_a: "bytes" }, { posts: [{ _id: "p1", meta: { gallery: ["kg_a"], hero: "kg_a" } }] });

        // `storageColumns` cannot address `meta.hero`, so the top-level column
        // has to cover everything beneath it — otherwise the operator would be
        // told about a reference they have no way to map.
        writeMapping({ posts: ["meta"] });

        const worker = fakeWorker();

        await runImportCommand({
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            file: root,
            logger: capturingLogger().logger,
            token: "t",
            url: "http://localhost:8787",
            withStorage: true,
        });

        expect(worker.imported[0]?.doc).toStrictEqual({ _id: "p1", meta: { gallery: [hash], hero: hash } });
    });

    it("warns about an unmapped storage-id column without failing --verify — the blob did migrate", async () => {
        expect.assertions(3);

        const root = writeConvexExport({ kg_a: "bytes" }, { users: [{ _id: "u1", avatarId: "kg_a" }] });

        // Mapping present but silent about `avatarId` — the string stays put.
        writeMapping({ posts: ["cover"] });

        const worker = fakeWorker();
        const { logger, logs } = capturingLogger();

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            file: root,
            logger,
            token: "t",
            url: "http://localhost:8787",
            verify: true,
            withStorage: true,
        });

        expect(result.code).toBe(0);
        expect(worker.imported[0]?.doc).toStrictEqual({ _id: "u1", avatarId: "kg_a" });
        expect(logs.warn.some((line) => line.includes("unrewritten storage id in users.avatarId: kg_a"))).toBe(true);
    });

    it("fails --verify when a reference has no exported blob at all", async () => {
        expect.assertions(3);

        // `kg_missing` is referenced but absent from `_storage` — the export was
        // taken without `--include-file-storage`, or the blob was deleted. No
        // mapping can fix that, so it is a hard failure rather than a warning.
        const root = writeConvexExport({ kg_a: "bytes" }, { posts: [{ _id: "p1", cover: { $storage: "kg_missing" } }] });
        const worker = fakeWorker();
        const { logger, logs } = capturingLogger();

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            file: root,
            logger,
            token: "t",
            url: "http://localhost:8787",
            verify: true,
            withStorage: true,
        });

        expect(result.code).toBe(1);
        expect(logs.warn.some((line) => line.includes("unmigrated storage reference posts.cover: kg_missing"))).toBe(true);
        expect(logs.error.some((line) => line.includes("resolved to no migrated blob"))).toBe(true);
    });

    it("leaves plain strings alone when there is no mapping file", async () => {
        expect.assertions(2);

        const root = writeConvexExport({ kg_a: "bytes" }, { users: [{ _id: "u1", avatarId: "kg_a" }] });
        const worker = fakeWorker();

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            file: root,
            logger: capturingLogger().logger,
            token: "t",
            url: "http://localhost:8787",
            verify: true,
            withStorage: true,
        });

        // No mapping means no plain-string rewriting — the same rule the docs and
        // the "run --scan" message state. It must not silently rewrite instead.
        expect(result.code).toBe(0);
        expect(worker.imported[0]?.doc).toStrictEqual({ _id: "u1", avatarId: "kg_a" });
    });

    it("skips blobs already present at the same key on a re-run", async () => {
        expect.assertions(2);

        const root = writeConvexExport({ kg_a: "bytes" }, { files: [{ _id: "f1", blob: { $storage: "kg_a" } }] });
        const worker = fakeWorker();
        const run = async () =>
            runImportCommand({
                cwd: workDir,
                fetchImpl: worker.fetchImpl,
                file: root,
                logger: capturingLogger().logger,
                token: "t",
                url: "http://localhost:8787",
                withStorage: true,
            });

        await run();
        await run();

        expect(worker.uploads).toHaveLength(1);
        expect(worker.bucket.size).toBe(1);
    });

    it("applies the mapping file's keyPrefix to every uploaded blob", async () => {
        expect.assertions(1);

        const root = writeConvexExport({ kg_a: "bytes" }, { files: [{ _id: "f1", blob: { $storage: "kg_a" } }] });

        writeMapping({}, "convex/");

        const worker = fakeWorker();

        await runImportCommand({
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            file: root,
            logger: capturingLogger().logger,
            token: "t",
            url: "http://localhost:8787",
            withStorage: true,
        });

        expect(worker.uploads).toStrictEqual([`convex/${sha256Hex("bytes")}`]);
    });

    it("fails when the blob on disk does not weigh what the export declares", async () => {
        expect.assertions(1);

        const root = writeConvexExport({ kg_a: "bytes" }, { files: [{ _id: "f1" }] });

        writeFileSync(join(root, "_storage", "kg_a"), "truncated", "utf8");

        const worker = fakeWorker();

        await expect(
            runImportCommand({
                cwd: workDir,
                fetchImpl: worker.fetchImpl,
                file: root,
                logger: capturingLogger().logger,
                token: "t",
                url: "http://localhost:8787",
                withStorage: true,
            }),
        ).rejects.toThrow(/bytes on disk but the export declares/);
    });

    it("refuses a `_storage` id that escapes the snapshot directory", async () => {
        expect.assertions(1);

        const root = writeConvexExport({ kg_a: "bytes" }, { files: [{ _id: "f1" }] });

        writeFileSync(
            join(root, "_storage", "documents.jsonl"),
            `${JSON.stringify({ _id: "../../escape", contentType: "text/plain", sha256: sha256Hex("bytes"), size: 5 })}\n`,
            "utf8",
        );

        await expect(
            runImportCommand({
                cwd: workDir,
                fetchImpl: fakeWorker().fetchImpl,
                file: root,
                logger: capturingLogger().logger,
                token: "t",
                url: "http://localhost:8787",
                withStorage: true,
            }),
        ).rejects.toThrow(/path-free/);
    });

    it("refuses to fall back to auto-detection when the mapping file is malformed", async () => {
        expect.assertions(1);

        const root = writeConvexExport({ kg_a: "bytes" }, { files: [{ _id: "f1" }] });

        mkdirSync(join(workDir, "lunora"), { recursive: true });
        writeFileSync(join(workDir, "lunora", "import-convex.json"), "{ not json", "utf8");

        await expect(
            runImportCommand({
                cwd: workDir,
                fetchImpl: fakeWorker().fetchImpl,
                file: root,
                logger: capturingLogger().logger,
                token: "t",
                url: "http://localhost:8787",
                withStorage: true,
            }),
        ).rejects.toThrow(/invalid JSON/);
    });

    it("rejects a mapping whose storageColumns are not column-name arrays", async () => {
        expect.assertions(1);

        const root = writeConvexExport({ kg_a: "bytes" }, { files: [{ _id: "f1" }] });

        mkdirSync(join(workDir, "lunora"), { recursive: true });
        writeFileSync(join(workDir, "lunora", "import-convex.json"), JSON.stringify({ storageColumns: { users: "avatarId" } }), "utf8");

        await expect(
            runImportCommand({
                cwd: workDir,
                fetchImpl: fakeWorker().fetchImpl,
                file: root,
                logger: capturingLogger().logger,
                token: "t",
                url: "http://localhost:8787",
                withStorage: true,
            }),
        ).rejects.toThrow(/must be an array of column names/);
    });

    describe("blobs above the verified-upload cap", () => {
        // The verified route caps at 32 MiB; anything larger takes a signed PUT
        // straight at the bucket and is checked after the fact instead.
        const LARGE = "x".repeat(33 * 1_048_576);

        it("uploads through a signed PUT and verifies what landed", async () => {
            expect.assertions(3);

            const root = writeConvexExport({ kg_big: LARGE }, { files: [{ _id: "f1", blob: { $storage: "kg_big" } }] });
            const worker = fakeWorker();

            const result = await runImportCommand({
                cwd: workDir,
                fetchImpl: worker.fetchImpl,
                file: root,
                logger: capturingLogger().logger,
                token: "t",
                url: "http://localhost:8787",
                withStorage: true,
            });

            expect(result.code).toBe(0);
            expect(worker.signedPuts).toStrictEqual([sha256Hex(LARGE)]);
            // Never through the buffering route — that request would 413.
            expect(worker.uploads).toStrictEqual([]);
        });

        it("deletes the object and fails when what landed does not match", async () => {
            expect.assertions(3);

            const root = writeConvexExport({ kg_big: LARGE }, { files: [{ _id: "f1" }] });
            const worker = fakeWorker();
            const key = sha256Hex(LARGE);

            // A bucket that truncates the write: the signed PUT succeeds, but the
            // object that lands is the wrong size. Left in place it would be
            // treated as already-migrated by every later run.
            const lyingFetch: StreamingFetchLike = async (input, init) => {
                const response = await worker.fetchImpl(input, init);

                if (new URL(input).hostname === "cdn.test") {
                    worker.bucket.set(key, { bytes: "short", sha256: sha256Hex("short"), size: 5 });
                }

                return response;
            };

            await expect(
                runImportCommand({
                    cwd: workDir,
                    fetchImpl: lyingFetch,
                    file: root,
                    logger: capturingLogger().logger,
                    token: "t",
                    url: "http://localhost:8787",
                    withStorage: true,
                }),
            ).rejects.toThrow(/post-upload verification failed/);

            expect(worker.deleted).toStrictEqual([key]);
            expect(worker.bucket.has(key)).toBe(false);
        });
    });

    it("follows the list cursor when the bucket pages", async () => {
        expect.assertions(2);

        const root = writeConvexExport({ kg_a: "a-bytes", kg_b: "b-bytes", kg_c: "c-bytes" }, { files: [{ _id: "f1", blob: { $storage: "kg_c" } }] });
        const worker = fakeWorker();

        // Seed all three blobs, then force one object per page: a reader that
        // stops at the first page would re-upload the other two.
        for (const content of ["a-bytes", "b-bytes", "c-bytes"]) {
            worker.bucket.set(sha256Hex(content), { bytes: content, sha256: sha256Hex(content), size: content.length });
        }

        worker.listPageSize = 1;

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            file: root,
            logger: capturingLogger().logger,
            token: "t",
            url: "http://localhost:8787",
            withStorage: true,
        });

        expect(result.code).toBe(0);
        expect(worker.uploads).toStrictEqual([]);
    });

    it("rejects --verify on an export with blobs unless --with-storage is set", async () => {
        expect.assertions(2);

        const root = writeConvexExport({ kg_a: "bytes" }, { files: [{ _id: "f1", blob: { $storage: "kg_a" } }] });
        const worker = fakeWorker();
        const { logger, logs } = capturingLogger();

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            file: root,
            logger,
            token: "t",
            url: "http://localhost:8787",
            verify: true,
        });

        expect(result.code).toBe(1);
        expect(logs.error.join("\n")).toContain("requires --with-storage");
    });

    it("keeps a large blob whose listing omits size rather than deleting it", async () => {
        expect.assertions(4);

        const large = "q".repeat(33 * 1_048_576);
        const root = writeConvexExport({ kg_big: large }, { files: [{ _id: "f1", blob: { $storage: "kg_big" } }] });
        const worker = fakeWorker();
        const key = sha256Hex(large);

        // A host that lists objects without size or sha256 — absent means "not
        // reported", not "does not match", so the upload must stand.
        const terseFetch: StreamingFetchLike = async (input, init) => {
            const url = new URL(input);

            if (url.pathname === "/_lunora/admin/storage" && (init?.method ?? "GET") === "GET") {
                const listed = [...worker.bucket.keys()].filter((entry) => entry.startsWith(url.searchParams.get("prefix") ?? ""));

                return {
                    body: null,
                    json: async () => {
                        return {
                            objects: listed.map((entry) => {
                                return { key: entry };
                            }),
                            truncated: false,
                        };
                    },
                    ok: true,
                    status: 200,
                    text: async () => "",
                };
            }

            return worker.fetchImpl(input, init);
        };

        const { logger, logs } = capturingLogger();

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: terseFetch,
            file: root,
            logger,
            token: "t",
            url: "http://localhost:8787",
            withStorage: true,
        });

        expect(result.code).toBe(0);
        expect(worker.deleted).toStrictEqual([]);
        expect(logs.warn.join("\n")).toContain(`no size or sha256 for it`);

        expect(worker.bucket.has(key)).toBe(true);
    });

    it("migrates blobs out of a .zip snapshot the same way", async () => {
        expect.assertions(2);

        const root = writeConvexExport({ kg_a: "zip-bytes" }, { files: [{ _id: "f1", blob: { $storage: "kg_a" } }] });
        const zipPath = join(workDir, "snapshot.zip");
        const zip = new AdmZip();

        zip.addLocalFolder(root, "snapshot_1");
        zip.writeZip(zipPath);

        const worker = fakeWorker();

        const result = await runImportCommand({
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            file: zipPath,
            logger: capturingLogger().logger,
            token: "t",
            url: "http://localhost:8787",
            withStorage: true,
        });

        expect(result.code).toBe(0);
        expect(worker.imported[0]?.doc).toStrictEqual({ _id: "f1", blob: sha256Hex("zip-bytes") });
    });

    describe("flag guards", () => {
        it.each(["scan", "verify", "withStorage"] as const)("rejects --%s against a plain NDJSON source", async (flag) => {
            expect.assertions(3);

            const file = join(workDir, "in.ndjson");

            writeFileSync(file, `${JSON.stringify({ doc: { _id: "u1" }, table: "users" })}\n`, "utf8");

            const worker = fakeWorker();
            const { logger, logs } = capturingLogger();

            const result = await runImportCommand({
                cwd: workDir,
                fetchImpl: worker.fetchImpl,
                file,
                logger,
                token: "t",
                url: "http://localhost:8787",
                [flag]: true,
            });

            expect(result.code).toBe(1);
            expect(worker.imported).toHaveLength(0);
            expect(logs.error.join("\n")).toContain("requires a Convex export directory");
        });
    });

    describe("the storage-remap report", () => {
        /**
         * An unmapped import — no `import-convex.json` — leaves every plain-string
         * storage id unrewritten, so a wholly-unmigrated run reports one entry PER
         * OCCURRENCE. The display list dedups and caps at 20 while the count and the
         * printed JSON body used the raw array, so the summary said "N ambiguous",
         * listed a handful, and then buried itself under the full array — the exact
         * outcome the cap exists to prevent.
         */
        const unmappedRun = async () => {
            // 30 rows, all pointing at the same id in the same column: one distinct
            // (table, column, storageId) triple, thirty occurrences.
            const rows = Array.from({ length: 30 }, (_, index) => {
                return { _id: `u${String(index)}`, avatarId: "kg_a" };
            });
            const root = writeConvexExport({ kg_a: "bytes" }, { users: rows });
            const { logger, logs } = capturingLogger();

            const result = await runImportCommand({
                cwd: workDir,
                fetchImpl: fakeWorker().fetchImpl,
                file: root,
                logger,
                token: "t",
                url: "http://localhost:8787",
                withStorage: true,
            });

            return { logs, result };
        };

        it("counts distinct references, matching the list it prints", async () => {
            expect.assertions(1);

            const { result } = await unmappedRun();

            expect(result.body?.storage?.ambiguousTotal).toBe(1);
        });

        it("caps the references carried in the printed body", async () => {
            expect.assertions(2);

            // Rewritten as 25 DISTINCT columns so the dedup cannot do the capping.
            const row: Record<string, unknown> = { _id: "u0" };

            for (let index = 0; index < 25; index += 1) {
                row[`avatar${String(index)}`] = "kg_a";
            }

            const root = writeConvexExport({ kg_a: "bytes" }, { users: [row] });

            const result = await runImportCommand({
                cwd: workDir,
                fetchImpl: fakeWorker().fetchImpl,
                file: root,
                logger: capturingLogger().logger,
                token: "t",
                url: "http://localhost:8787",
                withStorage: true,
            });

            expect(result.body?.storage?.ambiguousTotal).toBe(25);
            // The body carries a sample, not the whole array — a 200k-row import
            // otherwise emitted a ~20 MB blob through one `logger.info`.
            expect(result.body?.storage?.ambiguous).toHaveLength(20);
        });
    });

    describe("--scan", () => {
        it("writes the candidate mapping and imports nothing", async () => {
            expect.assertions(3);

            const root = writeConvexExport({ kg_a: "bytes" }, { posts: [{ _id: "p1", body: "just text" }], users: [{ _id: "u1", avatarId: "kg_a" }] });
            const worker = fakeWorker();

            const result = await runImportCommand({
                cwd: workDir,
                fetchImpl: worker.fetchImpl,
                file: root,
                logger: capturingLogger().logger,
                scan: true,
                token: "t",
                url: "http://localhost:8787",
            });

            expect(result.code).toBe(0);
            expect(worker.imported).toHaveLength(0);
            expect(JSON.parse(readFileSync(join(workDir, "lunora", "import-convex.json"), "utf8"))).toStrictEqual({
                keyPrefix: "",
                storageColumns: { users: ["avatarId"] },
            });
        });

        it("proposes a column whose storage id is nested, matching what the rewrite does", async () => {
            expect.assertions(1);

            const root = writeConvexExport(
                { kg_a: "bytes" },
                {
                    // `meta.hero` is rewritten once `meta` is mapped, so the scan
                    // has to propose `meta` — otherwise the operator is told the
                    // reference is ambiguous with no column to add for it.
                    // `cover` holds the self-describing form, which needs no entry.
                    posts: [{ _id: "p1", cover: { $storage: "kg_a" }, meta: { hero: "kg_a" } }],
                },
            );

            await runImportCommand({
                cwd: workDir,
                fetchImpl: fakeWorker().fetchImpl,
                file: root,
                logger: capturingLogger().logger,
                scan: true,
                token: "t",
                url: "http://localhost:8787",
            });

            expect(JSON.parse(readFileSync(join(workDir, "lunora", "import-convex.json"), "utf8")).storageColumns).toStrictEqual({ posts: ["meta"] });
        });

        it("never overwrites an existing mapping file", async () => {
            expect.assertions(1);

            const root = writeConvexExport({ kg_a: "bytes" }, { users: [{ _id: "u1", avatarId: "kg_a" }] });

            writeMapping({ users: ["confirmed"] });

            await runImportCommand({
                cwd: workDir,
                fetchImpl: fakeWorker().fetchImpl,
                file: root,
                logger: capturingLogger().logger,
                scan: true,
                token: "t",
                url: "http://localhost:8787",
            });

            expect(JSON.parse(readFileSync(join(workDir, "lunora", "import-convex.json"), "utf8")).storageColumns).toStrictEqual({ users: ["confirmed"] });
        });

        it("runs without an admin token — inspecting an export needs no target worker", async () => {
            expect.assertions(1);

            const root = writeConvexExport({ kg_a: "bytes" }, { users: [{ _id: "u1", avatarId: "kg_a" }] });
            const previous = process.env["LUNORA_ADMIN_TOKEN"];

            delete process.env["LUNORA_ADMIN_TOKEN"];

            try {
                const result = await runImportCommand({ cwd: workDir, file: root, logger: capturingLogger().logger, scan: true });

                expect(result.code).toBe(0);
            } finally {
                if (previous !== undefined) {
                    process.env["LUNORA_ADMIN_TOKEN"] = previous;
                }
            }
        });

        it("fails when the export carries no `_storage` table", async () => {
            expect.assertions(1);

            const root = join(workDir, "no-storage");

            mkdirSync(join(root, "users"), { recursive: true });
            writeFileSync(join(root, "users", "documents.jsonl"), `${JSON.stringify({ _id: "u1" })}\n`, "utf8");

            const result = await runImportCommand({
                cwd: workDir,
                fetchImpl: fakeWorker().fetchImpl,
                file: root,
                logger: capturingLogger().logger,
                scan: true,
                token: "t",
                url: "http://localhost:8787",
            });

            expect(result.code).toBe(1);
        });
    });

    describe("--verify", () => {
        it("exits non-zero when a table's inserted count misses its source rows", async () => {
            expect.assertions(2);

            const root = writeConvexExport({}, { users: [{ _id: "u1" }, { _id: "u2" }] });
            const worker = fakeWorker();

            // A worker that swallows one row per batch: parity is what catches it.
            const lossyFetch: StreamingFetchLike = async (input, init) => {
                if (new URL(input).pathname === "/_lunora/admin/import") {
                    return {
                        body: null,
                        json: async () => {
                            return { conflicts: 0, errors: [], inserted: { users: 1 }, received: 2 };
                        },
                        ok: true,
                        status: 200,
                        text: async () => "",
                    };
                }

                return worker.fetchImpl(input, init);
            };

            const { logger, logs } = capturingLogger();

            const result = await runImportCommand({
                cwd: workDir,
                fetchImpl: lossyFetch,
                file: root,
                logger,
                token: "t",
                url: "http://localhost:8787",
                verify: true,
            });

            expect(result.code).toBe(1);
            expect(logs.error.join("\n")).toContain("verify: users inserted 1 of 2 source rows");
        });

        it("refuses when the export was taken without --include-file-storage", async () => {
            expect.assertions(2);

            // No `_storage` directory at all. This used to sail through: the
            // guard keyed on the table existing, so with none present nothing
            // fired, no warning printed, and every `{ $storage }` reference
            // imported verbatim as an object resolving to nothing — under a
            // green verify line and exit 0.
            const root = join(workDir, "no-storage-dir");

            mkdirSync(join(root, "posts"), { recursive: true });
            writeFileSync(join(root, "posts", "documents.jsonl"), `${JSON.stringify({ _id: "p1", cover: { $storage: "kg_a" } })}\n`, "utf8");

            const worker = fakeWorker();
            const { logger, logs } = capturingLogger();

            const result = await runImportCommand({
                cwd: workDir,
                fetchImpl: worker.fetchImpl,
                file: root,
                logger,
                token: "t",
                url: "http://localhost:8787",
                verify: true,
            });

            expect(result.code).toBe(1);
            expect(logs.error.join("\n")).toContain("--include-file-storage");
        });

        it("reports an unresolvable id in a column the mapping declared", async () => {
            expect.assertions(3);

            // The self-describing form had a dangling check; the declared column
            // — the one the mapping file exists to serve — did not, so a blob
            // deleted between the last write and the export vanished silently.
            const root = writeConvexExport({ kg_a: "bytes" }, { users: [{ _id: "u1", avatarId: "kg_deleted" }] });

            writeMapping({ users: ["avatarId"] });

            const worker = fakeWorker();
            const { logger, logs } = capturingLogger();

            const result = await runImportCommand({
                cwd: workDir,
                fetchImpl: worker.fetchImpl,
                file: root,
                logger,
                token: "t",
                url: "http://localhost:8787",
                verify: true,
                withStorage: true,
            });

            expect(result.code).toBe(1);
            expect(worker.imported[0]?.doc["avatarId"]).toBe("kg_deleted");
            expect(logs.warn.join("\n")).toContain("unmigrated storage reference users.avatarId: kg_deleted");
        });

        it("credits conflicts toward parity, so a resume run does not fail", async () => {
            expect.assertions(2);

            // The documented way to resume is to re-run, and a re-run's rows come
            // back as conflicts rather than inserts. Counting only inserts would
            // fail `--verify` on exactly the run an operator most wants it on.
            const root = writeConvexExport({}, { users: [{ _id: "u1" }, { _id: "u2" }] });

            const conflictingFetch: StreamingFetchLike = async (input, init) => {
                if (new URL(input).pathname === "/_lunora/admin/import") {
                    return {
                        body: null,
                        json: async () => {
                            return { conflicts: 2, errors: [], inserted: {}, received: 2 };
                        },
                        ok: true,
                        status: 200,
                        text: async () => "",
                    };
                }

                return fakeWorker().fetchImpl(input, init);
            };

            const { logger, logs } = capturingLogger();

            const result = await runImportCommand({
                cwd: workDir,
                fetchImpl: conflictingFetch,
                file: root,
                logger,
                token: "t",
                url: "http://localhost:8787",
                verify: true,
            });

            expect(result.code).toBe(0);
            expect(logs.error.join("\n")).not.toContain("missing");
        });

        it("passes when every table reaches parity", async () => {
            expect.assertions(1);

            const root = writeConvexExport({}, { users: [{ _id: "u1" }, { _id: "u2" }] });

            const result = await runImportCommand({
                cwd: workDir,
                fetchImpl: fakeWorker().fetchImpl,
                file: root,
                logger: capturingLogger().logger,
                token: "t",
                url: "http://localhost:8787",
                verify: true,
            });

            expect(result.code).toBe(0);
        });
    });
});
