/**
 * The R2 destination, held against the directory destination as the reference.
 *
 * The point of these tests is that the snapshot format does not know where it
 * is going: the same export must produce the same bytes and restore the same
 * rows through either destination — including a `v.bigint()` and a `v.bytes()`
 * column, the two types that a naive `Response.json()` on the admin export path
 * would throw on and silently flatten to `{}` respectively.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { decodeWire, encodeWire } from "../../../../shared/wire-codec";
import { runBackupCommand } from "../../src/commands/backup/handler";
import { temporaryFileName } from "../../src/commands/backup/r2-destination";
import type { StreamingFetchLike } from "../../src/commands/data-transfer";
import type { Logger } from "../../src/util/logger";

const capturingLogger = (): { logger: Logger; logs: string[] } => {
    const logs: string[] = [];

    return {
        logger: {
            error: (message) => logs.push(`error: ${message}`),
            info: (message) => logs.push(`info: ${message}`),
            success: (message) => logs.push(`success: ${message}`),
            warn: (message) => logs.push(`warn: ${message}`),
        },
        logs,
    };
};

/** The two types plan 265 proved a decoded-JSON export corrupts, plus an ordinary field. */
const BIG = 9_007_199_254_740_993n;
const BYTES = new Uint8Array([0, 1, 2, 253, 254, 255]);

const DOCUMENTS = [
    { _creationTime: 1_735_689_600_000, _id: "u1", avatar: BYTES, balance: BIG, email: "a@example.com" },
    { _creationTime: 1_735_689_601_000, _id: "u2", avatar: new Uint8Array(), balance: -1n },
];

/** Exactly what the admin export endpoint streams: wire-encoded envelopes, one per line. */
const NDJSON = `${DOCUMENTS.map((document_) => JSON.stringify(encodeWire({ doc: document_, table: "users" }))).join("\n")}\n`;

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const stream = (bytes: Buffer): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array(bytes));
            controller.close();
        },
    });

const jsonResponse = (value: unknown): Awaited<ReturnType<StreamingFetchLike>> => {
    return { body: null, json: async () => value, ok: true, status: 200, text: async () => JSON.stringify(value) };
};

const errorResponse = (status: number, message: string): Awaited<ReturnType<StreamingFetchLike>> => {
    return {
        body: null,
        json: async () => {
            return { error: message };
        },
        ok: false,
        status,
        text: async () => message,
    };
};

const objectResponse = (stored: Buffer): Awaited<ReturnType<StreamingFetchLike>> => {
    return {
        body: stream(stored),
        json: async () => {
            return {};
        },
        ok: true,
        status: 200,
        text: async () => stored.toString("utf8"),
    };
};

/**
 * A worker double covering the four admin routes a bucket-backed backup uses:
 * export, import, and the storage list/upload/download trio. The "bucket" is a
 * Map, and the upload route enforces the same checksum contract the real one
 * does, so a corrupted body fails here exactly as it would in production.
 */
const createWorkerDouble = (): { bucket: Map<string, Buffer>; fetchImpl: StreamingFetchLike; imported: string[] } => {
    const bucket = new Map<string, Buffer>();
    const imported: string[] = [];

    const fetchImpl: StreamingFetchLike = async (input, init) => {
        const url = new URL(input);
        const method = init?.method ?? "GET";
        const key = url.searchParams.get("key") ?? "";

        if (url.pathname === "/_lunora/admin/export") {
            return { body: stream(Buffer.from(NDJSON, "utf8")), json: async () => undefined, ok: true, status: 200, text: async () => "" };
        }

        if (url.pathname === "/_lunora/admin/import") {
            const body = String(init?.body ?? "");

            imported.push(body);

            return jsonResponse({ inserted: { users: body.split("\n").filter(Boolean).length }, received: body.split("\n").filter(Boolean).length });
        }

        if (url.pathname === "/_lunora/admin/storage/object") {
            const stored = bucket.get(key);

            return stored === undefined ? errorResponse(404, `no object at ${key}`) : objectResponse(stored);
        }

        if (url.pathname === "/_lunora/admin/storage" && method === "GET") {
            const prefix = url.searchParams.get("prefix") ?? "";

            return jsonResponse({
                objects: [...bucket.entries()]
                    .filter(([storedKey]) => storedKey.startsWith(prefix))
                    .map(([storedKey, value]) => {
                        return { key: storedKey, sha256: sha256(value), size: value.byteLength };
                    }),
                truncated: false,
            });
        }

        if (url.pathname === "/_lunora/admin/storage" && method === "PUT") {
            const body = Buffer.from(init?.body ?? "");
            const expectedSha256 = url.searchParams.get("expectedSha256");
            const digest = sha256(body);

            // The real route digests the body and refuses to write on a
            // mismatch, before anything lands.
            if (expectedSha256 !== null && expectedSha256 !== digest) {
                return errorResponse(400, "STORAGE_CHECKSUM_MISMATCH");
            }

            bucket.set(key, body);

            return jsonResponse(expectedSha256 === null ? { key } : { key, sha256: digest });
        }

        throw new Error(`unexpected request: ${method} ${input}`);
    };

    return { bucket, fetchImpl, imported };
};

