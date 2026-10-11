import { describe, expect, it } from "vitest";

import { exportMine } from "../lunora/account";
import { purgeDeleted } from "../lunora/organizations";
import { prune } from "../lunora/retention";
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
            memberships: { organizationId: string; role: string }[];
            truncated: boolean;
        };

        expect(exported.memberships).toStrictEqual([{ createdAt: 1, organizationId: "org_1", role: "owner" }]);
        expect(exported.auditEntries.map((entry) => entry.action)).toStrictEqual(["project.create"]);
        expect(exported.truncated).toBe(false);
    });
});
