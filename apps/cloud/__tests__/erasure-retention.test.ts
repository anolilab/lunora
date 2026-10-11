import { describe, expect, it } from "vitest";

import { exportMine } from "../lunora/account";
import { purgeDeleted } from "../lunora/organizations";
import { remove } from "../lunora/projects";
import { prune } from "../lunora/retention";
import type { OffsiteBucket } from "../src/backup/offsite";
import { runTenantBackupSweep } from "../src/backup/tenant-sweep";
import type { TenantBackupBucket } from "../src/backup/tenant-transport";
import fakeControlPlaneDb from "./_helpers/fake-control-plane-db";
import { makeCtx, owner } from "./_helpers/fake-ctx";

/**
 * Erasure and retention for the payment mirror, the audit log and the webhook
 * de-duplication table, and the account export. The payment rules are the ones the
 * German retention duties set: personal data goes, financial records stay for their
 * statutory period, anonymised.
 */

const DAY = 24 * 60 * 60 * 1000;
const YEAR = 365 * DAY;
const NOW = 4000 * DAY;

/** Every table the organization purge reads, so the double answers each one. */
const ORG_TABLES: Record<string, unknown[]> = Object.fromEntries(
    [
        "alertRuleState",
        "alertRules",
        "alerts",
        "anomalyBaselines",
        "anomalySilences",
        "auditLog",
        "boxEnrolments",
        "boxes",
        "buildLogs",
        "builds",
        "catalogInstalls",
        "cloudflareAccounts",
        "dashboards",
        "deployKeys",
        "domains",
        "githubInstallations",
        "halts",
        "incidents",
        "invitations",
        "issues",
        "members",
        "metricPoints",
        "notificationChannels",
        "notificationDeliveries",
        "observations",
        "overageDebits",
        "platformUsage",
        "projects",
        "secrets",
        "tenantLogs",
        "uptimeChecks",
        "uptimeState",
    ].map((table) => [table, []]),
);

const deletedIds = (ops: ReturnType<typeof makeCtx>["ops"]): string[] => ops.flatMap((op) => (op.kind === "delete" ? [op.id] : []));
const patches = (ops: ReturnType<typeof makeCtx>["ops"]) => ops.flatMap((op) => (op.kind === "patch" ? [{ id: op.id, patch: op.patch }] : []));

describe("organization erasure: payment mirror", () => {
    const erasedOrganization = (extra: Record<string, unknown[]>) =>
        makeCtx(
            {
                ...ORG_TABLES,
                aliasOwnership: [],
                edgeRules: [],
                buildLogs: [],
                builds: [],
                catalogInstalls: [],
                customers: [{ _id: "cus_1", email: "buyer@example.de", providerCustomerId: "pc_1", referenceId: "org_1" }],
                deployments: [],
                domains: [],
                halts: [],
                members: [],
                organizations: [{ _id: "org_1", deletionRequestedAt: 1 }],
                paymentSessions: [{ _id: "ps_1", amountMinor: 4900, providerSessionId: "sess_1", referenceId: "org_1" }],
                projects: [],
                secrets: [],
                subscriptions: [{ _id: "sub_1", providerSubscriptionId: "subscr_1", referenceId: "org_1", state: "active" }],
                usageEvents: [{ _id: "use_1", featureId: "requests", referenceId: "org_1" }],
                ...extra,
            },
            { now: NOW },
        );

    it("deletes the customer record and the metered usage", async () => {
        const { ctx, ops } = erasedOrganization({});

        await purgeDeleted.handler(ctx, {});

        expect(deletedIds(ops)).toEqual(expect.arrayContaining(["cus_1", "use_1"]));
    });

    it("keeps financial rows, unlinked from the organization and from the provider", async () => {
        const { ctx, ops } = erasedOrganization({});

        await purgeDeleted.handler(ctx, {});

        expect(deletedIds(ops)).not.toContain("ps_1");
        expect(deletedIds(ops)).not.toContain("sub_1");
        expect(patches(ops)).toEqual(
            expect.arrayContaining([
                { id: "ps_1", patch: { providerSessionId: "erased:ps_1", referenceId: "erased" } },
                { id: "sub_1", patch: { providerSubscriptionId: "erased:sub_1", referenceId: "erased" } },
            ]),
        );
    });
});

/**
 * Tenant backups hold the tenant's application data, so an erasure must reach
 * the snapshot objects, not only their rows. A mutation cannot reach the
 * bucket: the purge deletes the projects and leaves the backup rows, and the
 * tenant backup sweep then deletes every snapshot whose project is gone —
 * primary object, then off-site copy, then the row that names them.
 */
