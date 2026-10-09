import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import type { TestAlert } from "../lunora/alerts";
import { createRule, prepareTestAlert, TEST_ALERT_COOLDOWN_MS } from "../lunora/alerts";
import { createDeployRouter } from "../src/deploy/router";
import type { AlertTestDeps } from "../src/deploy/routes/alerts";
import { handleAlertTestRoute } from "../src/deploy/routes/alerts";
import type { RouterEnv } from "../src/deploy/routes/shared";
import { deliverAlert } from "../src/mail/notify";
import type { AlertDelivery } from "../src/telemetry/alerts";
import type { DeliverRowsDeps } from "../src/telemetry/deliver-rows";
import { deliverAlertRows } from "../src/telemetry/deliver-rows";
import { ORG_ADMINS_DESTINATION, orgAdminEmails } from "../src/telemetry/recipients";
import { makeCtx, owner } from "./_helpers/fake-ctx";
import { memoryStore } from "./support/memory-store";

const NOW = 1_700_000_000_000;

const members = [
    { _id: "m1", organizationId: "org_1", role: "owner", userId: "u_owner" },
    { _id: "m2", organizationId: "org_1", role: "admin", userId: "u_admin" },
    { _id: "m3", organizationId: "org_1", role: "member", userId: "u_member" },
    { _id: "m4", organizationId: "org_2", role: "owner", userId: "u_other" },
];

const EMAILS: Record<string, string> = {
    u_admin: "Admin@Example.com",
    u_member: "member@example.com",
    u_other: "other@example.com",
    u_owner: "owner@example.com",
};

const lookup = async (ids: ReadonlyArray<string>): Promise<string[]> => ids.flatMap((id) => (Object.hasOwn(EMAILS, id) ? [EMAILS[id]] : []));

describe(orgAdminEmails, () => {
    it("resolves the organization's owners and admins only, lower-cased and sorted", async () => {
        expect.assertions(1);

        await expect(orgAdminEmails(memoryStore({ members }), "org_1", lookup)).resolves.toStrictEqual(["admin@example.com", "owner@example.com"]);
    });

    it("finds nobody for an organization with no owner or admin", async () => {
        expect.assertions(1);

        await expect(orgAdminEmails(memoryStore({ members: [members[2] as Record<string, unknown>] }), "org_1", lookup)).resolves.toStrictEqual([]);
    });
});

describe(deliverAlert, () => {
    it("refuses an owners & admins email with nobody to send to, so the row is marked failed instead of vanishing", async () => {
        expect.assertions(1);

        await expect(deliverAlert({}, { body: "b", channel: "email", destination: ORG_ADMINS_DESTINATION, subject: "s" }, [])).rejects.toThrow(
            /no owner or admin email address/u,
        );
    });
});

describe(deliverAlertRows, () => {
    const delivery = (id: string, destination: string): AlertDelivery => {
        return { body: "b", channel: "email", destination, id, subject: "s" };
    };

    it("resolves an owners & admins row from its own organization, and leaves an ordinary address alone", async () => {
        expect.assertions(3);

        const store = memoryStore({
            alerts: [
                { _id: "a1", organizationId: "org_1", status: "firing" },
                { _id: "a2", organizationId: "org_1", status: "firing" },
            ],
            members,
        });
        const deliver: Mock<DeliverRowsDeps["deliver"]> = vi.fn<DeliverRowsDeps["deliver"]>(async () => undefined);

        await deliverAlertRows(store, [delivery("a1", ORG_ADMINS_DESTINATION), delivery("a2", "ops@example.com")], NOW, {
            adminEmails: async (organizationId) => orgAdminEmails(store, organizationId, lookup),
            deliver,
        });

        expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }), ["admin@example.com", "owner@example.com"]);
        expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" }), undefined);
        expect(store.tables["alerts"]?.map((row) => row["status"])).toStrictEqual(["delivered", "delivered"]);
    });

    it("marks a row failed when its send throws", async () => {
        expect.assertions(1);

        const store = memoryStore({ alerts: [{ _id: "a1", organizationId: "org_1", status: "firing" }] });

        await deliverAlertRows(store, [delivery("a1", ORG_ADMINS_DESTINATION)], NOW, {
            adminEmails: async () => [],
            deliver: async () => {
                throw new Error("no owner or admin email address to deliver to");
            },
        });

        expect(store.tables["alerts"]?.[0]).toMatchObject({ status: "failed" });
    });
});

