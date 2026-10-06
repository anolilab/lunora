import { describe, expect, it } from "vitest";

import { costTarget } from "../lunora/cloudflare-accounts";
import { billingSummary } from "../lunora/usage";
import { periodStartOf, RATE_CARD } from "../src/billing/spend";
import { hashDeployKey } from "../src/deploy/keys";
import { createDeployRouter } from "../src/deploy/router";
import type { RouterEnv } from "../src/deploy/routes/shared";
import { handleCloudflareCostsRoute, handleUsageSummaryRoute } from "../src/deploy/routes/usage";
import { makeCtx } from "./_helpers/fake-ctx";
import readJson from "./_helpers/read-json";

/**
 * Agent-queryable billing (plan 365 W6): the usage / spend / cost reads behind
 * the `usage.summary` and `usage.cloudflare-costs` MCP tools. What must hold:
 * only an organization-wide, deploy-capable key of the organization reads its
 * bill; every row is the key's organization's; and the surface never grows an
 * admin-token route.
 */

const KEY = "production:org_1|agent-secret";
const NOW = Date.UTC(2026, 9, 16); // half-way through October
const PERIOD = periodStartOf(NOW);

const keyRow = async (over: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    return { _id: "dk_1", capability: "deploy", hashedKey: await hashDeployKey(KEY), organizationId: "org_1", ...over };
};

const world = async (key: Record<string, unknown> = {}) =>
    makeCtx(
        {
            cloudflareAccounts: [
                { _id: "cfa_1", accountId: "a".repeat(32), ciphertext: "sealed", iv: "iv", organizationId: "org_1", permissions: ["billing"] },
                { _id: "cfa_2", accountId: "b".repeat(32), ciphertext: "theirs", iv: "iv", organizationId: "org_2", permissions: ["billing"] },
            ],
            deployKeys: [await keyRow(key)],
            organizations: [
                { _id: "org_1", plan: "free" },
                { _id: "org_2", plan: "free" },
            ],
            platformUsage: [
                { _id: "u1", kind: "requests", organizationId: "org_1", periodStart: PERIOD, quantity: 1_000_000 },
                { _id: "u2", kind: "doDurationGbS", organizationId: "org_1", periodStart: PERIOD, quantity: 100 },
                // Display-only (a host the org owns) — never priced.
                { _id: "u3", billable: false, kind: "requests", organizationId: "org_1", periodStart: PERIOD, quantity: 9e9 },
                { _id: "u4", kind: "requests", organizationId: "org_2", periodStart: PERIOD, quantity: 9e9 },
            ],
        },
        { now: NOW, userId: null },
    );

const summarize = async (ctx: Awaited<ReturnType<typeof world>>["ctx"], args: Record<string, unknown> = {}) =>
    billingSummary.handler(ctx, { deployKey: KEY, organizationId: "org_1", ...args } as never);