describe("erasure: tenant backups", () => {
    const backup = (id: string, organizationId: string, projectId: string): Record<string, unknown> => {
        return {
            _id: id,
            alias: `alias-${projectId}`,
            createdAt: NOW - DAY,
            deploymentId: "dep",
            key: `tenant-backups/${organizationId}/alias-${projectId}/${id}.ndjson.gz`,
            operation: "backup",
            organizationId,
            projectId,
            status: "succeeded",
            trigger: "scheduled",
        };
    };

    const erasedBackups = [backup("bk_gone_1", "org_1", "prj_gone"), backup("bk_gone_2", "org_1", "prj_gone")];
    const liveBackups = [backup("bk_live_1", "org_2", "prj_live"), backup("bk_live_2", "org_2", "prj_live")];
    const keyOf = (row: Record<string, unknown>): string => row["key"] as string;

    /** Run the backup sweep over `tables`, recording every object and row delete in the order it happened. */
    const sweep = async (tables: Record<string, unknown[]>, options: { failPrimary?: boolean } = {}) => {
        const events: string[] = [];
        const database = fakeControlPlaneDb(tables, {
            delete: async (id) => {
                events.push(`row:${id}`);
            },
        });
        const refuseUpload = (): never => {
            throw new Error("no snapshot is due in this test");
        };
        const bucket: TenantBackupBucket = {
            createMultipartUpload: refuseUpload,
            delete: async (keys) => {
                if (options.failPrimary) {
                    throw new Error("bucket unavailable");
                }

                events.push(...[keys].flat().map((key) => `object:${key}`));
            },
            get: async () => null,
        };
        const offsite: OffsiteBucket = {
            createMultipartUpload: refuseUpload,
            delete: async (keys) => {
                events.push(...keys.map((key) => `offsite:${key}`));
            },
            list: async () => {
                return { objects: [], truncated: false };
            },
        };

        const result = await runTenantBackupSweep({ bucket, database, now: NOW, offsite, senderFor: async () => null });

        return { events, result };
    };

    /** The tables as the store holds them once the mutation's deletes have landed. */
    const afterDeletes = (tables: Record<string, Record<string, unknown>[]>, ops: ReturnType<typeof makeCtx>["ops"]): Record<string, unknown[]> => {
        const gone = new Set(deletedIds(ops));

        return Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.filter((row) => !gone.has(row["_id"] as string))]));
    };

    /** The doomed rows' events, in order: each object (primary, then off-site) strictly before its row. */
    const expectObjectsBeforeRows = (events: string[], rows: Record<string, unknown>[]): void => {
        for (const row of rows) {
            const primary = events.indexOf(`object:${keyOf(row)}`);
            const copy = events.indexOf(`offsite:${keyOf(row)}`);
            const record = events.indexOf(`row:${String(row["_id"])}`);

            expect(primary).toBeGreaterThanOrEqual(0);
            expect(copy).toBeGreaterThan(primary);
            expect(record).toBeGreaterThan(copy);
        }
    };

    it("erases a purged organization's backups and leaves a live organization's alone", async () => {
        const tables: Record<string, Record<string, unknown>[]> = {
            ...(ORG_TABLES as Record<string, Record<string, unknown>[]>),
            aliasOwnership: [],
            customers: [],
            deployments: [],
            edgeRules: [],
            organizations: [
                { _id: "org_1", deletionRequestedAt: 1 },
                { _id: "org_2", plan: "pro" },
            ],
            paymentSessions: [],
            projects: [
                { _id: "prj_gone", organizationId: "org_1" },
                { _id: "prj_live", organizationId: "org_2" },
            ],
            subscriptions: [],
            tenantBackups: [...erasedBackups, ...liveBackups],
            usageEvents: [],
        };
        const { ctx, ops } = makeCtx(tables, { now: NOW });

        await purgeDeleted.handler(ctx, {});

        // The purge takes the project and leaves the backup rows: they are what names the objects.
        expect(deletedIds(ops)).toEqual(expect.arrayContaining(["prj_gone", "org_1"]));
        expect(deletedIds(ops)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^bk_/u)]));

        const { events, result } = await sweep(afterDeletes(tables, ops));

        expect(result.pruned).toBe(erasedBackups.length);

        expectObjectsBeforeRows(events, erasedBackups);

        for (const row of liveBackups) {
            expect(events.filter((event) => event.endsWith(keyOf(row)) || event === `row:${String(row["_id"])}`)).toStrictEqual([]);
        }
    });

    it("erases a removed project's backups, objects before rows", async () => {
        const tables: Record<string, Record<string, unknown>[]> = {
            aliasOwnership: [],
            auditLog: [],
            buildLogs: [],
            builds: [],
            catalogInstalls: [],
            deployments: [],
            domains: [],
            halts: [],
            members: [owner("org_1")],
            organizations: [{ _id: "org_1", plan: "pro" }],
            projects: [
                { _id: "prj_gone", organizationId: "org_1" },
                { _id: "prj_live", organizationId: "org_1" },
            ],
            secrets: [],
            tenantBackups: [
                ...erasedBackups,
                ...liveBackups.map((row) => {
                    return { ...row, organizationId: "org_1" };
                }),
            ],
        };
        const { ctx, ops } = makeCtx(tables, { now: NOW });

        await remove.handler(ctx, { id: "prj_gone" as never, organizationId: "org_1" as never });

        expect(deletedIds(ops)).toContain("prj_gone");
        expect(deletedIds(ops)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^bk_/u)]));

        const { events, result } = await sweep(afterDeletes(tables, ops));

        expect(result.pruned).toBe(erasedBackups.length);

        expectObjectsBeforeRows(events, erasedBackups);

        expect(events.some((event) => event.includes("prj_live") || event.startsWith("row:bk_live"))).toBe(false);
    });

    it("keeps an erased project's backup row while its object cannot be deleted, so the next tick retries", async () => {
        const { events, result } = await sweep(
            {
                deployments: [],
                organizations: [],
                projects: [],
                tenantBackups: erasedBackups,
            },
            { failPrimary: true },
        );

        expect(result.pruned).toBe(0);
        expect(events).toStrictEqual([]);
    });
});

