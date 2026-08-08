/**
 * The two tiers that write snapshots — `lunora backup create --bucket` (this
 * package) and the platform's `backupCron` (`@lunora/runtime`) — against each
 * other, in one bucket.
 *
 * They were written separately, and nothing compared them: the cron tier
 * shipped without a checksum, so `restore --verify` refused the snapshots
 * nobody was watching being taken. That is the class of defect this file
 * exists to catch. Anything true of a hand-run snapshot has to be true of a
 * cron-run one — same manifest shape, same recorded digest, same restore, and
 * the same `v.bigint()` / `v.bytes()` fidelity.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BackupStore, QueryCoordinator, ShardNamespaceLike } from "@lunora/runtime";
import { backupObjectKey, createWorker } from "@lunora/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { decodeWire, encodeWire } from "../../../../shared/wire-codec";
import { runBackupCommand } from "../../src/commands/backup/handler";
import type { StreamingFetchLike } from "../../src/commands/data-transfer";
import type { Logger } from "../../src/util/logger";

const ADMIN_TOKEN = "admin-bear";
const CRON = "0 3 * * *";
const CRON_TIME = Date.UTC(2026, 5, 2, 3, 0, 0);
const CLI_NOW = (): Date => new Date("2026-06-03T12:00:00.000Z");

/** The two types a naive JSON export corrupts: a bigint throws, an ArrayBuffer flattens to `{}`. */
const DOCUMENTS = [
    { _creationTime: 1_735_689_600_000, _id: "u1", avatar: new Uint8Array([0, 1, 2, 253, 254, 255]), balance: 9_007_199_254_740_993n },
    { _creationTime: 1_735_689_601_000, _id: "u2", avatar: new Uint8Array(), balance: -1n },
];

/** Wire-encoded export rows — what a shard's admin `exportShard` actually returns. */
const EXPORT_ROWS = DOCUMENTS.map((document_) => encodeWire({ doc: document_, table: "users" }) as { doc: Record<string, unknown>; table: string });

const NDJSON = `${EXPORT_ROWS.map((row) => JSON.stringify(row)).join("\n")}\n`;

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

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const stream = (bytes: Buffer): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array(bytes));
            controller.close();
        },
    });

/** One bucket, shared by both writers. Keys are object keys; values are the stored bytes. */
type Bucket = Map<string, Buffer>;

const noopNamespace: ShardNamespaceLike = {
    get: () => {
        return { fetch: async () => new Response("not used", { status: 200 }) };
    },
    idFromName: (name) => {
        return { __name: name };
    },
};

/** A coordinator whose export returns {@link EXPORT_ROWS} from one shard. */
const coordinatorWithExport = (): QueryCoordinator =>
    ({
        fanOut: vi.fn<() => never>(),
        orchestrateApplyCdc: vi.fn<() => never>(),
        orchestrateCdcSync: vi.fn<() => never>(),
        orchestrateExport: vi.fn<() => Promise<{ failed: number; ok: number; shards: { rows: typeof EXPORT_ROWS; shardKey: string }[] }>>(async () => {
            return { failed: 0, ok: 1, shards: [{ rows: EXPORT_ROWS, shardKey: "__root__" }] };
        }),
        orchestrateImport: vi.fn<() => never>(),
        orchestrateMigration: vi.fn<() => never>(),
        orchestrateRank: vi.fn<() => never>(),
        orchestrateRankPage: vi.fn<() => never>(),
        orchestrateShardTraffic: vi.fn<() => never>(),
        registry: {},
    }) as unknown as QueryCoordinator;

