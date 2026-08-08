import { describe, expect, it, vi } from "vitest";

import type { BackupManifest, BackupStore, ScheduledControllerLike, WorkerOptions } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { QueryCoordinator } from "../src/query-coordinator";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const ADMIN_TOKEN = "admin-bear";

const noopNamespace: ShardNamespaceLike = {
    get: () => {
        return { fetch: async () => new Response("not used", { status: 200 }) };
    },
    idFromName: (name) => {
        return { __name: name };
    },
};

type ExportRows = ReadonlyArray<{ doc: Record<string, unknown>; table: string }>;

/** A coordinator stub whose `orchestrateExport` returns the supplied shard rows; the rest throw. */
const coordinatorWithExport = (rows: ExportRows): QueryCoordinator => {
    const orchestrateExport = vi.fn<() => Promise<{ failed: number; ok: number; shards: { rows: ExportRows; shardKey: string }[] }>>(async () => {
        return { failed: 0, ok: 1, shards: [{ rows, shardKey: "__root__" }] };
    });

    return {
        fanOut: vi.fn<() => never>(),
        orchestrateApplyCdc: vi.fn<() => never>(),
        orchestrateCdcSync: vi.fn<() => never>(),
        orchestrateExport,
        orchestrateImport: vi.fn<() => never>(),
        orchestrateMigration: vi.fn<() => never>(),
        orchestrateRank: vi.fn<() => never>(),
        orchestrateRankPage: vi.fn<() => never>(),
        orchestrateShardTraffic: vi.fn<() => never>(),
        registry: {} as never,
    };
};

/** Decode any body shape `BackupStore.put` accepts, so the double never silently records an empty object. */
const bodyText = async (body: unknown): Promise<string> => {
    if (typeof body === "string") {
        return body;
    }

    if (body instanceof Blob) {
        return body.text();
    }

    if (body instanceof ReadableStream) {
        return new Response(body).text();
    }

    if (ArrayBuffer.isView(body)) {
        return new TextDecoder().decode(body);
    }

    if (body instanceof ArrayBuffer) {
        return new TextDecoder().decode(body);
    }

    throw new TypeError(`backup store double received an unsupported body: ${Object.prototype.toString.call(body)}`);
};

/** An in-memory {@link BackupStore} double that records put/delete and serves list pages. */
const memoryBackupStore = (): BackupStore & { checksums: Map<string, string>; objects: Map<string, string> } => {
    const objects = new Map<string, string>();
    const checksums = new Map<string, string>();

    const put = vi.fn<(key: string, body: unknown, putOptions?: { sha256?: ArrayBuffer | string }) => Promise<{ etag: string; key: string; size: number }>>(
        async (key, body, putOptions) => {
            const text = await bodyText(body);

            objects.set(key, text);

            // R2 records a checksum only when the writer supplies one; the
            // double keeps that distinction so a test can tell them apart.
            if (typeof putOptions?.sha256 === "string") {
                checksums.set(key, putOptions.sha256);
            }

            return { etag: "e", key, size: text.length };
        },
    );

    const list = vi.fn<(listOptions?: { cursor?: string; limit?: number; prefix?: string }) => Promise<{ objects: { key: string }[] }>>(async (listOptions) => {
        const prefix = listOptions?.prefix ?? "";
        const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).toSorted((a, b) => a.localeCompare(b));

        return {
            objects: keys.map((key) => {
                return { key };
            }),
        };
    });

    const remove = vi.fn<(key: string) => Promise<void>>(async (key) => {
        objects.delete(key);
    });

    const get = vi.fn<(key: string) => Promise<{ text: () => Promise<string> } | null>>(async (key) => {
        const stored = objects.get(key);

        return stored === undefined ? null : { text: async () => stored };
    });

    return { checksums, delete: remove, get, list, objects, put };
};

/** Lowercase-hex SHA-256 of a UTF-8 string — the same digest the runtime computes over the snapshot. */
const sha256Hex = async (text: string): Promise<string> =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const fire = async (worker: ReturnType<typeof createWorker>, controller: ScheduledControllerLike): Promise<void> => {
    await worker.scheduled(controller, {}, { passThroughOnException: () => undefined, waitUntil: () => undefined });
};

// 2026-06-03T12:00:00.000Z
const SCHEDULED_TIME = Date.UTC(2026, 5, 3, 12, 0, 0);
const BACKUP_CRON = "0 3 * * *";