describe("retention sweep", () => {
    it("deletes anonymised financial rows only past ten years", async () => {
        const { ctx, ops } = makeCtx(
            {
                auditLog: [],
                events: [],
                paymentSessions: [
                    { _id: "old", referenceId: "erased", updatedAt: NOW - 11 * YEAR },
                    { _id: "recent", referenceId: "erased", updatedAt: NOW - 2 * YEAR },
                ],
                subscriptions: [],
            },
            { now: NOW },
        );

        const result = await prune.handler(ctx, {});

        expect(result).toStrictEqual({ auditLog: 0, events: 0, financial: 1 });
        expect(deletedIds(ops)).toEqual(["old"]);
    });

    it("never sweeps a live payment row, however old", async () => {
        const { ctx, ops } = makeCtx(
            {
                auditLog: [],
                events: [],
                paymentSessions: [{ _id: "live", referenceId: "org_1", updatedAt: NOW - 20 * YEAR }],
                subscriptions: [],
            },
            { now: NOW },
        );

        await prune.handler(ctx, {});

        expect(deletedIds(ops)).not.toContain("live");
    });

    it("deletes webhook events past ninety days and audit entries past three years", async () => {
        const { ctx, ops } = makeCtx(
            {
                auditLog: [
                    { _id: "audit_old", createdAt: NOW - 4 * YEAR },
                    { _id: "audit_new", createdAt: NOW - 1 * YEAR },
                ],
                events: [
                    { _id: "event_old", processedAt: NOW - 100 * DAY },
                    { _id: "event_new", processedAt: NOW - 30 * DAY },
                ],
                paymentSessions: [],
                subscriptions: [],
            },
            { now: NOW },
        );

        const result = await prune.handler(ctx, {});

        expect(result).toStrictEqual({ auditLog: 1, events: 1, financial: 0 });
        expect(deletedIds(ops)).toEqual(expect.arrayContaining(["audit_old", "event_old"]));
        expect(deletedIds(ops)).not.toContain("audit_new");
        expect(deletedIds(ops)).not.toContain("event_new");
    });
});

describe("account export", () => {
    it("refuses an anonymous caller", async () => {
        const { ctx } = makeCtx({ members: [], auditLog: [] }, { userId: null });

        await expect(exportMine.handler(ctx, {})).rejects.toThrow("not signed in");
    });

    it("returns only the caller's memberships and the audit entries they authored", async () => {
        const { ctx } = makeCtx(
            {
                auditLog: [
                    { _id: "a1", action: "project.create", actorUserId: "usr_me", createdAt: 1, organizationId: "org_1" },
                    { _id: "a2", action: "member.add", actorUserId: "usr_other", createdAt: 2, organizationId: "org_1" },
                ],
                members: [
                    { ...owner("org_1"), createdAt: 1, role: "owner", userId: "usr_me" },
                    { ...owner("org_2"), createdAt: 1, role: "member", userId: "usr_other" },
                ],
            },
            { now: NOW, userId: "usr_me" },
        );

        const exported = (await exportMine.handler(ctx, {})) as {
            auditEntries: { action: string }[];
            format: string;
            memberships: { organizationId: string; role: string }[];
            truncated: boolean;
        };

        expect(exported.format).toBe("lunora-account-export/2");

        expect(exported.memberships).toStrictEqual([{ createdAt: 1, organizationId: "org_1", role: "owner" }]);
        expect(exported.auditEntries.map((entry) => entry.action)).toStrictEqual(["project.create"]);
        expect(exported.truncated).toBe(false);
    });
});