const rule = (over: Record<string, unknown> = {}): Record<string, unknown> => {
    return {
        _id: "rule_1",
        channel: "webhook",
        destination: "https://hooks.example.com/x",
        enabled: true,
        name: "Errors",
        organizationId: "org_1",
        target: "error_rate",
        ...over,
    };
};

describe("alerts.prepareTestAlert", () => {
    it("renders a test for an owner's rule, stamps the rule and audits the request", async () => {
        expect.assertions(3);

        const { ctx, ops } = makeCtx({ alertRules: [rule()], members: [owner("org_1")] }, { now: NOW });

        await expect(prepareTestAlert.handler(ctx, { organizationId: "org_1" as never, ruleId: "rule_1" as never })).resolves.toMatchObject({
            channel: "webhook",
            destination: "https://hooks.example.com/x",
            organizationId: "org_1",
            subject: "[Lunora] Test: Errors",
        });
        expect(ops).toContainEqual(expect.objectContaining({ id: "rule_1", kind: "patch", patch: { lastTestedAt: NOW } }));
        expect(ops).toContainEqual(
            expect.objectContaining({ document: expect.objectContaining({ action: "alert_rule.test", target: "Errors" }), table: "auditLog" }),
        );
    });

    it("refuses a member who is not an owner or admin", async () => {
        expect.assertions(1);

        const { ctx } = makeCtx({ alertRules: [rule()], members: [{ ...owner("org_1"), role: "member" }] }, { now: NOW });

        await expect(prepareTestAlert.handler(ctx, { organizationId: "org_1" as never, ruleId: "rule_1" as never })).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
    });

    it("refuses another organization's rule as not found", async () => {
        expect.assertions(1);

        const { ctx } = makeCtx({ alertRules: [rule({ organizationId: "org_2" })], members: [owner("org_1")] }, { now: NOW });

        await expect(prepareTestAlert.handler(ctx, { organizationId: "org_1" as never, ruleId: "rule_1" as never })).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
    });

    it("throttles a rule tested a moment ago", async () => {
        expect.assertions(2);

        const recent = makeCtx({ alertRules: [rule({ lastTestedAt: NOW - 1000 })], members: [owner("org_1")] }, { now: NOW });
        const later = makeCtx({ alertRules: [rule({ lastTestedAt: NOW - TEST_ALERT_COOLDOWN_MS })], members: [owner("org_1")] }, { now: NOW });

        await expect(prepareTestAlert.handler(recent.ctx, { organizationId: "org_1" as never, ruleId: "rule_1" as never })).rejects.toMatchObject({
            code: "TOO_MANY_REQUESTS",
        });
        await expect(prepareTestAlert.handler(later.ctx, { organizationId: "org_1" as never, ruleId: "rule_1" as never })).resolves.toBeDefined();
    });
});

describe("alerts.createRule email destinations", () => {
    const create = async (destination: string) => {
        const { ctx } = makeCtx({ members: [owner("org_1")] }, { now: NOW });

        return createRule.handler(ctx, { channel: "email", destination, name: "Spend", organizationId: "org_1" as never, target: "spend", threshold: 0 });
    };

    it("accepts an address or the organization's owners & admins", async () => {
        expect.assertions(2);

        await expect(create("ops@example.com")).resolves.toBeDefined();
        await expect(create(ORG_ADMINS_DESTINATION)).resolves.toBeDefined();
    });

    it("refuses anything else, naming the alternative", async () => {
        expect.assertions(1);

        await expect(create("not an address")).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining(ORG_ADMINS_DESTINATION) });
    });
});

