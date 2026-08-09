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

/**
 * Decode the body shapes the backup actually writes — a `Uint8Array` for the
 * snapshot, a string for the sidecar. Anything else throws rather than being
 * tolerated, so the double cannot silently record an empty object if the write
 * path changes shape.
 */
const bodyText = (body: unknown): string => {
    if (typeof body === "string") {
        return body;
    }

    if (ArrayBuffer.isView(body)) {
        return new TextDecoder().decode(body);
    }

    throw new TypeError(`backup store double received an unsupported body: ${Object.prototype.toString.call(body)}`);
};

/** An in-memory {@link BackupStore} double that records put/delete and serves list pages. */
const memoryBackupStore = (): BackupStore & {
    checksums: Map<string, string>;
    metadata: Map<string, Record<string, string>>;
    objects: Map<string, string>;
} => {
    const objects = new Map<string, string>();
    const checksums = new Map<string, string>();
    const metadata = new Map<string, Record<string, string>>();

    const put = vi.fn<
        (
            key: string,
            body: unknown,
            putOptions?: { customMetadata?: Record<string, string>; sha256?: ArrayBuffer | string },
        ) => Promise<{ etag: string; key: string; size: number }>
    >(async (key, body, putOptions) => {
        const text = bodyText(body);

        objects.set(key, text);

        if (putOptions?.customMetadata !== undefined) {
            metadata.set(key, putOptions.customMetadata);
        }

        // R2 records a checksum only when the writer supplies one; the double
        // keeps that distinction so a test can tell them apart.
        if (typeof putOptions?.sha256 === "string") {
            checksums.set(key, putOptions.sha256);
        }

        return { etag: "e", key, size: text.length };
    });

    const list = vi.fn<
        (listOptions?: {
            cursor?: string;
            include?: ("customMetadata" | "httpMetadata")[];
            limit?: number;
            prefix?: string;
        }) => Promise<{ objects: { customMetadata?: Record<string, string>; key: string }[] }>
    >(async (listOptions) => {
        const prefix = listOptions?.prefix ?? "";
        const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).toSorted((a, b) => a.localeCompare(b));
        // R2 returns custom metadata on a listing only when it is asked for.
        const withMetadata = listOptions?.include?.includes("customMetadata") ?? false;

        return {
            objects: keys.map((key) => {
                const custom = withMetadata ? metadata.get(key) : undefined;

                return custom === undefined ? { key } : { customMetadata: custom, key };
            }),
        };
    });

    const remove = vi.fn<(key: string) => Promise<void>>(async (key) => {
        objects.delete(key);
    });

    return { checksums, delete: remove, list, metadata, objects, put };
};

