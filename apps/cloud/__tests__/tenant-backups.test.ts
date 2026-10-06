import { describe, expect, it, vi } from "vitest";

import { internal } from "../lunora/_generated/api.js";
import { authorizeDownload, beginBackup, beginRestore, finish, list } from "../lunora/tenant-backups";
import { PART_BYTES, uploadStream } from "../src/backup/multipart";
import { offsiteBucket } from "../src/backup/offsite";
import { backupRetentionFor, isDueForBackup, OPERATION_STALE_MS, tenantBackupKey } from "../src/backup/tenant-policy";
import type { BackupTargetRow } from "../src/backup/tenant-sweep";
import { runTenantBackupSweep } from "../src/backup/tenant-sweep";
import type { TenantBackupBucket, TenantSend } from "../src/backup/tenant-transport";
import { captureTenantSnapshot, IMPORT_BATCH_BYTES, restoreTenantSnapshot } from "../src/backup/tenant-transport";
import { createDeployRouter } from "../src/deploy/router";
import type { DispatchNamespaceLike } from "../src/targets/cloudflare-wfp/dispatch";
import { dispatchTenantSender } from "../src/targets/cloudflare-wfp/dispatch";
import fakeControlPlaneDb from "./_helpers/fake-control-plane-db";
import { makeCtx, owner } from "./_helpers/fake-ctx";
import type { MultipartStats, StoredObject } from "./_helpers/fake-object-store";
import { fakeMultipart, fakeS3 } from "./_helpers/fake-object-store";

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN = "tok_super_secret_admin_bearer";
const SECRET_ROW = `{"table":"users","doc":{"_id":"u1","email":"private@example.com"}}\n`;

type Row = Record<string, unknown>;

const gzip = async (text: string): Promise<Uint8Array<ArrayBuffer>> =>
    new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());