/** The bucket, as the runtime's scheduled backup writes to it. */
const backupStoreOver = (bucket: Bucket): BackupStore => {
    return {
        delete: async (key: string) => {
            bucket.delete(key);
        },
        get: async (key: string) => {
            const stored = bucket.get(key);

            return stored === undefined ? null : { text: async () => stored.toString("utf8") };
        },
        list: async (listOptions?: { prefix?: string }) => {
            return {
                objects: [...bucket.keys()]
                    .filter((key) => key.startsWith(listOptions?.prefix ?? ""))
                    .map((key) => {
                        return { key };
                    }),
            };
        },
        put: async (key: string, body: unknown) => {
            if (typeof body === "string") {
                bucket.set(key, Buffer.from(body, "utf8"));
            } else if (ArrayBuffer.isView(body)) {
                bucket.set(key, Buffer.from(body.buffer, body.byteOffset, body.byteLength));
            } else {
                throw new TypeError("unexpected body");
            }

            return { key };
        },
    };
};

/** The same bucket, as the CLI reaches it: through the worker's admin storage routes. */
const workerDoubleOver = (bucket: Bucket): { fetchImpl: StreamingFetchLike; imported: string[]; puts: { bucket: string | undefined; key: string }[] } => {
    const imported: string[] = [];
    const puts: { bucket: string | undefined; key: string }[] = [];

    const fetchImpl: StreamingFetchLike = async (input, init) => {
        const url = new URL(input);
        const method = init?.method ?? "GET";
        const key = url.searchParams.get("key") ?? "";
        const named = url.searchParams.get("bucket") ?? undefined;
        const json = (value: unknown): Awaited<ReturnType<StreamingFetchLike>> => {
            return { body: null, json: async () => value, ok: true, status: 200, text: async () => JSON.stringify(value) };
        };

        if (url.pathname === "/_lunora/admin/export") {
            return { body: stream(Buffer.from(NDJSON, "utf8")), json: async () => undefined, ok: true, status: 200, text: async () => "" };
        }

        if (url.pathname === "/_lunora/admin/import") {
            imported.push(String(init?.body ?? ""));

            return json({ inserted: { users: DOCUMENTS.length }, received: DOCUMENTS.length });
        }

        if (url.pathname === "/_lunora/admin/storage/object") {
            const stored = bucket.get(key);

            if (stored === undefined) {
                return {
                    body: null,
                    json: async () => {
                        return {};
                    },
                    ok: false,
                    status: 404,
                    text: async () => "not found",
                };
            }

            return {
                body: stream(stored),
                json: async () => {
                    return {};
                },
                ok: true,
                status: 200,
                text: async () => stored.toString("utf8"),
            };
        }

        if (url.pathname === "/_lunora/admin/storage" && method === "GET") {
            const prefix = url.searchParams.get("prefix") ?? "";

            return json({
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
            const expected = url.searchParams.get("expectedSha256");

            if (expected !== null && expected !== sha256(body)) {
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

            puts.push({ bucket: named, key });
            bucket.set(key, body);

            return json(expected === null ? { key } : { key, sha256: sha256(body) });
        }

        throw new Error(`unexpected request: ${method} ${input}`);
    };

    return { fetchImpl, imported, puts };
};

/** Every document the import endpoint received, decoded back out of the wire form. */
const importedDocuments = (imported: ReadonlyArray<string>): unknown[] =>
    imported
        .flatMap((body) => body.split("\n"))
        .filter((line) => line.trim().length > 0)
        .map((line) => (decodeWire(JSON.parse(line)) as { doc: unknown }).doc);

/** Fire the platform's backup cron into `bucket`. */
const runScheduledBackup = async (bucket: Bucket): Promise<void> => {
    const worker = createWorker({
        adminToken: ADMIN_TOKEN,
        backupCron: CRON,
        backupStore: backupStoreOver(bucket),
        queryCoordinator: coordinatorWithExport(),
        shardDO: noopNamespace,
    });

    await worker.scheduled({ cron: CRON, scheduledTime: CRON_TIME }, {}, { passThroughOnException: () => undefined, waitUntil: () => undefined });
};

let workDir: string;

describe("backup tiers write the same thing", () => {
    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), "lunora-cli-tier-parity-"));

        return () => {
            rmSync(workDir, { force: true, recursive: true });
        };
    });

    it("records the same manifest fields whichever tier wrote the snapshot", async () => {
        expect.assertions(7);

        const bucket: Bucket = new Map();
        const worker = workerDoubleOver(bucket);
        const { logger } = capturingLogger();

        await runScheduledBackup(bucket);

        const created = await runBackupCommand({
            bucket: "default",
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            logger,
            now: CLI_NOW,
            subcommand: "create",
            token: "t",
            url: "http://localhost:8787",
        });

        const cronKey = "backups/lunora-backup-2026-06-02T03-00-00-000Z.ndjson";
        const cronManifest = JSON.parse(bucket.get(`${cronKey}.manifest.json`)!.toString("utf8")) as Record<string, unknown>;
        const cliManifest = JSON.parse(bucket.get(`${created.entry!.file}.manifest.json`)!.toString("utf8")) as Record<string, unknown>;

        // Compared as they land in the bucket, not as either writer holds them.
        // The cron tier may add trigger fields, but everything the CLI records
        // has to be there — a snapshot's provenance must not change what an
        // operator can learn about it.
        expect(Object.keys(cronManifest)).toStrictEqual(expect.arrayContaining(Object.keys(cliManifest)));

        // Same fields is not the same as same format, and `restore <id>` matches
        // on the *value* of `id`: a tier that wrote `run-42` there would pass a
        // key-presence check and be unrestorable by anything an operator can
        // read off `list`. Both ids are the ISO timestamp of the snapshot, and
        // both keys are derived from it by the shared layout helper.
        expect(cronManifest["id"]).toBe(new Date(CRON_TIME).toISOString());
        expect(cliManifest["id"]).toBe(CLI_NOW().toISOString());
        expect([cronManifest["file"], cliManifest["file"]]).toStrictEqual([
            backupObjectKey("backups/", cronManifest["id"] as string),
            backupObjectKey("backups/", cliManifest["id"] as string),
        ]);

        // Including the digest. This is the assertion that was missing while the
        // unattended tier shipped unverifiable.
        expect(cronManifest["sha256"]).toBe(sha256(bucket.get(cronKey)!));
        expect(created.entry?.sha256).toBe(sha256(bucket.get(created.entry!.file)!));

        // One bucket, one history, oldest first.
        expect([...bucket.keys()].filter((key) => key.endsWith(".ndjson")).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            cronKey,
            "backups/lunora-backup-2026-06-03T12-00-00-000Z.ndjson",
        ]);
    });

    it("restores a cron-written snapshot with --verify, bigint and bytes intact", async () => {
        expect.assertions(3);

        const bucket: Bucket = new Map();
        const worker = workerDoubleOver(bucket);
        const { logger, logs } = capturingLogger();

        await runScheduledBackup(bucket);

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

        expect(result.code).toBe(0);
        expect(logs.some((line) => line.includes("verified"))).toBe(true);

        // The bigint is still a bigint and the bytes are still bytes after a
        // round trip through the platform's own backup writer.
        expect(importedDocuments(worker.imported)).toStrictEqual(DOCUMENTS);
    });

    it("puts the snapshot and its manifest in the same bucket", async () => {
        expect.assertions(2);

        const bucket: Bucket = new Map();
        const worker = workerDoubleOver(bucket);
        const { logger } = capturingLogger();

        await runBackupCommand({
            bucket: "archive",
            cwd: workDir,
            fetchImpl: worker.fetchImpl,
            logger,
            now: CLI_NOW,
            subcommand: "create",
            token: "t",
            url: "http://localhost:8787",
        });

        // A manifest written to a different bucket than its snapshot is an index
        // pointing at an object that is not there.
        expect(worker.puts.map((put) => put.bucket)).toStrictEqual(["archive", "archive"]);
        expect(worker.puts.map((put) => put.key)).toStrictEqual([
            "backups/lunora-backup-2026-06-03T12-00-00-000Z.ndjson",
            "backups/lunora-backup-2026-06-03T12-00-00-000Z.ndjson.manifest.json",
        ]);
    });
});