describe("usage.billingSummary", () => {
    it("prices only the key's organization's billable rows and projects the open period", async () => {
        const { ctx } = await world();
        const summary = await summarize(ctx);
        const nanoCents = 1_000_000 * RATE_CARD.requests.nanoCentsPerUnit + 100 * RATE_CARD.doDurationGbS.nanoCentsPerUnit;
        const spendMinor = Math.round(nanoCents / 1e9);

        expect(summary).toMatchObject({ capMinor: 500, level: "ok", periodStart: PERIOD, spendMinor, suspended: false, warnMinor: 400 });
        expect(summary.breakdown.map((line) => line.meter)).toStrictEqual(["requests", "doDurationGbS"]);
        // 15 of 31 days elapsed.
        expect(summary.projectedSpendMinor).toBe(Math.round((spendMinor * 31) / 15));
    });

    it("does not project a closed period", async () => {
        const { ctx } = await world();
        const previous = Date.UTC(2026, 8, 1);
        const summary = await summarize(ctx, { periodStart: previous });

        expect(summary).toMatchObject({ periodEnd: PERIOD, periodStart: previous, projectedSpendMinor: 0, spendMinor: 0 });
    });

    it.each([
        ["a project-scoped key", { projectId: "proj_1" }, "organization-wide"],
        ["a telemetry ingest key", { capability: "ingest" }, "telemetry ingest key"],
        ["another organization's key", { organizationId: "org_2" }, "invalid key"],
        ["a revoked key", { revokedAt: 1 }, "invalid key"],
    ])("refuses %s", async (_label, key, message) => {
        const { ctx } = await world(key);

        await expect(summarize(ctx)).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining(message) as unknown });
    });

    it.each([[PERIOD + 1], [Date.UTC(2026, 10, 1)], [-1]])("refuses periodStart %s (not a past or current month start)", async (periodStart) => {
        const { ctx } = await world();

        await expect(summarize(ctx, { periodStart })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
});

describe("cloudflareAccounts.costTarget", () => {
    it("answers the key's own organization's account", async () => {
        const { ctx } = await world();

        await expect(costTarget.handler(ctx, { deployKey: KEY, id: "cfa_1", organizationId: "org_1" } as never)).resolves.toStrictEqual({
            accountId: "a".repeat(32),
            ciphertext: "sealed",
            iv: "iv",
            permissions: ["billing"],
        });
    });

    it("never answers another organization's account", async () => {
        const { ctx } = await world();

        await expect(costTarget.handler(ctx, { deployKey: KEY, id: "cfa_2", organizationId: "org_1" } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("refuses a project-scoped key", async () => {
        const { ctx } = await world({ projectId: "proj_1" });

        await expect(costTarget.handler(ctx, { deployKey: KEY, id: "cfa_1", organizationId: "org_1" } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
});

describe("billing routes", () => {
    const request = (path: string, body: unknown, bearer: null | string = KEY): Request =>
        new Request(`https://cloud${path}`, {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json", ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }) },
            method: "POST",
        });
    const environment = (runQuery: (reference: unknown, args: Record<string, unknown>) => Promise<unknown>): RouterEnv =>
        ({ __lunoraCtx: { runQuery } }) as unknown as RouterEnv;

    it("401s without a bearer key, before any read", async () => {
        const response = await handleUsageSummaryRoute(
            request("/v1/usage/summary", { organizationId: "org_1" }, null),
            environment(() => Promise.reject(new Error("read"))),
        );

        expect(response.status).toBe(401);
    });

    it("authenticates with the bearer, never a key in the body", async () => {
        let seen: Record<string, unknown> | undefined;
        const response = await handleUsageSummaryRoute(
            request("/v1/usage/summary", { deployKey: "body-key", organizationId: "org_1" }),
            environment((_reference, args) => {
                seen = args;

                return Promise.resolve({ spendMinor: 1 });
            }),
        );

        expect(response.status).toBe(200);
        expect(seen).toStrictEqual({ deployKey: KEY, organizationId: "org_1" });
    });

    it("answers a cost read's status without the sealed token, and never unseals without the master key", async () => {
        const response = await handleCloudflareCostsRoute(
            request("/v1/usage/cloudflare-costs", { id: "cfa_1", organizationId: "org_1" }),
            environment(() => Promise.resolve({ accountId: "a".repeat(32), ciphertext: "sealed", iv: "iv", permissions: ["billing"] })),
        );
        const body = await readJson<Record<string, unknown>>(response);

        expect(body).toStrictEqual({ status: "unconfigured", view: null });
        expect(JSON.stringify(body)).not.toContain("sealed");
    });
});

describe("billing tools on the real MCP surface", () => {
    const toolsList = async (): Promise<string[]> => {
        const response = await createDeployRouter().fetch(
            new Request("https://cloud/v1/mcp", {
                body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
                headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
                method: "POST",
            }),
            { __lunoraCtx: { runMutation: () => Promise.resolve({ organizationId: "org_1" }) } },
        );
        const payload = await readJson<{ result: { tools: { name: string }[] } }>(response);

        return payload.result.tools.map((tool) => tool.name).toSorted((a, b) => a.localeCompare(b));
    };

    it("exposes the billing reads, and no admin-token, write or credential route", async () => {
        const tools = await toolsList();

        expect(tools).toContain("usage.summary");
        expect(tools).toContain("usage.cloudflare-costs");
        // The metering write and every admin-table route stay off the surface.
        expect(tools).not.toContain("usage");
        expect(tools.filter((name) => name.startsWith("tenants.") || name.startsWith("platform.") || name.startsWith("cloudflare-accounts"))).toStrictEqual([]);
    });
});