const gunzip = (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
    new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();

/** An R2 double over a Map, writing through R2's multipart rules (`./_helpers/fake-object-store.ts`). */
const memoryBucket = (
    initial: Record<string, Uint8Array<ArrayBuffer>> = {},
): { bucket: TenantBackupBucket; objects: Map<string, StoredObject>; stats: MultipartStats } => {
    const objects = new Map<string, StoredObject>(Object.entries(initial).map(([key, body]) => [key, { body, uploaded: new Date(NOW) }]));
    const { createMultipartUpload, stats } = fakeMultipart(objects);

    return {
        bucket: {
            createMultipartUpload,
            delete: async (keys) => {
                for (const key of [keys].flat()) {
                    objects.delete(key);
                }
            },
            get: async (key) => {
                const value = objects.get(key)?.body;

                return value ? { body: new Blob([value]).stream(), size: value.byteLength } : null;
            },
        },
        objects,
        stats,
    };
};

/** A dispatch namespace whose scripts answer from `handlers`, recording every request it receives. */
/** What a tenant received: method, path and the bearer it was sent with. */
interface SeenRequest {
    authorization: null | string;
    method: string;
    path: string;
}

const fakeDispatcher = (handlers: Record<string, (request: Request) => Promise<Response>>): { dispatcher: DispatchNamespaceLike; requests: SeenRequest[] } => {
    const requests: SeenRequest[] = [];

    return {
        dispatcher: {
            get: (scriptName) => {
                return {
                    fetch: async (request) => {
                        requests.push({ authorization: request.headers.get("authorization"), method: request.method, path: new URL(request.url).pathname });

                        return (handlers[scriptName] ?? (() => Promise.resolve(new Response("no such script", { status: 404 }))))(request);
                    },
                };
            },
        },
        requests,
    };
};

const deployment = (id: string, projectId: string, organizationId = "org_1", extra: Row = {}): Row => {
    return {
        _id: id,
        adminToken: TOKEN,
        alias: `alias-${projectId}`,
        createdAt: NOW - 10 * DAY_MS,
        kind: "production",
        organizationId,
        projectId,
        scriptName: `alias-${projectId}`,
        status: "live",
        url: `https://alias-${projectId}.lunora.app`,
        ...extra,
    };
};

const backupRow = (id: string, projectId: string, createdAt: number, extra: Row = {}): Row => {
    return {
        _id: id,
        alias: `alias-${projectId}`,
        createdAt,
        deploymentId: "dep",
        key: `tenant-backups/org_1/alias-${projectId}/${id}.ndjson.gz`,
        operation: "backup",
        organizationId: "org_1",
        projectId,
        status: "succeeded",
        trigger: "scheduled",
        ...extra,
    };
};

/** A store double that records inserts, patches and deletes. */
const recordingDb = (tables: Record<string, Row[]>) => {
    const inserted: { document: Row; table: string }[] = [];
    const patched: { id: string; patch: Row }[] = [];
    const deleted: string[] = [];
    const database = fakeControlPlaneDb(tables, {
        delete: async (id) => {
            deleted.push(id);
        },
        insert: async (table, document) => {
            inserted.push({ document, table });

            return `new_${String(inserted.length)}`;
        },
        patch: async (id, patch) => {
            patched.push({ id, patch });
        },
    });

    return { database, deleted, inserted, patched };
};

describe("tenant backup policy", () => {
    it("keys snapshots per org and alias, in chronological order", () => {
        const earlier = tenantBackupKey("org_1", "acme", NOW);
        const later = tenantBackupKey("org_1", "acme", NOW + 1);

        expect(earlier.startsWith("tenant-backups/org_1/acme/")).toBe(true);
        expect(earlier.endsWith(".ndjson.gz")).toBe(true);
        expect([later, earlier].toSorted((a, b) => a.localeCompare(b))).toStrictEqual([earlier, later]);
    });

    it("reads retention from the plan catalog", () => {
        expect([backupRetentionFor("free"), backupRetentionFor("pro"), backupRetentionFor("enterprise"), backupRetentionFor(undefined)]).toStrictEqual([
            3, 14, 30, 3,
        ]);
    });

    it("is not due after a recent success, a recent failure, or while running", () => {
        const recent = [backupRow("a", "p1", NOW - DAY_MS / 2)] as never;
        const failed = [backupRow("a", "p1", NOW - 60_000, { status: "failed" })] as never;
        const running = [backupRow("a", "p1", NOW - 60_000, { status: "running" })] as never;
        const stale = [backupRow("a", "p1", NOW - OPERATION_STALE_MS - 1, { status: "running" }), backupRow("b", "p1", NOW - 2 * DAY_MS)] as never;

        expect([
            isDueForBackup(recent, "p1", NOW),
            isDueForBackup(failed, "p1", NOW),
            isDueForBackup(running, "p1", NOW),
            isDueForBackup(stale, "p1", NOW),
        ]).toStrictEqual([false, false, false, true]);
    });
});

describe(runTenantBackupSweep, () => {
    it("snapshots each due project, isolating a failing tenant, and never logs tokens or data", async () => {
        const { database, inserted, patched } = recordingDb({
            deployments: [deployment("dep_a", "p_a"), deployment("dep_b", "p_b"), deployment("dep_c", "p_c", "org_1", { kind: "preview" })],
            organizations: [{ _id: "org_1", plan: "pro" }],
            projects: [{ _id: "p_a" }, { _id: "p_b" }, { _id: "p_c" }],
            tenantBackups: [],
        });
        const { bucket, objects } = memoryBucket();
        const { dispatcher, requests } = fakeDispatcher({
            "alias-p_a": () => Promise.resolve(new Response(SECRET_ROW, { headers: { "content-type": "application/x-ndjson" } })),
            "alias-p_b": () => Promise.resolve(Response.json({ error: { message: "export failed on 1 of 2 shard(s)" } }, { status: 502 })),
        });
        const logs: string[] = [];

        const result = await runTenantBackupSweep({
            bucket,
            database,
            log: (line) => logs.push(line),
            now: NOW,
            senderFor: (row: BackupTargetRow) => Promise.resolve(dispatchTenantSender(dispatcher, { adminToken: TOKEN, resourceRef: row.scriptName })),
        });

        expect(result).toMatchObject({ failed: 1, succeeded: 1 });
        // Production only — the preview is never snapshotted.
        expect(inserted.map((entry) => entry.document["projectId"])).toStrictEqual(["p_a", "p_b"]);
        // The export is a POST carrying the admin bearer, over the dispatch namespace.
        expect(requests.map((request) => [request.method, request.path, request.authorization])).toStrictEqual([
            ["POST", "/_lunora/admin/export", `Bearer ${TOKEN}`],
            ["POST", "/_lunora/admin/export", `Bearer ${TOKEN}`],
        ]);

        const [stored] = [...objects.values()].map((object) => object.body);

        await expect(gunzip(stored ?? new Uint8Array())).resolves.toBe(SECRET_ROW);
        expect(patched.find((entry) => entry.id === "new_1")?.patch).toMatchObject({ bytes: stored?.byteLength, status: "succeeded" });

        const failure = patched.find((entry) => entry.id === "new_2")?.patch;

        expect(failure).toMatchObject({ status: "failed" });
        expect(String(failure?.["error"])).toContain("HTTP 502");

        const everything = JSON.stringify({ logs, patched });

        expect(everything).not.toContain(TOKEN);
        expect(everything).not.toContain("private@example.com");
    });

    it("keeps a thrown tenant error from aborting the rest of the tick", async () => {
        const { database, patched } = recordingDb({
            deployments: [deployment("dep_a", "p_a"), deployment("dep_b", "p_b")],
            organizations: [{ _id: "org_1", plan: "free" }],
            projects: [{ _id: "p_a" }, { _id: "p_b" }],
            tenantBackups: [],
        });
        const { bucket } = memoryBucket();
        const send: TenantSend = () => Promise.resolve(new Response(SECRET_ROW));

        const result = await runTenantBackupSweep({
            bucket,
            database,
            now: NOW,
            senderFor: (row) => (row.projectId === "p_a" ? Promise.reject(new Error("dispatcher exploded")) : Promise.resolve(send)),
        });

        expect(result).toMatchObject({ failed: 1, succeeded: 1 });
        expect(patched.map((entry) => entry.patch["status"])).toStrictEqual(["failed", "succeeded"]);
    });

    it("skips projects with a recent snapshot and reaps a stale running row", async () => {
        const { database, inserted, patched } = recordingDb({
            deployments: [deployment("dep_a", "p_a")],
            organizations: [{ _id: "org_1", plan: "free" }],
            projects: [{ _id: "p_a" }],
            tenantBackups: [backupRow("b_recent", "p_a", NOW - DAY_MS / 4), backupRow("b_stuck", "p_a", NOW - OPERATION_STALE_MS - 1, { status: "running" })],
        });

        const result = await runTenantBackupSweep({ bucket: memoryBucket().bucket, database, now: NOW, senderFor: () => Promise.resolve(null) });

        expect(inserted).toHaveLength(0);
        expect(result.reaped).toBe(1);
        expect(patched).toStrictEqual([{ id: "b_stuck", patch: expect.objectContaining({ status: "failed" }) }]);
    });

    it("applies each plan's retention and deletes a deleted project's snapshots", async () => {
        const freeRows = [1, 2, 3, 4, 5].map((age) => backupRow(`free_${String(age)}`, "p_free", NOW - (age * DAY_MS) / 4));
        const proRows = [1, 2, 3, 4, 5].map((age) => backupRow(`pro_${String(age)}`, "p_pro", NOW - (age * DAY_MS) / 4, { organizationId: "org_pro" }));
        const orphan = backupRow("gone_1", "p_deleted", NOW - DAY_MS);
        const all = [...freeRows, ...proRows, orphan];
        const { bucket, objects } = memoryBucket(Object.fromEntries(all.map((row) => [row["key"] as string, new Uint8Array([1])])));
        const { database, deleted } = recordingDb({
            deployments: [],
            organizations: [
                { _id: "org_1", plan: "free" },
                { _id: "org_pro", plan: "pro" },
            ],
            projects: [{ _id: "p_free" }, { _id: "p_pro" }],
            tenantBackups: all,
        });

        const result = await runTenantBackupSweep({ bucket, database, now: NOW, senderFor: () => Promise.resolve(null) });

        // Free keeps its newest 3 of 5; pro keeps all 5 (limit 14); the orphan goes.
        expect(deleted.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["free_4", "free_5", "gone_1"]);
        expect(result.pruned).toBe(3);
        expect(objects.has(freeRows[3]?.["key"] as string)).toBe(false);
        expect(objects.has(orphan["key"] as string)).toBe(false);
        expect(objects.size).toBe(8);
    });
});

const MIB = 1024 * 1024;
const OFFSITE_KEY_ID = "offsite-key-id";
const OFFSITE_SECRET = "offsite-secret-access-key-never-logged";
const OFFSITE_ENV = {
    BACKUP_OFFSITE_ACCESS_KEY_ID: OFFSITE_KEY_ID,
    BACKUP_OFFSITE_BUCKET: "dr-backups",
    BACKUP_OFFSITE_ENDPOINT: "https://other-account.r2.cloudflarestorage.com",
    BACKUP_OFFSITE_SECRET_ACCESS_KEY: OFFSITE_SECRET,
};

/** An S3 double for the off-site account and the bucket over it. */
const offsite = (options: { intercept?: (request: Request) => Response | undefined; objects?: Map<string, StoredObject> } = {}) => {
    const s3 = fakeS3({ accessKeyId: OFFSITE_KEY_ID, bucket: "dr-backups", ...options });
    const bucket = offsiteBucket(OFFSITE_ENV, s3.fetch);

    if (!bucket) {
        throw new Error("off-site bucket should be configured");
    }

    return { ...s3, bucket };
};

/** `megabytes` of random bytes, streamed a MiB at a time — gzip cannot shrink them under the old 64 MiB cap. */
const noise = (megabytes: number, failAfter?: number): ReadableStream<Uint8Array> => {
    let sent = 0;

    return new ReadableStream({
        pull: (controller) => {
            if (failAfter !== undefined && sent === failAfter) {
                controller.error(new Error("tenant stream broke"));

                return;
            }

            if (sent === megabytes) {
                controller.close();

                return;
            }

            const chunk = new Uint8Array(MIB);

            // `getRandomValues` fills at most 64 KiB per call.
            for (let offset = 0; offset < MIB; offset += 65_536) {
                crypto.getRandomValues(chunk.subarray(offset, offset + 65_536));
            }

            sent += 1;
            controller.enqueue(chunk);
        },
    });
};

describe(captureTenantSnapshot, () => {
    it("stores a snapshot past the old 64 MiB ceiling in fixed parts, one part in memory", async () => {
        const { bucket, objects, stats } = memoryBucket();
        const send: TenantSend = () => Promise.resolve(new Response(noise(70)));

        const { bytes } = await captureTenantSnapshot({ bucket, key: "big.ndjson.gz", send });

        expect(bytes).toBeGreaterThan(64 * MIB);
        expect(objects.get("big.ndjson.gz")?.body.byteLength).toBe(bytes);
        // R2's rules held (the fake refuses otherwise), and no part outgrew the buffer.
        expect(stats.largestPart).toBe(PART_BYTES);
        expect(stats.parts).toBe(Math.ceil(bytes / PART_BYTES));
    }, 60_000);

    it("writes nothing and aborts the upload when the export breaks midway", async () => {
        const { bucket, objects, stats } = memoryBucket();
        const send: TenantSend = () => Promise.resolve(new Response(noise(20, 12)));

        await expect(captureTenantSnapshot({ bucket, key: "broken.ndjson.gz", send })).rejects.toThrow("tenant stream broke");
        expect(stats.parts).toBeGreaterThan(0);
        expect(stats.aborted).toBe(1);
        expect(objects.size).toBe(0);
    });

    it("aborts and stores nothing once a stream passes its byte ceiling", async () => {
        const objects = new Map<string, StoredObject>();
        const bucket = fakeMultipart(objects);
        const endless = new ReadableStream<Uint8Array>({
            pull: (controller) => {
                controller.enqueue(new Uint8Array(1024 * 1024));
            },
        });

        await expect(uploadStream(bucket, "endless.ndjson.gz", endless, "application/gzip", 3 * PART_BYTES)).rejects.toThrow("exceeds the 24 MiB limit");
        expect(bucket.stats.aborted).toBe(1);
        expect(objects.size).toBe(0);
    });
});

describe("tenant backup off-site copy", () => {
    it("copies each snapshot to the off-site account and records it on the row", async () => {
        const { database, patched } = recordingDb({
            deployments: [deployment("dep_a", "p_a")],
            organizations: [{ _id: "org_1", plan: "free" }],
            projects: [{ _id: "p_a" }],
            tenantBackups: [],
        });
        const { bucket, objects } = memoryBucket();
        const remote = offsite();
        const send: TenantSend = () => Promise.resolve(new Response(SECRET_ROW));

        const result = await runTenantBackupSweep({ bucket, database, now: NOW, offsite: remote.bucket, senderFor: () => Promise.resolve(send) });

        expect(result).toMatchObject({ failed: 0, succeeded: 1 });

        const [key] = [...objects.keys()];

        expect(remote.objects.get(key ?? "")?.body).toStrictEqual(objects.get(key ?? "")?.body);
        expect(patched[0]?.patch).toMatchObject({ offsiteStatus: "succeeded", status: "succeeded" });
        expect(patched[0]?.patch).not.toHaveProperty("offsiteError");
        // Signed under the key id; the secret itself never goes on the wire.
        expect(remote.requests.every((request) => request.headers.get("authorization")?.includes(`Credential=${OFFSITE_KEY_ID}/`))).toBe(true);
        expect(JSON.stringify(remote.requests.map((request) => [request.url, [...request.headers]]))).not.toContain(OFFSITE_SECRET);
    });

    it("keeps the snapshot succeeded when the off-site account is down, and says so", async () => {
        const { database, patched } = recordingDb({
            deployments: [deployment("dep_a", "p_a")],
            organizations: [{ _id: "org_1", plan: "free" }],
            projects: [{ _id: "p_a" }],
            tenantBackups: [],
        });
        const { bucket, objects } = memoryBucket();
        const remote = offsite({ intercept: () => new Response("<Error><Code>ServiceUnavailable</Code></Error>", { status: 503 }) });
        const logs: string[] = [];

        const result = await runTenantBackupSweep({
            bucket,
            database,
            log: (line) => logs.push(line),
            now: NOW,
            offsite: remote.bucket,
            senderFor: () => Promise.resolve(async () => new Response(SECRET_ROW)),
        });

        expect(result).toMatchObject({ failed: 0, succeeded: 1 });
        expect(objects.size).toBe(1);
        expect(patched[0]?.patch).toMatchObject({ offsiteStatus: "failed", status: "succeeded" });
        expect(String(patched[0]?.patch["offsiteError"])).toContain("HTTP 503 ServiceUnavailable");
        expect(logs.some((line) => line.includes("off-site copy failed"))).toBe(true);
        expect(JSON.stringify({ logs, patched })).not.toContain(OFFSITE_SECRET);
    });

    it("deletes the off-site copy with the primary, and keeps the row while it cannot", async () => {
        const doomed = [1, 2, 3, 4].map((age) => backupRow(`b_${String(age)}`, "p_a", NOW - (age * DAY_MS) / 4));
        const seed = (): Map<string, StoredObject> =>
            new Map(doomed.map((row) => [row["key"] as string, { body: new Uint8Array([1]), uploaded: new Date(NOW) }]));
        const tables = {
            deployments: [],
            organizations: [{ _id: "org_1", plan: "free" }],
            projects: [{ _id: "p_a" }],
            tenantBackups: doomed,
        };

        // Free keeps 3 of 4: the oldest goes from both accounts.
        const healthy = recordingDb(tables);
        const remote = offsite({ objects: seed() });

        await runTenantBackupSweep({
            bucket: memoryBucket().bucket,
            database: healthy.database,
            now: NOW,
            offsite: remote.bucket,
            senderFor: () => Promise.resolve(null),
        });

        expect(healthy.deleted).toStrictEqual(["b_4"]);
        expect(remote.objects.has(doomed[3]?.["key"] as string)).toBe(false);
        expect(remote.objects.size).toBe(3);

        // Off-site down: the row stays so the next tick finds the object again.
        const outage = recordingDb(tables);
        const down = offsite({ intercept: (request) => (request.method === "DELETE" ? new Response(null, { status: 503 }) : undefined), objects: seed() });
        const result = await runTenantBackupSweep({
            bucket: memoryBucket().bucket,
            database: outage.database,
            now: NOW,
            offsite: down.bucket,
            senderFor: () => Promise.resolve(null),
        });

        expect(outage.deleted).toStrictEqual([]);
        expect(result.pruned).toBe(0);
        expect(down.objects.size).toBe(4);
    });

    it("records the off-site outcome of a manual backup through the route", async () => {
        const remote = fakeS3({ accessKeyId: OFFSITE_KEY_ID, bucket: "dr-backups" });
        const { bucket } = memoryBucket();
        const { dispatcher } = fakeDispatcher({ acme: () => Promise.resolve(new Response(SECRET_ROW)) });
        const finished: Row[] = [];
        const runMutation = vi.fn<(reference: unknown, args?: Row) => Promise<unknown>>(async (reference, args) => {
            if (reference === internal.tenant_backups.beginBackup) {
                return {
                    adminToken: TOKEN,
                    alias: "acme",
                    backupId: "bk_1",
                    deploymentId: "dep_a",
                    key: "manual.ndjson.gz",
                    resourceRef: "acme",
                    scriptName: "acme",
                    url: "https://acme.lunora.app",
                };
            }

            finished.push(args ?? {});

            return null;
        });

        vi.stubGlobal("fetch", remote.fetch);

        try {
            const response = await createDeployRouter().fetch(
                new Request("https://control.lunora.app/v1/backups", {
                    body: JSON.stringify({ organizationId: "org_1", projectId: "p_a" }),
                    headers: { "cf-connecting-ip": "client-a", "content-type": "application/json" },
                    method: "POST",
                }),
                { __lunoraCtx: { runMutation }, DISPATCHER: dispatcher, TENANT_BACKUPS: bucket, ...OFFSITE_ENV },
            );

            expect(response.status).toBe(200);
        } finally {
            vi.unstubAllGlobals();
        }

        expect(remote.objects.has("manual.ndjson.gz")).toBe(true);
        expect(finished).toStrictEqual([expect.objectContaining({ id: "bk_1", offsiteStatus: "succeeded", status: "succeeded" })]);
    });
});

describe(restoreTenantSnapshot, () => {
    const SESSION = "restore-test";
    const STAGE_PATH = `/_lunora/admin/import?mode=replace&stage=${SESSION}`;
    const COMMIT_PATH = "/_lunora/admin/import/commit";
    const ABORT_PATH = "/_lunora/admin/import/abort";

    /**
     * A tenant with staged import: stages every batch, and commits with one
     * deletion per table. `commit` overrides the commit's answers, in order.
     */
    const stagedTenant =
        (calls: { body: string; path: string }[], commit: (() => Response)[] = []): TenantSend =>
        async (path, body) => {
            calls.push({ body, path });

            if (path === ABORT_PATH) {
                return Response.json({ aborted: false });
            }

            if (path === COMMIT_PATH) {
                return commit.shift()?.() ?? Response.json({ deleted: { $kv: 1, t: 3 }, inserted: { t: 2000 }, session: SESSION, status: "committed" });
            }

            const rows = body.split("\n").filter(Boolean).length;

            return Response.json({ errors: [], failed: [], received: rows, session: SESSION, staged: { t: rows } });
        };

    it("stages every batch under the tenant's body limit into one session, then commits once", async () => {
        const line = `${JSON.stringify({ doc: { _id: "x", pad: "y".repeat(1000) }, table: "t" })}\n`;
        const snapshot = line.repeat(2000);
        const calls: { body: string; path: string }[] = [];

        const summary = await restoreTenantSnapshot(stagedTenant(calls), new Blob([await gzip(snapshot)]).stream(), SESSION);
        const staged = calls.filter((call) => call.path === STAGE_PATH);

        expect(staged.length).toBeGreaterThan(1);
        expect(calls.map((call) => call.path)).toStrictEqual([ABORT_PATH, ...staged.map(() => STAGE_PATH), COMMIT_PATH]);
        expect(staged.every((call) => new TextEncoder().encode(call.body).byteLength <= IMPORT_BATCH_BYTES)).toBe(true);
        expect(staged.map((call) => call.body).join("")).toBe(snapshot);
        expect(summary).toStrictEqual({ deleted: 4, deletedByTable: { $kv: 1, t: 3 }, inserted: 2000, received: 2000 });
    });

    it("still stages an empty snapshot, whose commit empties the tenant", async () => {
        const calls: { body: string; path: string }[] = [];

        await restoreTenantSnapshot(stagedTenant(calls), new Blob([await gzip("")]).stream(), SESSION);

        expect(calls.map((call) => call.path)).toStrictEqual([ABORT_PATH, STAGE_PATH, COMMIT_PATH]);
        expect(calls[1]?.body).toBe("");
    });

    it("aborts the session, and never commits, when a batch rejects a row or misses a shard", async () => {
        const answering =
            (calls: string[], stage: Response): TenantSend =>
            async (path) => {
                calls.push(path);

                return path === ABORT_PATH ? Response.json({ aborted: true }) : stage.clone();
            };
        const rejected: string[] = [];
        const partial: string[] = [];

        await expect(
            restoreTenantSnapshot(
                answering(rejected, Response.json({ errors: [{ code: "VALIDATION_ERROR" }], failed: [], received: 1 })),
                new Blob([await gzip(SECRET_ROW)]).stream(),
                SESSION,
            ),
        ).rejects.toThrow(/1 row\(s\) rejected.*nothing was changed/u);
        await expect(
            restoreTenantSnapshot(
                answering(partial, Response.json({ errors: [], failed: [{ shardKey: "c2" }], received: 1 }, { status: 207 })),
                new Blob([await gzip(SECRET_ROW)]).stream(),
                SESSION,
            ),
        ).rejects.toThrow(/1 shard\(s\) unreachable/u);
        expect(rejected).toStrictEqual([ABORT_PATH, STAGE_PATH, ABORT_PATH]);
        expect(partial).not.toContain(COMMIT_PATH);
    });

    it("sends a commit that failed part-way again, and aborts one its dry run refused", async () => {
        const retried: { body: string; path: string }[] = [];

        await expect(
            restoreTenantSnapshot(
                stagedTenant(retried, [() => Response.json({ errors: [], failed: [{ shardKey: "c2" }], status: "partial" }, { status: 502 })]),
                new Blob([await gzip(SECRET_ROW)]).stream(),
                SESSION,
            ),
        ).resolves.toMatchObject({ inserted: 2000 });
        expect(retried.filter((call) => call.path === COMMIT_PATH)).toHaveLength(2);

        const refused: { body: string; path: string }[] = [];

        await expect(
            restoreTenantSnapshot(
                stagedTenant(refused, [() => Response.json({ errors: [{ code: "VALIDATION_ERROR" }], failed: [], status: "refused" }, { status: 409 })]),
                new Blob([await gzip(SECRET_ROW)]).stream(),
                SESSION,
            ),
        ).rejects.toThrow(/refused before anything was written: 1 row\(s\) would not land/u);
        expect(refused.at(-1)?.path).toBe(ABORT_PATH);
    });

    it("sends the commit again when another commit is under way rather than aborting", async () => {
        const calls: { body: string; path: string }[] = [];

        await expect(
            restoreTenantSnapshot(
                stagedTenant(calls, [() => Response.json({ error: { code: "IMPORT_SESSION_COMMITTING", message: "being committed" } }, { status: 409 })]),
                new Blob([await gzip(SECRET_ROW)]).stream(),
                SESSION,
            ),
        ).resolves.toMatchObject({ inserted: 2000 });
        expect(calls.filter((call) => call.path === COMMIT_PATH)).toHaveLength(2);
        expect(calls.filter((call) => call.path === ABORT_PATH)).toHaveLength(1);
    });

    it("gives up after a commit keeps failing, saying the tenant may be part-restored", async () => {
        const failing = (): Response => Response.json({ errors: [], failed: [{ shardKey: "c2" }], status: "partial" }, { status: 502 });

        await expect(
            restoreTenantSnapshot(stagedTenant([], [failing, failing, failing]), new Blob([await gzip(SECRET_ROW)]).stream(), SESSION),
        ).rejects.toThrow(/did not finish after 3 attempts.*part of the tenant may already hold the snapshot/u);
    });

    it("bounds what a hostile tenant answers before anything of it is stored", async () => {
        const hostileDeleted: Record<string, unknown> = {
            "": 5,
            "(other tables)": 7,
            [`x${"y".repeat(500)}`]: 3,
            fractional: 1.5,
            huge: Number.MAX_SAFE_INTEGER,
            infinite: Number.POSITIVE_INFINITY,
            negative: -4,
            text: "9",
        };

        for (let index = 0; index < 100; index += 1) {
            hostileDeleted[`t${String(index).padStart(3, "0")}`] = 1;
        }

        const hostile = (): Response => Response.json({ deleted: hostileDeleted, inserted: { t: Number.NaN, u: 2 }, status: "committed" });
        const staging: TenantSend = async (path) => {
            if (path === ABORT_PATH) {
                return Response.json({ aborted: false });
            }

            return path === COMMIT_PATH ? hostile() : Response.json({ errors: "x".repeat(10_000), received: -1 });
        };
        const summary = await restoreTenantSnapshot(staging, new Blob([await gzip(SECRET_ROW)]).stream(), SESSION);
        const tables = Object.keys(summary.deletedByTable);

        expect(tables.length).toBeLessThanOrEqual(65);
        expect(tables.every((table) => table.length > 0 && table.length <= 128)).toBe(true);
        expect(Object.values(summary.deletedByTable).every((count) => Number.isSafeInteger(count) && count >= 0)).toBe(true);
        // Past the cap, the rest folds into one marker entry rather than vanishing.
        expect(summary.deletedByTable["(other tables)"]).toBeGreaterThan(0);
        expect(summary.deleted).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
        expect(summary.inserted).toBe(2);
        expect(summary.received).toBe(0);
    });

    it("bounds a hostile tenant's error text", async () => {
        const send: TenantSend = async (path) =>
            path === ABORT_PATH ? Response.json({ aborted: false }) : Response.json({ error: { message: "m".repeat(100_000) } }, { status: 500 });

        const failure = await restoreTenantSnapshot(send, new Blob([await gzip(SECRET_ROW)]).stream(), SESSION).catch((error: unknown) => error as Error);

        expect(failure.message.length).toBeLessThan(500);
    });

    it("refuses a runtime without staged import before sending it a row", async () => {
        const calls: string[] = [];
        const old: TenantSend = async (path) => {
            calls.push(path);

            return new Response("not found", { status: 404 });
        };

        await expect(restoreTenantSnapshot(old, new Blob([await gzip(SECRET_ROW)]).stream(), SESSION)).rejects.toThrow(/predates staged import/u);
        expect(calls).toStrictEqual([ABORT_PATH]);
    });

    it("aborts on a batch the tenant refuses", async () => {
        const calls: string[] = [];
        const send: TenantSend = async (path) => {
            calls.push(path);

            return path === ABORT_PATH ? Response.json({ aborted: false }) : Response.json({ error: { message: "Body too large" } }, { status: 413 });
        };

        await expect(restoreTenantSnapshot(send, new Blob([await gzip(SECRET_ROW)]).stream(), SESSION)).rejects.toThrow(/HTTP 413/u);
        expect(calls.at(-1)).toBe(ABORT_PATH);
    });
});

describe("tenant backup mutations", () => {
    const live = deployment("dep_a", "p_a");
    const project = { _id: "p_a", organizationId: "org_1" };
    const member = { _id: "mem_2", organizationId: "org_1", role: "member", userId: "usr_2" };

    it("lets only owners and admins start a backup", async () => {
        const { ctx } = makeCtx({ deployments: [live], members: [member], projects: [project], tenantBackups: [] }, { userId: "usr_2" });

        await expect(beginBackup.handler(ctx, { organizationId: "org_1", projectId: "p_a" } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("refuses a backup while another operation on the project is running", async () => {
        const { ctx } = makeCtx(
            {
                deployments: [live],
                members: [owner("org_1")],
                projects: [project],
                tenantBackups: [backupRow("b_run", "p_a", 1_700_000_000_000 - 1000, { status: "running" })],
            },
            { now: 1_700_000_000_000 },
        );

        await expect(beginBackup.handler(ctx, { organizationId: "org_1", projectId: "p_a" } as never)).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("stores a restore's per-table deletions and still lists a pre-staging restore's conflict counts", async () => {
        const running = backupRow("r_new", "p_a", 1_700_000_000_000, { operation: "restore", status: "running", trigger: "manual" });
        const settled = backupRow("r_done", "p_a", 1_650_000_000_000, {
            operation: "restore",
            restoreDeleted: { $kv: 1, users: 2 },
            restoreInserted: 7,
            trigger: "manual",
        });
        const historical = backupRow("r_old", "p_a", 1_600_000_000_000, {
            operation: "restore",
            restoreConflicts: 2,
            restoreInserted: 5,
            restoreRowErrors: 1,
            trigger: "manual",
        });
        const { ctx, ops } = makeCtx({ members: [owner("org_1")], projects: [project], tenantBackups: [running, settled, historical] });

        await finish.handler(ctx, {
            id: "r_new",
            organizationId: "org_1",
            restoreDeleted: { $kv: 1, users: 2 },
            restoreInserted: 7,
            status: "succeeded",
        } as never);

        const rows = (await list.handler(ctx, { organizationId: "org_1", projectId: "p_a" } as never)) as Row[];

        expect(ops).toContainEqual(
            expect.objectContaining({ id: "r_new", kind: "patch", patch: expect.objectContaining({ restoreDeleted: { $kv: 1, users: 2 } }) }),
        );
        expect(rows.find((row) => row["_id"] === "r_done")).toMatchObject({ restoreDeleted: { $kv: 1, users: 2 }, restoreInserted: 7 });
        expect(rows.find((row) => row["_id"] === "r_old")).toMatchObject({ restoreConflicts: 2, restoreInserted: 5, restoreRowErrors: 1 });
        expect(rows.every((row) => !("key" in row))).toBe(true);
    });

    it("records a restore together with its pre-restore backup, and audits it", async () => {
        const source = backupRow("b_src", "p_a", 1_600_000_000_000);
        const { ctx, ops } = makeCtx({ auditLog: [], deployments: [live], members: [owner("org_1")], projects: [project], tenantBackups: [source] });

        const started = await beginRestore.handler(ctx, { backupId: "b_src", organizationId: "org_1" } as never);
        const inserts = ops.flatMap((op) => (op.kind === "insert" && op.table !== "rateLimits" ? [op] : []));

        expect(started).toMatchObject({ adminToken: TOKEN, sourceKey: source["key"] });
        expect(inserts.map((op) => [op.table, op.document["operation"], op.document["trigger"], op.document["status"]])).toStrictEqual([
            ["tenantBackups", "backup", "pre-restore", "running"],
            ["tenantBackups", "restore", "manual", "running"],
            ["auditLog", undefined, undefined, undefined],
        ]);
    });

    it("refuses to restore a backup that did not succeed", async () => {
        const { ctx } = makeCtx({
            deployments: [live],
            members: [owner("org_1")],
            projects: [project],
            tenantBackups: [backupRow("b_bad", "p_a", 1_600_000_000_000, { status: "failed" })],
        });

        await expect(beginRestore.handler(ctx, { backupId: "b_bad", organizationId: "org_1" } as never)).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("authorizes downloads for owners only and audits them", async () => {
        const row = backupRow("b_1", "p_a", 1_600_000_000_000);
        const denied = makeCtx({ members: [member], tenantBackups: [row] }, { userId: "usr_2" });
        const allowed = makeCtx({ auditLog: [], members: [owner("org_1")], tenantBackups: [row] });

        await expect(authorizeDownload.handler(denied.ctx, { backupId: "b_1", organizationId: "org_1" } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(authorizeDownload.handler(allowed.ctx, { backupId: "b_1", organizationId: "org_2" } as never)).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        await expect(authorizeDownload.handler(allowed.ctx, { backupId: "b_1", organizationId: "org_1" } as never)).resolves.toMatchObject({ key: row["key"] });
        expect(allowed.ops.some((op) => op.kind === "insert" && op.table === "auditLog")).toBe(true);
    });
});

describe("tenant backup routes", () => {
    // Each test builds its own router, so one client address never meets the per-IP limiter.
    const post = (path: string, body: unknown): Request =>
        new Request(`https://control.lunora.app${path}`, {
            body: JSON.stringify(body),
            headers: { "cf-connecting-ip": "client-a", "content-type": "application/json" },
            method: "POST",
        });

    const target = { adminToken: TOKEN, alias: "acme", deploymentId: "dep_a", resourceRef: "acme", scriptName: "acme", url: "https://acme.lunora.app" };

    it("takes the pre-restore backup before importing, and settles both rows", async () => {
        const { bucket, objects } = memoryBucket({ "src.ndjson.gz": await gzip(SECRET_ROW) });
        const { dispatcher, requests } = fakeDispatcher({
            acme: (request) => {
                const { pathname } = new URL(request.url);

                if (pathname.endsWith("/export")) {
                    return Promise.resolve(new Response("current\n"));
                }

                if (pathname.endsWith("/abort")) {
                    return Promise.resolve(Response.json({ aborted: false }));
                }

                return Promise.resolve(
                    pathname.endsWith("/commit")
                        ? Response.json({ deleted: { $kv: 1, users: 2 }, inserted: { users: 1 }, status: "committed" })
                        : Response.json({ errors: [], failed: [], received: 1, staged: { users: 1 } }),
                );
            },
        });
        const finished: Row[] = [];
        const runMutation = vi.fn<(reference: unknown, args?: Row) => Promise<unknown>>(async (reference, args) => {
            if (reference === internal.tenant_backups.beginRestore) {
                return { ...target, preRestoreBackupId: "pre_1", preRestoreKey: "pre.ndjson.gz", restoreId: "res_1", sourceKey: "src.ndjson.gz" };
            }

            finished.push(args ?? {});

            return null;
        });

        const response = await createDeployRouter().fetch(post("/v1/backups/restore", { backupId: "b_src", organizationId: "org_1" }), {
            __lunoraCtx: { runMutation },
            DISPATCHER: dispatcher,
            TENANT_BACKUPS: bucket,
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ summary: { deleted: 3, deletedByTable: { $kv: 1, users: 2 }, inserted: 1, received: 1 } });
        expect(requests.map((request) => request.path)).toStrictEqual([
            "/_lunora/admin/export",
            "/_lunora/admin/import/abort",
            "/_lunora/admin/import",
            "/_lunora/admin/import/commit",
        ]);
        await expect(gunzip(objects.get("pre.ndjson.gz")?.body ?? new Uint8Array())).resolves.toBe("current\n");
        expect(finished).toStrictEqual([
            expect.objectContaining({ id: "pre_1", status: "succeeded" }),
            expect.objectContaining({ id: "res_1", restoreDeleted: { $kv: 1, users: 2 }, restoreInserted: 1, status: "succeeded" }),
        ]);
    });

    it("restores nothing when the pre-restore backup fails", async () => {
        const { bucket } = memoryBucket({ "src.ndjson.gz": await gzip(SECRET_ROW) });
        const { dispatcher, requests } = fakeDispatcher({ acme: () => Promise.resolve(Response.json({ error: { message: "boom" } }, { status: 500 })) });
        const finished: Row[] = [];
        const runMutation = vi.fn<(reference: unknown, args?: Row) => Promise<unknown>>(async (reference, args) => {
            if (reference === internal.tenant_backups.beginRestore) {
                return { ...target, preRestoreBackupId: "pre_1", preRestoreKey: "pre.ndjson.gz", restoreId: "res_1", sourceKey: "src.ndjson.gz" };
            }

            finished.push(args ?? {});

            return null;
        });

        const response = await createDeployRouter().fetch(post("/v1/backups/restore", { backupId: "b_src", organizationId: "org_1" }), {
            __lunoraCtx: { runMutation },
            DISPATCHER: dispatcher,
            TENANT_BACKUPS: bucket,
        });

        expect(response.status).toBe(502);
        expect(requests.map((request) => request.path)).toStrictEqual(["/_lunora/admin/export"]);
        expect(finished.map((entry) => [entry["id"], entry["status"]])).toStrictEqual([
            ["pre_1", "failed"],
            ["res_1", "failed"],
        ]);
        expect(JSON.stringify(finished)).not.toContain(TOKEN);
    });

    it("answers 409 when the project is busy", async () => {
        const { LunoraError } = await import("@lunora/server");
        const runMutation = vi.fn<() => Promise<unknown>>(() => Promise.reject(new LunoraError("CONFLICT", "a backup of this project is already running")));

        const response = await createDeployRouter().fetch(post("/v1/backups/restore", { backupId: "b_src", organizationId: "org_1" }), {
            __lunoraCtx: { runMutation },
            TENANT_BACKUPS: memoryBucket().bucket,
        });

        expect(response.status).toBe(409);
    });

    it("streams a download only after authorization", async () => {
        const { LunoraError } = await import("@lunora/server");
        const payload = await gzip(SECRET_ROW);
        const { bucket } = memoryBucket({ "k.ndjson.gz": payload });
        const denied = await createDeployRouter().fetch(post("/v1/backups/download", { backupId: "b_1", organizationId: "org_1" }), {
            __lunoraCtx: { runMutation: () => Promise.reject(new LunoraError("FORBIDDEN", "requires one of: owner, admin")) },
            TENANT_BACKUPS: bucket,
        });
        const allowed = await createDeployRouter().fetch(post("/v1/backups/download", { backupId: "b_1", organizationId: "org_1" }), {
            __lunoraCtx: { runMutation: () => Promise.resolve({ alias: "acme", createdAt: NOW, key: "k.ndjson.gz" }) },
            TENANT_BACKUPS: bucket,
        });

        expect(denied.status).toBe(403);
        expect(allowed.status).toBe(200);
        expect(allowed.headers.get("content-disposition")).toContain("acme-");
        expect(allowed.headers.get("cache-control")).toBe("no-store");
        await expect(allowed.arrayBuffer().then((buffer) => new Uint8Array(buffer))).resolves.toStrictEqual(payload);
    });

    it("answers 500 when the cell has no backup bucket", async () => {
        const response = await createDeployRouter().fetch(post("/v1/backups", { organizationId: "org_1", projectId: "p_a" }), {
            __lunoraCtx: { runMutation: vi.fn<() => Promise<unknown>>() },
        });

        expect(response.status).toBe(500);
    });
});
