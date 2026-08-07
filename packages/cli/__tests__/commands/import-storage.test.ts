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
    fetchImpl: StreamingFetchLike;
    imported: { doc: Record<string, unknown>; table: string }[];
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

    const json = (value: unknown) => {
        return {
            body: null,
            json: async () => value,
            ok: true,
            status: 200,
            text: async () => JSON.stringify(value),
        };
    };

    const fetchImpl: StreamingFetchLike = async (input, init) => {
        const url = new URL(input);
        const method = init?.method ?? "GET";

        if (url.pathname === "/_lunora/admin/import") {
            const inserted: Record<string, number> = {};

            for (const line of (typeof init?.body === "string" ? init.body : "").split("\n").filter((entry) => entry.trim().length > 0)) {
                const row = JSON.parse(line) as { doc: Record<string, unknown>; table: string };

                imported.push(row);
                inserted[row.table] = (inserted[row.table] ?? 0) + 1;
            }

            return json({ conflicts: 0, errors: [], inserted, received: imported.length });
        }

        if (url.pathname === "/_lunora/admin/storage" && method === "GET") {
            const prefix = url.searchParams.get("prefix") ?? "";

            return json({
                objects: [...bucket.entries()]
                    .filter(([key]) => key.startsWith(prefix))
                    .map(([key, object_]) => {
                        return { key, sha256: object_.sha256, size: object_.size };
                    }),
                truncated: false,
            });
        }

        if (url.pathname === "/_lunora/admin/storage" && method === "PUT") {
            const key = url.searchParams.get("key") as string;
            const bytes = new TextDecoder().decode(init?.body as Uint8Array);
            const digest = sha256Hex(bytes);

            // Mirror the route: reject before writing when the body does not
            // match what the caller declared.
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
        }

        throw new Error(`unexpected request: ${method} ${input}`);
    };

    return { bucket, fetchImpl, imported, uploads };
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

    it("reports an unmapped storage-id column instead of rewriting it, and fails --verify", async () => {
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

        expect(result.code).toBe(1);
        expect(worker.imported[0]?.doc).toStrictEqual({ _id: "u1", avatarId: "kg_a" });
        expect(logs.warn.some((line) => line.includes("dangling storage reference in users: kg_a"))).toBe(true);
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
