import { describe, expect, it, vi } from "vitest";

import { internal } from "../lunora/_generated/api.js";
import { authorizeDownload, beginBackup, beginRestore } from "../lunora/tenant-backups";
import { backupRetentionFor, isDueForBackup, OPERATION_STALE_MS, tenantBackupKey } from "../src/backup/tenant-policy";
import type { BackupTargetRow } from "../src/backup/tenant-sweep";
import { runTenantBackupSweep } from "../src/backup/tenant-sweep";
import type { TenantBackupBucket, TenantSend } from "../src/backup/tenant-transport";
import { IMPORT_BATCH_BYTES, restoreTenantSnapshot } from "../src/backup/tenant-transport";
import { createDeployRouter } from "../src/deploy/router";
import type { DispatchNamespaceLike } from "../src/targets/cloudflare-wfp/dispatch";
import { dispatchTenantSender } from "../src/targets/cloudflare-wfp/dispatch";
import fakeControlPlaneDb from "./_helpers/fake-control-plane-db";
import { makeCtx, owner } from "./_helpers/fake-ctx";

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN = "tok_super_secret_admin_bearer";
const SECRET_ROW = `{"table":"users","doc":{"_id":"u1","email":"private@example.com"}}\n`;

type Row = Record<string, unknown>;

const gzip = async (text: string): Promise<Uint8Array<ArrayBuffer>> =>
    new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());

const gunzip = (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
    new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();

/** An R2 double over a Map. */
const memoryBucket = (initial: Record<string, Uint8Array<ArrayBuffer>> = {}): { bucket: TenantBackupBucket; objects: Map<string, Uint8Array<ArrayBuffer>> } => {
    const objects = new Map(Object.entries(initial));

    return {
        bucket: {
            delete: async (keys) => {
                for (const key of [keys].flat()) {
                    objects.delete(key);
                }
            },
            get: async (key) => {
                const value = objects.get(key);

                return value ? { body: new Blob([value]).stream(), size: value.byteLength } : null;
            },
            put: async (key, value) => {
                objects.set(key, value);
            },
        },
        objects,
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

        const [stored] = [...objects.values()];

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

describe(restoreTenantSnapshot, () => {
    it("replays the snapshot in batches under the tenant's body limit and sums the outcome", async () => {
        const line = `${JSON.stringify({ doc: { _id: "x", pad: "y".repeat(1000) }, table: "t" })}\n`;
        const snapshot = line.repeat(2000);
        const bodies: string[] = [];
        const send: TenantSend = async (_path, body) => {
            bodies.push(body);

            const rows = body.split("\n").filter(Boolean).length;

            return Response.json({ conflicts: 1, errors: [], failed: [], inserted: { t: rows - 1 }, received: rows });
        };

        const summary = await restoreTenantSnapshot(send, new Blob([await gzip(snapshot)]).stream());

        expect(bodies.length).toBeGreaterThan(1);
        expect(bodies.every((body) => new TextEncoder().encode(body).byteLength <= IMPORT_BATCH_BYTES)).toBe(true);
        expect(bodies.join("")).toBe(snapshot);
        expect(summary).toStrictEqual({ conflicts: bodies.length, inserted: 2000 - bodies.length, received: 2000, rowErrors: 0, unreachableShards: 0 });
    });

    it("stops on a batch the tenant refuses", async () => {
        const send: TenantSend = () => Promise.resolve(Response.json({ error: { message: "Body too large" } }, { status: 413 }));

        await expect(restoreTenantSnapshot(send, new Blob([await gzip(SECRET_ROW)]).stream())).rejects.toThrow(/HTTP 413/u);
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
            acme: (request) =>
                Promise.resolve(
                    new URL(request.url).pathname.endsWith("/export")
                        ? new Response("current\n")
                        : Response.json({ conflicts: 0, errors: [], failed: [], inserted: { users: 1 }, received: 1 }),
                ),
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
        expect(requests.map((request) => request.path)).toStrictEqual(["/_lunora/admin/export", "/_lunora/admin/import"]);
        await expect(gunzip(objects.get("pre.ndjson.gz") ?? new Uint8Array())).resolves.toBe("current\n");
        expect(finished).toStrictEqual([
            expect.objectContaining({ id: "pre_1", status: "succeeded" }),
            expect.objectContaining({ id: "res_1", restoreInserted: 1, status: "succeeded" }),
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