describe("createWorker — scheduled backup", () => {
    it("writes an NDJSON snapshot + manifest sidecar when the backup cron fires", async () => {
        expect.assertions(6);

        const store = memoryBackupStore();
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            backupCron: BACKUP_CRON,
            backupStore: store,
            queryCoordinator: coordinatorWithExport([
                { doc: { _id: "u1", email: "a@b.com" }, table: "users" },
                { doc: { _id: "u2", email: "c@d.com" }, table: "users" },
            ]),
            shardDO: noopNamespace,
        });

        await fire(worker, { cron: BACKUP_CRON, scheduledTime: SCHEDULED_TIME });

        const ndjsonKey = "backups/lunora-backup-2026-06-03T12-00-00-000Z.ndjson";
        const manifestKey = `${ndjsonKey}.manifest.json`;

        expect(store.objects.has(ndjsonKey)).toBe(true);
        expect(store.objects.has(manifestKey)).toBe(true);

        const ndjson = store.objects.get(ndjsonKey) ?? "";
        const lines = ndjson.trim().split("\n");

        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0] ?? "")).toStrictEqual({ doc: { _id: "u1", email: "a@b.com" }, table: "users" });

        const manifest = JSON.parse(store.objects.get(manifestKey) ?? "") as BackupManifest;

        expect(manifest.rows).toBe(2);
        expect(manifest).toMatchObject({ createdAt: "2026-06-03T12:00:00.000Z", cron: BACKUP_CRON, file: ndjsonKey, scheduledTime: SCHEDULED_TIME });
    });

    it("records the snapshot's checksum on the object and in the manifest", async () => {
        expect.assertions(3);

        const store = memoryBackupStore();
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            backupCron: BACKUP_CRON,
            backupStore: store,
            queryCoordinator: coordinatorWithExport([{ doc: { _id: "u1" }, table: "users" }]),
            shardDO: noopNamespace,
        });

        await fire(worker, { cron: BACKUP_CRON, scheduledTime: SCHEDULED_TIME });

        const ndjsonKey = "backups/lunora-backup-2026-06-03T12-00-00-000Z.ndjson";
        const manifest = JSON.parse(store.objects.get(`${ndjsonKey}.manifest.json`) ?? "") as BackupManifest;
        const expected = await sha256Hex(store.objects.get(ndjsonKey) ?? "");

        // Without a recorded checksum the unattended tier is the one nobody can
        // check — `lunora backup restore --verify` would have nothing to compare
        // a cron-written snapshot against.
        expect(manifest.sha256).toBe(expected);
        // Handed to R2 as well, which verifies it on write and reports it later.
        expect(store.checksums.get(ndjsonKey)).toBe(expected);
        expect(store.checksums.has(`${ndjsonKey}.manifest.json`)).toBe(false);
    });

    it("refuses a snapshot past the size limit, mid-export, without writing anything", async () => {
        expect.assertions(4);

        const store = memoryBackupStore();
        const wide = "x".repeat(1024);
        let yielded = 0;

        // Driven through `exportGlobals`, the one branch that reaches the
        // encoder incrementally — the shard fan-out resolves its rows before
        // the first check runs, so it could not show the guard stopping
        // anything early. `yielded` is the assertion that it does: the
        // generator is abandoned well before it could produce 24 MiB.
        const exportGlobals: WorkerOptions["exportGlobals"] = async function* () {
            for (let index = 0; index < 1_000_000; index += 1) {
                yielded += 1;
                yield { doc: { _id: `p${String(index)}`, blob: wide }, table: "plans" };
            }
        };

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            backupCron: BACKUP_CRON,
            backupStore: store,
            exportGlobals,
            queryCoordinator: coordinatorWithExport([]),
            shardDO: noopNamespace,
        });

        await expect(fire(worker, { cron: BACKUP_CRON, scheduledTime: SCHEDULED_TIME })).rejects.toThrow(/past the \d+-byte limit/u);

        // Stopped as soon as the budget was exceeded, not after draining 1M rows.
        expect(yielded).toBeLessThan(30_000);
        // Nothing written, so no manifest can point at a snapshot that is not there.
        expect(store.objects.size).toBe(0);
        expect(store.put).not.toHaveBeenCalled();
    });

    it("prunes its own snapshots and leaves operator-taken ones alone", async () => {
        expect.assertions(4);

        const store = memoryBackupStore();
        // What `lunora backup create --bucket` writes: the same prefix and the
        // same sidecar suffix, deliberately, so one bucket reads as one
        // history — and with no `scheduledTime`, because no cron took it.
        const operatorKey = "backups/lunora-backup-2026-06-01T09-00-00-000Z.ndjson";

        store.objects.set(operatorKey, '{"table":"users","doc":{"_id":"u0"}}\n');
        store.objects.set(
            `${operatorKey}.manifest.json`,
            `${JSON.stringify({ bytes: 36, createdAt: "2026-06-01T09:00:00.000Z", file: operatorKey, id: "2026-06-01T09:00:00.000Z", rows: 1 })}\n`,
        );

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            backupCron: BACKUP_CRON,
            backupRetain: 1,
            backupStore: store,
            queryCoordinator: coordinatorWithExport([{ doc: { _id: "u1" }, table: "users" }]),
            shardDO: noopNamespace,
        });

        // Two cron fires with `backupRetain: 1`: the older cron snapshot goes,
        // the operator's stays. Deleting a snapshot somebody took by hand —
        // silently, from the bucket the docs recommend — is the failure mode
        // that comes with sharing the prefix.
        await fire(worker, { cron: BACKUP_CRON, scheduledTime: SCHEDULED_TIME });
        await fire(worker, { cron: BACKUP_CRON, scheduledTime: SCHEDULED_TIME + 86_400_000 });

        expect(store.objects.has(operatorKey)).toBe(true);
        expect(store.objects.has(`${operatorKey}.manifest.json`)).toBe(true);
        expect(store.objects.has("backups/lunora-backup-2026-06-03T12-00-00-000Z.ndjson")).toBe(false);
        expect(store.objects.has("backups/lunora-backup-2026-06-04T12-00-00-000Z.ndjson")).toBe(true);
    });

    it("includes `.global()` rows from exportGlobals in the snapshot", async () => {
        expect.assertions(2);

        const store = memoryBackupStore();
        const exportGlobals: WorkerOptions["exportGlobals"] = async function* () {
            yield { doc: { _id: "p1", plan: "pro" }, table: "plans" };
        };
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            backupCron: BACKUP_CRON,
            backupStore: store,
            exportGlobals,
            queryCoordinator: coordinatorWithExport([{ doc: { _id: "u1" }, table: "users" }]),
            shardDO: noopNamespace,
        });

        await fire(worker, { cron: BACKUP_CRON, scheduledTime: SCHEDULED_TIME });

        const ndjson = store.objects.get("backups/lunora-backup-2026-06-03T12-00-00-000Z.ndjson") ?? "";
        const tables = ndjson
            .trim()
            .split("\n")
            .map((line) => (JSON.parse(line) as { table: string }).table);

        expect(tables).toContain("users");
        expect(tables).toContain("plans");
    });

    it("does not back up when the firing cron differs from backupCron", async () => {
        expect.assertions(1);

        const store = memoryBackupStore();
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            backupCron: BACKUP_CRON,
            backupStore: store,
            queryCoordinator: coordinatorWithExport([{ doc: { _id: "u1" }, table: "users" }]),
            shardDO: noopNamespace,
        });

        await fire(worker, { cron: "*/5 * * * *", scheduledTime: SCHEDULED_TIME });

        expect(store.objects.size).toBe(0);
    });

    it("dispatches a registered user cron handler on a matching trigger", async () => {
        expect.assertions(2);

        const handler = vi.fn<() => Promise<void>>(async () => undefined);
        const worker = createWorker({
            crons: { "*/5 * * * *": handler },
            shardDO: noopNamespace,
        });

        await fire(worker, { cron: "*/5 * * * *", scheduledTime: SCHEDULED_TIME });

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith({ cron: "*/5 * * * *", scheduledTime: SCHEDULED_TIME }, {}, expect.anything());
    });

    it("runs both a user handler and the backup when they share the cron", async () => {
        expect.assertions(2);

        const handler = vi.fn<() => Promise<void>>(async () => undefined);
        const store = memoryBackupStore();
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            backupCron: BACKUP_CRON,
            backupStore: store,
            crons: { [BACKUP_CRON]: handler },
            queryCoordinator: coordinatorWithExport([{ doc: { _id: "u1" }, table: "users" }]),
            shardDO: noopNamespace,
        });

        await fire(worker, { cron: BACKUP_CRON, scheduledTime: SCHEDULED_TIME });

        expect(handler).toHaveBeenCalledTimes(1);
        expect(store.objects.size).toBe(2);
    });

    it("throws when the backup cron fires without an adminToken", async () => {
        expect.assertions(1);

        const store = memoryBackupStore();
        const worker = createWorker({
            backupCron: BACKUP_CRON,
            backupStore: store,
            queryCoordinator: coordinatorWithExport([{ doc: { _id: "u1" }, table: "users" }]),
            shardDO: noopNamespace,
        });

        await expect(fire(worker, { cron: BACKUP_CRON, scheduledTime: SCHEDULED_TIME })).rejects.toThrow(/adminToken/u);
    });

    it("runs the backup using env.LUNORA_ADMIN_TOKEN when no adminToken option is threaded (composed worker)", async () => {
        expect.assertions(2);

        // No `adminToken` option — the composed-worker entry doesn't thread it, so
        // the backup must fall back to `env.LUNORA_ADMIN_TOKEN` exactly as the
        // request-time admin gates do, rather than throwing BACKUP_NOT_CONFIGURED.
        const store = memoryBackupStore();
        const worker = createWorker({
            backupCron: BACKUP_CRON,
            backupStore: store,
            queryCoordinator: coordinatorWithExport([{ doc: { _id: "u1" }, table: "users" }]),
            shardDO: noopNamespace,
        });

        await worker.scheduled(
            { cron: BACKUP_CRON, scheduledTime: SCHEDULED_TIME },
            { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN },
            { passThroughOnException: () => undefined, waitUntil: () => undefined },
        );

        expect(store.objects.has("backups/lunora-backup-2026-06-03T12-00-00-000Z.ndjson")).toBe(true);
        expect(store.objects.has("backups/lunora-backup-2026-06-03T12-00-00-000Z.ndjson.manifest.json")).toBe(true);
    });

    it("prunes older snapshots beyond backupRetain", async () => {
        expect.assertions(3);

        const store = memoryBackupStore();
        // Two pre-existing snapshots already on the store (older + newer). Their
        // sidecars carry `scheduledTime`, because retention only ever removes
        // snapshots this cron took — see the operator-snapshot test below.
        const seed = (id: string, body: string): void => {
            const key = `backups/lunora-backup-${id.replaceAll(/[.:]/gu, "-")}.ndjson`;

            store.objects.set(key, body);
            store.objects.set(`${key}.manifest.json`, JSON.stringify({ cron: BACKUP_CRON, file: key, id, scheduledTime: Date.parse(id) }));
        };

        seed("2026-06-01T00:00:00.000Z", "old\n");
        seed("2026-06-02T00:00:00.000Z", "mid\n");

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            backupCron: BACKUP_CRON,
            backupRetain: 2,
            backupStore: store,
            queryCoordinator: coordinatorWithExport([{ doc: { _id: "u1" }, table: "users" }]),
            shardDO: noopNamespace,
        });

        // Firing adds a third (newest) snapshot; retain=2 must drop the oldest.
        await fire(worker, { cron: BACKUP_CRON, scheduledTime: SCHEDULED_TIME });

        expect(store.objects.has("backups/lunora-backup-2026-06-01T00-00-00-000Z.ndjson")).toBe(false);
        expect(store.objects.has("backups/lunora-backup-2026-06-02T00-00-00-000Z.ndjson")).toBe(true);
        expect(store.objects.has("backups/lunora-backup-2026-06-03T12-00-00-000Z.ndjson")).toBe(true);
    });

    it("honors a custom backupPrefix and backupTables", async () => {
        expect.assertions(2);

        const store = memoryBackupStore();
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            backupCron: BACKUP_CRON,
            backupPrefix: "snapshots/",
            backupStore: store,
            backupTables: ["users", "messages"],
            queryCoordinator: coordinatorWithExport([{ doc: { _id: "u1" }, table: "users" }]),
            shardDO: noopNamespace,
        });

        await fire(worker, { cron: BACKUP_CRON, scheduledTime: SCHEDULED_TIME });

        const manifestKey = "snapshots/lunora-backup-2026-06-03T12-00-00-000Z.ndjson.manifest.json";

        expect(store.objects.has(manifestKey)).toBe(true);

        const manifest = JSON.parse(store.objects.get(manifestKey) ?? "") as BackupManifest;

        expect(manifest.tables).toBe("users,messages");
    });
});