describe("pOST /v1/alerts/test", () => {
    const test: TestAlert = { body: "b", channel: "email", destination: ORG_ADMINS_DESTINATION, organizationId: "org_1", subject: "[Lunora] Test: Spend" };
    const environment = (runMutation: () => Promise<unknown>): RouterEnv =>
        ({ __lunoraCtx: { runAction: vi.fn<() => Promise<unknown>>(), runMutation, runQuery: vi.fn<() => Promise<unknown>>() } }) as unknown as RouterEnv;
    const request = (body: unknown): Request => new Request("https://control.lunora.app/v1/alerts/test", { body: JSON.stringify(body), method: "POST" });

    it("needs an organization and a rule", async () => {
        expect.assertions(1);

        const response = await handleAlertTestRoute(
            request({ organizationId: "org_1" }),
            environment(async () => test),
        );

        expect(response.status).toBe(400);
    });

    it("sends an owners & admins test to the resolved addresses and says who got it", async () => {
        expect.assertions(2);

        const deliver: Mock<AlertTestDeps["deliver"]> = vi.fn<AlertTestDeps["deliver"]>(async () => undefined);
        const response = await handleAlertTestRoute(
            request({ organizationId: "org_1", ruleId: "rule_1" }),
            environment(async () => test),
            {
                adminEmails: async () => ["owner@example.com"],
                deliver,
            },
        );

        await expect(response.json()).resolves.toStrictEqual({ ok: true, recipients: ["owner@example.com"] });
        expect(deliver).toHaveBeenCalledWith(expect.anything(), test, ["owner@example.com"]);
    });

    it("answers the send's own error with 502, so a wrong destination is found now", async () => {
        expect.assertions(2);

        const response = await handleAlertTestRoute(
            request({ organizationId: "org_1", ruleId: "rule_1" }),
            environment(async () => {
                return { ...test, channel: "webhook", destination: "https://hooks.example.com/x" };
            }),
            {
                adminEmails: async () => [],
                deliver: async () => {
                    throw new Error("webhook delivery failed: 404");
                },
            },
        );

        expect(response.status).toBe(502);
        await expect(response.json()).resolves.toStrictEqual({ error: "webhook delivery failed: 404", ok: false });
    });
});

describe("pOST /v1/telemetry inline delivery", () => {
    it("leaves an owners & admins alert firing for the drain, and marks only what it sent as delivered", async () => {
        expect.assertions(3);

        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
        const marked: unknown[] = [];
        const runMutation = vi.fn<(reference: unknown, args?: Record<string, unknown>) => Promise<unknown>>(async (_reference, args) => {
            if (args && "ids" in args) {
                marked.push(args["ids"]);

                return undefined;
            }

            return {
                alerts: [
                    { body: "b", channel: "email", destination: ORG_ADMINS_DESTINATION, id: "a_admins", subject: "s" },
                    { body: "b", channel: "webhook", destination: "https://hooks.example.com/x", id: "a_hook", subject: "s" },
                ],
                incidents: 0,
                issues: 0,
            };
        });
        const environment = { __lunoraCtx: { runAction: vi.fn<() => Promise<unknown>>(), runMutation, runQuery: vi.fn<() => Promise<unknown>>() } } as unknown;

        const response = await createDeployRouter().fetch(
            new Request("https://cloud.test/v1/telemetry", {
                body: JSON.stringify({ deployKey: "k", organizationId: "org_1" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
            environment,
        );
        const sent = fetchSpy.mock.calls.map(([url]) => {
            if (typeof url === "string") {
                return url;
            }

            return url instanceof URL ? url.href : url.url;
        });

        fetchSpy.mockRestore();

        expect(response.status).toBe(200);
        expect(sent).toStrictEqual(["https://hooks.example.com/x"]);
        expect(marked).toStrictEqual([["a_hook"]]);
    });
});