const FIXED_NOW = (): Date => new Date("2026-06-03T12:00:00.000Z");
const SNAPSHOT_KEY = "backups/lunora-backup-2026-06-03T12-00-00-000Z.ndjson";

/** Every document the import endpoint received, decoded back out of the wire form. */
const importedDocuments = (imported: ReadonlyArray<string>): unknown[] =>
    imported
        .flatMap((body) => body.split("\n"))
        .filter((line) => line.trim().length > 0)
        .map((line) => (decodeWire(JSON.parse(line)) as { doc: unknown }).doc);

let workDir: string;

describe("the local file name for a downloaded object", () => {
    // An object key comes off a `.manifest.json` in the bucket, so it is data.
    // CI runs on Linux only, and `split("/")` looks safe there while
    // `path.win32.join` walks out of the directory on Windows — so the rule is
    // exercised against both platforms' semantics explicitly.
    it.each([
        ["a plain key", "backups/lunora-backup-2026-06-03T12-00-00-000Z.ndjson", "lunora-backup-2026-06-03T12-00-00-000Z.ndjson"],
        ["a backslash traversal", String.raw`backups/..\..\evil.txt`, "evil.txt"],
        ["a forward-slash traversal", "backups/../../evil.txt", "evil.txt"],
        // `basename` strips a trailing separator and hands back the segment
        // before it, which is a perfectly good file name.
        ["a key ending in a separator", "backups/", "backups"],
        ["a key that is only a separator", "/", "snapshot.ndjson"],
        ["a dot segment", "backups/.", "snapshot.ndjson"],
        ["a parent segment", "backups/..", "snapshot.ndjson"],
    ])("stays inside the temp directory on Windows: %s", (_label, key, expected) => {
        expect.assertions(2);

        const directory = String.raw`C:\tmp\lunora`;

        expect(temporaryFileName(key, win32)).toBe(expected);
        // Whatever name comes out, joining it must not leave the directory.
        expect(win32.join(directory, temporaryFileName(key, win32)).startsWith(`${directory}${win32.sep}`)).toBe(true);
    });

    it.each([
        ["a plain key", "backups/snapshot.ndjson", "snapshot.ndjson"],
        ["a traversal", "backups/../../evil.txt", "evil.txt"],
        ["a parent segment", "backups/..", "snapshot.ndjson"],
    ])("stays inside the temp directory on POSIX: %s", (_label, key, expected) => {
        expect.assertions(2);

        const directory = "/var/lib/lunora";

        expect(temporaryFileName(key, posix)).toBe(expected);
        expect(posix.join(directory, temporaryFileName(key, posix)).startsWith(`${directory}/`)).toBe(true);
    });
});