/** Lowercase-hex SHA-256 of a UTF-8 string — the same digest the runtime computes over the snapshot. */
const sha256Hex = async (text: string): Promise<string> =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** The execution context `fetch` needs; nothing under test uses either hook. */
const fakeContext = { passThroughOnException: () => undefined, waitUntil: () => undefined };

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

    /** `POST /_lunora/admin/backup/prune` — the only thing that deletes a backup. */
    const pruneVia = async (worker: ReturnType<typeof createWorker>): Promise<{ deleted: string[] }> => {
        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/backup/prune", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);

        return response.json();
    };

    it("prunes its own snapshots and leaves operator-taken ones alone", async () => {
        expect.assertions(5);

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

        // Two fires build the history, then a prune applies retention. The
        // operator's snapshot stays: deleting one somebody took by hand —
        // from the bucket the docs recommend — is the failure mode that comes
        // with sharing the prefix.
        await fire(worker, { cron: BACKUP_CRON, scheduledTime: SCHEDULED_TIME });
        await fire(worker, { cron: BACKUP_CRON, scheduledTime: SCHEDULED_TIME + 86_400_000 });
        await pruneVia(worker);

        expect(store.objects.has(operatorKey)).toBe(true);
        expect(store.objects.has(`${operatorKey}.manifest.json`)).toBe(true);
        expect(store.objects.has("backups/lunora-backup-2026-06-03T12-00-00-000Z.ndjson")).toBe(false);
        expect(store.objects.has("backups/lunora-backup-2026-06-04T12-00-00-000Z.ndjson")).toBe(true);
    });

    it("leaves another deployment's snapshots alone, and costs no per-object reads", async () => {
        expect.assertions(5);

        const store = memoryBackupStore();
        // A second worker backing up into the same bucket and prefix, on its own
        // schedule. "Written by a cron" is not a narrow enough test: pruning on
        // that would have each deployment deleting the other's snapshots, and
        // both quietly getting half the retention they configured.
        const otherKey = "backups/lunora-backup-2026-06-01T09-30-00-000Z.ndjson";

        store.objects.set(otherKey, "other\n");
        store.objects.set(`${otherKey}.manifest.json`, JSON.stringify({ cron: "*/30 * * * *", file: otherKey, id: "2026-06-01T09:30:00.000Z" }));
        store.metadata.set(`${otherKey}.manifest.json`, { lunoraBackupCron: "*/30 * * * *" });

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            backupCron: BACKUP_CRON,
            backupRetain: 1,
            backupStore: store,
            queryCoordinator: coordinatorWithExport([{ doc: { _id: "u1" }, table: "users" }]),
            shardDO: noopNamespace,
        });

        await fire(worker, { cron: BACKUP_CRON, scheduledTime: SCHEDULED_TIME });
        await fire(worker, { cron: BACKUP_CRON, scheduledTime: SCHEDULED_TIME + 86_400_000 });
        await pruneVia(worker);

        expect(store.objects.has(otherKey)).toBe(true);
        expect(store.objects.has(`${otherKey}.manifest.json`)).toBe(true);
        // Its own older snapshot still goes.
        expect(store.objects.has("backups/lunora-backup-2026-06-03T12-00-00-000Z.ndjson")).toBe(false);

        // The writer check rides on the listing. A read per sidecar would scale
        // with the whole bucket and burn the Worker subrequest budget.
        expect(vi.mocked(store.list).mock.calls.every(([listOptions]) => listOptions?.include?.includes("customMetadata") === true)).toBe(true);
    });

    it("reports a successful backup even when the retention report fails", async () => {
        expect.assertions(3);

        const store = memoryBackupStore();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        vi.mocked(store.list).mockRejectedValue(new Error("R2 unavailable"));
        store.objects.set("backups/lunora-backup-2026-06-01T00-00-00-000Z.ndjson", "old\n");
        store.objects.set("backups/lunora-backup-2026-06-01T00-00-00-000Z.ndjson.manifest.json", "{}");
        store.metadata.set("backups/lunora-backup-2026-06-01T00-00-00-000Z.ndjson.manifest.json", { lunoraBackupCron: BACKUP_CRON });

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            backupCron: BACKUP_CRON,
            backupRetain: 1,
            backupStore: store,
            queryCoordinator: coordinatorWithExport([{ doc: { _id: "u1" }, table: "users" }]),
            shardDO: noopNamespace,
        });

        // The snapshot and its manifest have both landed before the retention
        // report runs. Failing the invocation here would show an operator a
        // broken backup cron over a backup that is fine.
        await expect(fire(worker, { cron: BACKUP_CRON, scheduledTime: SCHEDULED_TIME })).resolves.toBeUndefined();

        expect(store.objects.has("backups/lunora-backup-2026-06-03T12-00-00-000Z.ndjson")).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("retention report failed"), expect.anything());

        warn.mockRestore();
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
        expect.assertions(4);

        const store = memoryBackupStore();
        // Two pre-existing snapshots already on the store (older + newer). Their
        // sidecars carry `scheduledTime`, because retention only ever removes
        // snapshots this cron took — see the operator-snapshot test above.
        const seed = (id: string, body: string): void => {
            const key = `backups/lunora-backup-${id.replaceAll(/[.:]/gu, "-")}.ndjson`;

            store.objects.set(key, body);
            store.objects.set(`${key}.manifest.json`, JSON.stringify({ cron: BACKUP_CRON, file: key, id, scheduledTime: Date.parse(id) }));
            store.metadata.set(`${key}.manifest.json`, { lunoraBackupCron: BACKUP_CRON });
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

        // Firing adds a third (newest) snapshot; a prune with retain=2 must
        // then drop the oldest.
        await fire(worker, { cron: BACKUP_CRON, scheduledTime: SCHEDULED_TIME });
        await pruneVia(worker);

        expect(store.objects.has("backups/lunora-backup-2026-06-01T00-00-00-000Z.ndjson")).toBe(false);
        expect(store.objects.has("backups/lunora-backup-2026-06-02T00-00-00-000Z.ndjson")).toBe(true);
        expect(store.objects.has("backups/lunora-backup-2026-06-03T12-00-00-000Z.ndjson")).toBe(true);
    });

    /**
     * One bucket, seeded with every case that makes eligibility subtle, read
     * two ways: the preview route, and a real cron fire. If those can ever
     * disagree, the preview is worse than nothing — an operator would plan
     * around an answer the prune does not honour.
     */
    const seedMixedBucket = (store: ReturnType<typeof memoryBackupStore>): void => {
        const seed = (id: string, marker: string | undefined): string => {
            const key = `backups/lunora-backup-${id.replaceAll(/[.:]/gu, "-")}.ndjson`;

            store.objects.set(key, "rows\n");
            store.objects.set(`${key}.manifest.json`, JSON.stringify({ file: key, id }));

            if (marker !== undefined) {
                store.metadata.set(`${key}.manifest.json`, { lunoraBackupCron: marker });
            }

            return key;
        };

        // Ours, oldest first. The last one is keyed at SCHEDULED_TIME, which is
        // the key the fire itself writes — so the fire overwrites it rather than
        // adding a snapshot, and the prune sees exactly the population the
        // preview saw. Without that the two would be answering about different
        // buckets, and an equal/unequal result would mean nothing.
        seed("2026-06-01T03:00:00.000Z", BACKUP_CRON);
        seed("2026-06-02T03:00:00.000Z", BACKUP_CRON);
        seed(new Date(SCHEDULED_TIME).toISOString(), BACKUP_CRON);
        // A legacy sidecar: written before the marker existed, indistinguishable
        // from an operator's, so never eligible.
        seed("2026-05-01T03:00:00.000Z", undefined);
        // Another deployment backing up into the same bucket.
        seed("2026-05-02T09:30:00.000Z", "*/30 * * * *");
        // An operator's own snapshot, taken with `lunora backup create --bucket`.
        seed("2026-05-03T11:00:00.000Z", undefined);
    };

    const previewOf = async (store: ReturnType<typeof memoryBackupStore>): Promise<{ eligible: number; keep: number; wouldDelete: string[] }> => {
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            backupCron: BACKUP_CRON,
            backupRetain: 1,
            backupStore: store,
            queryCoordinator: coordinatorWithExport([{ doc: { _id: "u1" }, table: "users" }]),
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/backup/retention", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);

        return response.json();
    };

    it("previews exactly what the prune then deletes", async () => {
        expect.assertions(9);

        const previewStore = memoryBackupStore();
        const pruneStore = memoryBackupStore();

        seedMixedBucket(previewStore);
        seedMixedBucket(pruneStore);

        const preview = await previewOf(previewStore);

        // The preview must not have touched anything.
        expect([...previewStore.objects.keys()].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(
            [...pruneStore.objects.keys()].toSorted((a, b) => a.localeCompare(b)),
        );

        const before = new Set(pruneStore.objects.keys());
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            backupCron: BACKUP_CRON,
            backupRetain: 1,
            backupStore: pruneStore,
            queryCoordinator: coordinatorWithExport([{ doc: { _id: "u1" }, table: "users" }]),
            shardDO: noopNamespace,
        });

        // A cron fire writes and removes nothing, so the prune is what applies
        // retention — the same selection, reached through the verb.
        await fire(worker, { cron: BACKUP_CRON, scheduledTime: SCHEDULED_TIME });

        const { deleted: reported } = await pruneVia(worker);

        // What the prune actually removed.
        const deleted = [...before].filter((key) => !pruneStore.objects.has(key)).filter((key) => key.endsWith(".manifest.json"));

        expect(deleted.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(preview.wouldDelete.toSorted((a, b) => a.localeCompare(b)));
        // And the worker reports back exactly what it removed.
        expect(reported.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(preview.wouldDelete.toSorted((a, b) => a.localeCompare(b)));
        // The legacy sidecar, the other deployment's, and the operator's stay.
        expect(pruneStore.objects.has("backups/lunora-backup-2026-05-01T03-00-00-000Z.ndjson")).toBe(true);

        // And the answer is the interesting one: our two older snapshots go, the
        // legacy sidecar, the other deployment's, and the operator's stay.
        expect(preview.wouldDelete).toStrictEqual([
            "backups/lunora-backup-2026-06-02T03-00-00-000Z.ndjson.manifest.json",
            "backups/lunora-backup-2026-06-01T03-00-00-000Z.ndjson.manifest.json",
        ]);
        expect(preview.eligible).toBe(3);
        expect(preview.keep).toBe(1);
    });

    it("reports what would go without removing a byte of it", async () => {
        expect.assertions(3);

        const store = memoryBackupStore();

        seedMixedBucket(store);

        const before = new Map(store.objects);
        const preview = await previewOf(store);

        expect(preview.wouldDelete.length).toBeGreaterThan(0);
        // Byte-for-byte: same keys, same contents. Nothing in this route deletes.
        expect([...store.objects.entries()]).toStrictEqual([...before.entries()]);
    });

    it("refuses the retention preview without an admin bearer, and leaks nothing", async () => {
        expect.assertions(2);

        const store = memoryBackupStore();

        seedMixedBucket(store);

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            backupCron: BACKUP_CRON,
            backupRetain: 1,
            backupStore: store,
            queryCoordinator: coordinatorWithExport([]),
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(new Request("https://app.example/_lunora/admin/backup/retention", { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(403);
        // The gate runs before the bucket is read, so the body cannot carry an
        // object key.
        await expect(response.text()).resolves.not.toContain("lunora-backup-");
    });

    it("reports an empty selection when retention is not configured", async () => {
        expect.assertions(3);

        const store = memoryBackupStore();

        seedMixedBucket(store);

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            backupCron: BACKUP_CRON,
            // No `backupRetain`: retention is off, so nothing is ever deleted.
            backupStore: store,
            queryCoordinator: coordinatorWithExport([]),
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/backup/retention", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        const preview: { keep: number; wouldDelete: string[] } = await response.json();

        expect(response.status).toBe(200);
        expect(preview.keep).toBe(0);
        expect(preview.wouldDelete).toStrictEqual([]);
    });

    it("names what a prune deleted, and says nothing when it deletes nothing", async () => {
        expect.assertions(5);

        // A prune's deletes are irreversible, so a successful one has to leave
        // a record — both retention defects found in review were silent
        // successes. A prune that removes nothing must stay quiet, or the
        // record is noise nobody reads.
        const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
        const store = memoryBackupStore();
        const key = "backups/lunora-backup-2026-06-01T00-00-00-000Z.ndjson";

        store.objects.set(key, "old\n");
        store.objects.set(`${key}.manifest.json`, JSON.stringify({ cron: BACKUP_CRON, file: key, id: "2026-06-01T00:00:00.000Z", scheduledTime: 0 }));
        store.metadata.set(`${key}.manifest.json`, { lunoraBackupCron: BACKUP_CRON });

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            backupCron: BACKUP_CRON,
            backupRetain: 1,
            backupStore: store,
            queryCoordinator: coordinatorWithExport([{ doc: { _id: "u1" }, table: "users" }]),
            shardDO: noopNamespace,
        });

        await fire(worker, { cron: BACKUP_CRON, scheduledTime: SCHEDULED_TIME });

        info.mockClear();
        await pruneVia(worker);

        expect(info).toHaveBeenCalledWith(expect.stringContaining("deleted 1: backups/lunora-backup-2026-06-01T00-00-00-000Z.ndjson.manifest.json"));

        info.mockClear();

        // Second prune: the newest is the only one this cron kept, and retain=1
        // leaves nothing past the window.
        await pruneVia(worker);

        expect(store.objects.has(key)).toBe(false);
        expect(info).not.toHaveBeenCalled();
    });

    it("deletes nothing on a cron fire, and names the command that would", async () => {
        expect.assertions(4);

        const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
        const store = memoryBackupStore();

        seedMixedBucket(store);

        const before = new Map(store.objects);
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            backupCron: BACKUP_CRON,
            backupRetain: 1,
            backupStore: store,
            queryCoordinator: coordinatorWithExport([{ doc: { _id: "u1" }, table: "users" }]),
            shardDO: noopNamespace,
        });

        await fire(worker, { cron: BACKUP_CRON, scheduledTime: SCHEDULED_TIME });

        // The whole point of WS4: a scheduled backup writes, and removes
        // nothing. Every seeded object is still here (the fire overwrites the
        // snapshot at its own key rather than adding one).
        expect([...store.objects.keys()].toSorted((a, b) => a.localeCompare(b))).toStrictEqual([...before.keys()].toSorted((a, b) => a.localeCompare(b)));
        expect(vi.mocked(store.delete)).not.toHaveBeenCalled();

        // But it must not go quiet either — without automatic pruning a bucket
        // grows until somebody acts, so the run says what is past the window
        // and what removes it.
        expect(info).toHaveBeenCalledWith(expect.stringContaining("past the newest 1"));
        expect(info).toHaveBeenCalledWith(expect.stringContaining("lunora backup prune"));

        info.mockRestore();
    });

    it("refuses to prune without a retention window", async () => {
        expect.assertions(3);

        const store = memoryBackupStore();

        seedMixedBucket(store);

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            backupCron: BACKUP_CRON,
            // No `backupRetain`: there is no window, so nothing is past it and
            // inventing a default here would be the implicit deletion the verb
            // exists to replace.
            backupStore: store,
            queryCoordinator: coordinatorWithExport([]),
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/backup/prune", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("BACKUP_RETENTION_NOT_CONFIGURED");
        expect(vi.mocked(store.delete)).not.toHaveBeenCalled();
    });

    it("refuses to prune without an admin bearer", async () => {
        expect.assertions(2);

        const store = memoryBackupStore();

        seedMixedBucket(store);

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            backupCron: BACKUP_CRON,
            backupRetain: 1,
            backupStore: store,
            queryCoordinator: coordinatorWithExport([]),
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(new Request("https://app.example/_lunora/admin/backup/prune", { method: "POST" }), {}, fakeContext);

        expect(response.status).toBe(403);
        expect(vi.mocked(store.delete)).not.toHaveBeenCalled();
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