describe("lunora backup --bucket", () => {
    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), "lunora-cli-backup-r2-"));

        return () => {
            rmSync(workDir, { force: true, recursive: true });
        };
    });

    it("writes the same snapshot to a bucket as to a directory, bigint and bytes included", async () => {
        expect.assertions(4);

        const { logger } = capturingLogger();
        const worker = createWorkerDouble();

        const toDirectory = await runBackupCommand({
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            logger,
            now: FIXED_NOW,
            subcommand: "create",
            tables: "users",
            token: "t",
            url: "http://localhost:8787",
        });

        const toBucket = await runBackupCommand({
            bucket: "default",
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            logger,
            now: FIXED_NOW,
            subcommand: "create",
            tables: "users",
            token: "t",
            url: "http://localhost:8787",
        });

        expect(toBucket.code).toBe(0);

        // One encoding, two destinations: the object in the bucket is the file
        // on disk, byte for byte.
        const onDisk = readFileSync(join(workDir, ".lunora-backups", toDirectory.entry!.file));

        expect(worker.bucket.get(SNAPSHOT_KEY)).toStrictEqual(onDisk);

        expect(toBucket.entry).toStrictEqual({ ...toDirectory.entry, file: SNAPSHOT_KEY });

        // The manifest sidecar sits beside the snapshot, in the layout the
        // platform's own scheduled backup writes.
        expect(JSON.parse(worker.bucket.get(`${SNAPSHOT_KEY}.manifest.json`)!.toString("utf8"))).toStrictEqual(toBucket.entry);
    });

    it("restores the same rows from a bucket as from a directory", async () => {
        expect.assertions(4);

        const { logger } = capturingLogger();
        const directoryWorker = createWorkerDouble();
        const bucketWorker = createWorkerDouble();

        for (const [worker, bucket] of [
            [directoryWorker, undefined],
            [bucketWorker, "default"],
        ] as const) {
            // eslint-disable-next-line no-await-in-loop -- create then restore, per destination
            await runBackupCommand({
                bucket,
                cwd: workDir,
                fetchImpl: worker.fetchImpl,
                logger,
                now: FIXED_NOW,
                subcommand: "create",
                token: "t",
                url: "http://localhost:8787",
            });

            // eslint-disable-next-line no-await-in-loop -- see above
            const restored = await runBackupCommand({
                bucket,
                cwd: workDir,
                fetchImpl: worker.fetchImpl,
                logger,
                subcommand: "restore",
                target: "2026-06-03T12:00:00.000Z",
                token: "t",
                url: "http://localhost:8787",
            });

            expect(restored.code).toBe(0);
        }

        expect(importedDocuments(bucketWorker.imported)).toStrictEqual(importedDocuments(directoryWorker.imported));

        // And what came back is the documents that went in — a bigint that
        // survived as a bigint, bytes that survived as bytes.
        expect(importedDocuments(bucketWorker.imported)).toStrictEqual(DOCUMENTS);
    });

    it("refuses to import a snapshot whose bytes no longer match the manifest (--verify)", async () => {
        expect.assertions(3);

        const { logger } = capturingLogger();
        const worker = createWorkerDouble();

        await runBackupCommand({
            bucket: "default",
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            logger,
            now: FIXED_NOW,
            subcommand: "create",
            token: "t",
            url: "http://localhost:8787",
        });

        const verified = await runBackupCommand({
            bucket: "default",
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            logger,
            subcommand: "restore",
            target: "2026-06-03T12:00:00.000Z",
            token: "t",
            url: "http://localhost:8787",
            verify: true,
        });

        expect(verified.code).toBe(0);

        // Rot one byte of the stored object behind the CLI's back.
        const corrupted = Buffer.from(worker.bucket.get(SNAPSHOT_KEY)!);

        corrupted[0] = 0x20;
        worker.bucket.set(SNAPSHOT_KEY, corrupted);

        const result = await runBackupCommand({
            bucket: "default",
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            logger,
            subcommand: "restore",
            target: "2026-06-03T12:00:00.000Z",
            token: "t",
            url: "http://localhost:8787",
            verify: true,
        });

        expect(result.code).toBe(1);
        // Nothing may be imported from a snapshot that failed verification.
        expect(worker.imported).toHaveLength(1);
    });

    it("fails the command and records no manifest when the upload is rejected", async () => {
        expect.assertions(3);

        const { logger, logs } = capturingLogger();
        const worker = createWorkerDouble();
        const truncating: StreamingFetchLike = async (input, init) => {
            const url = new URL(input);

            // A transfer that loses bytes on the way up: the worker's checksum
            // gate is what turns it into a refusal instead of a silent write.
            if (url.pathname === "/_lunora/admin/storage" && (init?.method ?? "GET") === "PUT" && url.searchParams.has("expectedSha256")) {
                return worker.fetchImpl(input, { ...init, body: (init?.body ?? "").slice(0, 5) });
            }

            return worker.fetchImpl(input, init);
        };

        const result = await runBackupCommand({
            bucket: "default",
            cwd: workDir,
            fetchImpl: truncating,
            logger,
            now: FIXED_NOW,
            subcommand: "create",
            token: "t",
            url: "http://localhost:8787",
        });

        expect(result.code).toBe(1);
        expect([...worker.bucket.keys()]).toStrictEqual([]);
        expect(logs.some((line) => line.includes("STORAGE_CHECKSUM_MISMATCH"))).toBe(true);
    });

    it("lists snapshots written before checksums existed, and refuses to claim they verify", async () => {
        expect.assertions(3);

        const { logger, logs } = capturingLogger();
        const worker = createWorkerDouble();
        const cronKey = "backups/lunora-backup-2026-06-02T03-00-00-000Z.ndjson";

        // A sidecar from a release before snapshots carried a checksum. The cron
        // writes `sha256` now (see backup-tier-parity.test.ts); what has to keep
        // working is that an older snapshot still lists, and still fails
        // `--verify` rather than passing quietly.
        worker.bucket.set(cronKey, Buffer.from(NDJSON, "utf8"));
        worker.bucket.set(
            `${cronKey}.manifest.json`,
            Buffer.from(
                `${JSON.stringify(
                    {
                        bytes: Buffer.byteLength(NDJSON),
                        createdAt: "2026-06-02T03:00:00.000Z",
                        cron: "0 3 * * *",
                        file: cronKey,
                        id: "2026-06-02T03:00:00.000Z",
                        rows: 2,
                        scheduledTime: 1_780_282_800_000,
                    },
                    undefined,
                    2,
                )}\n`,
                "utf8",
            ),
        );

        await runBackupCommand({
            bucket: "default",
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            logger,
            now: FIXED_NOW,
            subcommand: "create",
            token: "t",
            url: "http://localhost:8787",
        });

        await runBackupCommand({
            bucket: "default",
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            logger,
            subcommand: "list",
            token: "t",
            url: "http://localhost:8787",
        });

        // One history, oldest first — the cron's snapshot and the CLI's.
        expect(logs.filter((line) => line.startsWith("info: 2026-")).map((line) => line.slice(6, 30))).toStrictEqual([
            "2026-06-02T03:00:00.000Z",
            "2026-06-03T12:00:00.000Z",
        ]);

        const result = await runBackupCommand({
            bucket: "default",
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            logger,
            subcommand: "restore",
            target: "2026-06-02T03:00:00.000Z",
            token: "t",
            url: "http://localhost:8787",
            verify: true,
        });

        // Unverifiable must not read as verified.
        expect(result.code).toBe(1);
        expect(logs.some((line) => line.includes("carries no recorded checksum"))).toBe(true);
    });

    describe("destination flags that do not apply", () => {
        it("refuses --prefix without --bucket instead of silently listing the local directory", async () => {
            expect.assertions(3);

            const { logger, logs } = capturingLogger();

            // `--prefix` names a key prefix inside an R2 bucket; a local directory
            // has none. Ignored, `backup list --prefix archive/` listed
            // `.lunora-backups` and reported "no backups found" for an archive that
            // was there all along. The worker-answered verbs (`retention`/`prune`)
            // already refuse a destination flag that does not apply to them.
            const result = await runBackupCommand({
                cwd: workDir,
                logger,
                prefix: "archive/",
                subcommand: "list",
                token: "t",
                url: "http://localhost:8787",
            });

            expect(result.code).toBe(1);
            expect(logs.some((line) => line.includes("--prefix applies only to an R2 destination"))).toBe(true);
            expect(logs.some((line) => line.includes("no backups found"))).toBe(false);
        });

        it("refuses --dir alongside --bucket rather than ignoring one of them", async () => {
            expect.assertions(2);

            const { logger, logs } = capturingLogger();

            const result = await runBackupCommand({
                bucket: "default",
                cwd: workDir,
                dir: "somewhere-local",
                fetchImpl: createWorkerDouble().fetchImpl,
                logger,
                subcommand: "list",
                token: "t",
                url: "http://localhost:8787",
            });

            expect(result.code).toBe(1);
            expect(logs.some((line) => line.includes("--dir applies only to a local destination"))).toBe(true);
        });
    });
});
