import { describe, expect, it, vi } from "vitest";

import { alertManagers, apply, overview } from "../lunora/cloudflare-alerts";
import { handleCloudflareAlertRecipientsRoute } from "../src/deploy/routes/cloudflare-accounts";
import { encryptSecret } from "../src/secrets/crypto";
import type { Row } from "./_helpers/fake-ctx";
import { makeCtx, owner } from "./_helpers/fake-ctx";

/** better-auth's `user` table, as the isolate's auth instance answers it. */
const users = vi.hoisted(() => {
    return { rows: [] as { email: string; id: string }[] };
});

vi.mock(
    import("../src/auth"),
    () =>
        ({
            currentAuth: () => {
                return {
                    $context: Promise.resolve({
                        adapter: {
                            findMany: ({ where }: { where: { value: string[] }[] }) =>
                                Promise.resolve(users.rows.filter((user) => where[0]?.value.includes(user.id))),
                        },
                    }),
                };
            },
        }) as never,
);

const NOW = Date.UTC(2026, 9, 9, 12);
const SEPTEMBER = Date.UTC(2026, 8, 1);
const ACCOUNT = "a".repeat(32);
const TOKEN = "cf-token-that-must-never-leak-0123456789";
const KEY = "11".repeat(32);

const urlOf = (input: Parameters<typeof globalThis.fetch>[0]): string => {
    if (typeof input === "string") {
        return input;
    }

    return input instanceof URL ? input.href : input.url;
};

const PRODUCTS = [
    { Description: "Workers Standard Requests", ID: "workers_requests" },
    { Description: "Argo Smart Routing", ID: "argo" },
];

/** Cloudflare's Notifications API over an in-memory policy list. `products: null` = the alert type names no products. */
const fakeNotifications = (
    options: { offered?: boolean; policies?: Record<string, unknown>[]; products?: unknown; refuse?: { method: string; status: number } } = {},
) => {
    const policies = [...(options.policies ?? [])];
    let next = 1;

    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
        const path = new URL(urlOf(input)).pathname.replace(`/client/v4/accounts/${ACCOUNT}/alerting/v3`, "");
        const method = init?.method ?? "GET";

        if (options.refuse?.method === method) {
            return Promise.resolve(
                Response.json({ errors: [{ code: 10_000, message: "Authentication error" }], success: false }, { status: options.refuse.status }),
            );
        }

        if (path === "/available_alerts") {
            const billing = {
                filter_options: [{ AvailableValues: options.products === undefined ? PRODUCTS : options.products, Key: "product" }],
                type: "billing_usage_alert",
            };

            return Promise.resolve(Response.json({ result: options.offered === false ? {} : { Billing: [billing] }, success: true }));
        }

        if (path === "/policies" && method === "GET") {
            return Promise.resolve(Response.json({ result: policies, success: true }));
        }

        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;

        if (path === "/policies" && method === "POST") {
            const id = `pol_${String(next)}`;

            next += 1;

            policies.push({ ...body, id });

            return Promise.resolve(Response.json({ result: { id }, success: true }));
        }

        const id = path.replace("/policies/", "");
        const index = policies.findIndex((policy) => policy["id"] === id);

        policies[index] = { ...body, id };

        return Promise.resolve(Response.json({ result: { id }, success: true }));
    });

    return { fetch, policies };
};

const account = async (overrides: Row = {}): Promise<Row> => {
    return {
        _id: "cfa_1",
        accountId: ACCOUNT,
        cellId: "cell_1",
        createdAt: NOW,
        createdBy: "usr_1",
        label: "production",
        organizationId: "org_1",
        permissions: ["workersScripts"],
        updatedAt: NOW,
        verifiedAt: NOW,
        workersSubdomain: "acme",
        ...(await encryptSecret(KEY, TOKEN)),
        ...overrides,
    };
};

const MEMBERS = [
    owner("org_1", "usr_1"),
    { _id: "m_2", organizationId: "org_1", role: "admin", userId: "usr_2" },
    { _id: "m_3", organizationId: "org_1", role: "member", userId: "usr_3" },
];

const context = async (fetch: typeof globalThis.fetch, options: { env?: Record<string, unknown>; members?: Row[]; row?: Row; usage?: Row[] } = {}) => {
    const fake = makeCtx(
        {
            cloudflareAccounts: [options.row ?? (await account())],
            members: options.members ?? MEMBERS,
            platformUsage: options.usage ?? [],
        },
        { now: NOW },
    );

    return { ...fake, ctx: Object.assign(fake.ctx, { env: options.env ?? { SECRET_ENCRYPTION_KEY: KEY }, fetch }) };
};

const ARGS = { id: "cfa_1" as never, organizationId: "org_1" as never };

users.rows = [
    { email: "Owner@example.com", id: "usr_1" },
    { email: "admin@example.com", id: "usr_2" },
    { email: "member@example.com", id: "usr_3" },
];

describe("cloudflareAlerts.overview", () => {
    it("proposes thresholds from last month's usage of this account", async () => {
        const { fetch } = fakeNotifications({
            policies: [{ alert_type: "billing_usage_alert", filters: { limit: ["9"], product: ["argo"] }, id: "own", name: "mine" }],
        });
        const { ctx, ops } = await context(fetch, {
            usage: [
                { kind: "requests", periodStart: SEPTEMBER, placementRef: "cfa_1", quantity: 20_000_000 },
                // Another account's usage and this month's are not last month's history here.
                { kind: "requests", periodStart: SEPTEMBER, placementRef: "cfa_2", quantity: 900_000_000 },
                { kind: "requests", periodStart: Date.UTC(2026, 9, 1), placementRef: "cfa_1", quantity: 900_000_000 },
            ],
        });

        const result = await overview.handler(ctx, ARGS);

        expect(result.state).toBe("ready");
        expect(result.historyPeriodStart).toBe(SEPTEMBER);
        // The token proved it can read notifications, though it was connected without: recorded.
        expect(ops).toContainEqual({ id: "cfa_1", kind: "patch", patch: { permissions: ["workersScripts", "notifications"] } });
        expect(result.products).toStrictEqual([
            {
                basis: "history",
                covered: [],
                description: "Workers Standard Requests",
                id: "workers_requests",
                lastMonth: 20_000_000,
                meter: "requests",
                proposedLimit: 100_000_000,
            },
            {
                basis: "unmapped",
                covered: [{ enabled: true, limit: "9", managed: false, name: "mine", policyId: "own" }],
                description: "Argo Smart Routing",
                id: "argo",
                lastMonth: null,
                meter: null,
                proposedLimit: null,
            },
        ]);
        expect(result.dashboard.budgetAlert).toBe(`https://dash.cloudflare.com/${ACCOUNT}/billing`);
    });

    it("says when the token cannot read notifications, and when the account is not offered the alert", async () => {
        const refused = await context(fakeNotifications({ refuse: { method: "GET", status: 403 } }).fetch);

        await expect(overview.handler(refused.ctx, ARGS)).resolves.toMatchObject({ products: [], state: "missing-scope" });

        const ineligible = await context(fakeNotifications({ offered: false }).fetch);

        await expect(overview.handler(ineligible.ctx, ARGS)).resolves.toMatchObject({ products: [], state: "not-eligible" });
    });

    it("offers nothing when Cloudflare names no products, rather than guessing", async () => {
        const { ctx } = await context(fakeNotifications({ products: null }).fetch);

        await expect(overview.handler(ctx, ARGS)).resolves.toMatchObject({ products: [], state: "no-products" });
    });

    it("answers unconfigured without a master key, and refuses a member or another organization's account", async () => {
        const { fetch } = fakeNotifications();
        const unkeyed = await context(fetch, { env: {} });

        await expect(overview.handler(unkeyed.ctx, ARGS)).resolves.toMatchObject({ state: "unconfigured" });
        expect(fetch).not.toHaveBeenCalled();

        const member = await context(fetch, { members: [{ _id: "m_3", organizationId: "org_1", role: "member", userId: "usr_1" }] });

        await expect(overview.handler(member.ctx, ARGS)).rejects.toMatchObject({ code: "FORBIDDEN" });

        const foreign = await context(fetch, { row: await account({ organizationId: "org_2" }) });

        await expect(overview.handler(foreign.ctx, ARGS)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
});

describe("cloudflareAlerts.apply", () => {
    const request = { ...ARGS, products: [{ id: "workers_requests", limit: 100_000_000 }], recipients: ["owner@example.com"] };

    it("creates a managed policy, then updates it in place on a second run, auditing both", async () => {
        const cloudflare = fakeNotifications();
        const first = await context(cloudflare.fetch);

        await expect(apply.handler(first.ctx, request)).resolves.toStrictEqual({
            results: [{ action: "created", kind: null, message: null, productId: "workers_requests" }],
        });
        expect(cloudflare.policies).toHaveLength(1);
        expect(cloudflare.policies[0]).toMatchObject({
            alert_type: "billing_usage_alert",
            filters: { limit: ["100000000"], product: ["workers_requests"] },
            mechanisms: { email: [{ id: "owner@example.com" }] },
            name: "Lunora Cloud usage alert: workers_requests",
        });

        const second = await context(cloudflare.fetch);

        await expect(apply.handler(second.ctx, { ...request, products: [{ id: "workers_requests", limit: 200_000_000 }] })).resolves.toMatchObject({
            results: [{ action: "updated", productId: "workers_requests" }],
        });
        expect(cloudflare.policies).toHaveLength(1);
        expect(cloudflare.policies[0]).toMatchObject({ filters: { limit: ["200000000"] }, id: "pol_1" });

        for (const { ops } of [first, second]) {
            expect(ops).toContainEqual(
                expect.objectContaining({
                    document: expect.objectContaining({ action: "cloudflare_account.usage_alerts", actorUserId: "usr_1", organizationId: "org_1" }),
                    table: "auditLog",
                }),
            );
        }
    });

    it("refuses a product Cloudflare does not list, writing nothing", async () => {
        const cloudflare = fakeNotifications();
        const { ctx, ops } = await context(cloudflare.fetch);

        await expect(apply.handler(ctx, { ...request, products: [{ id: "workers_paid_guess", limit: 5 }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(cloudflare.fetch.mock.calls.filter(([, init]) => init?.method === "POST" || init?.method === "PUT")).toStrictEqual([]);
        expect(ops.filter((op) => op.kind === "insert" && op.table === "auditLog")).toStrictEqual([]);
    });

    it("creates nothing when Cloudflare names no products", async () => {
        const cloudflare = fakeNotifications({ products: null });
        const { ctx } = await context(cloudflare.fetch);

        await expect(apply.handler(ctx, request)).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(cloudflare.policies).toStrictEqual([]);
    });

    it("reports a refused write as a missing scope for every product, after the first refusal stops trying", async () => {
        const cloudflare = fakeNotifications({
            products: [
                { Description: "Workers Standard Requests", ID: "workers_requests" },
                { Description: "D1 Rows Read", ID: "d1_rows_read" },
            ],
            refuse: { method: "POST", status: 403 },
        });
        const { ctx, ops } = await context(cloudflare.fetch);
        const { results } = await apply.handler(ctx, {
            ...request,
            products: [
                { id: "workers_requests", limit: 100 },
                { id: "d1_rows_read", limit: 100 },
            ],
        });

        expect(results.map((result) => [result.action, result.kind])).toStrictEqual([
            ["failed", "missing-scope"],
            ["failed", "missing-scope"],
        ]);
        expect(cloudflare.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
        expect(JSON.stringify(results)).not.toContain(TOKEN);
        expect(ops).toContainEqual(expect.objectContaining({ document: expect.objectContaining({ target: `${ACCOUNT}: 0 created, 0 updated, 2 failed` }) }));
    });

    it("refuses a member, a bad recipient list and a bad threshold before calling Cloudflare", async () => {
        const { fetch } = fakeNotifications();
        const member = await context(fetch, { members: [{ _id: "m_3", organizationId: "org_1", role: "member", userId: "usr_1" }] });

        await expect(apply.handler(member.ctx, request)).rejects.toMatchObject({ code: "FORBIDDEN" });

        const owned = await context(fetch);

        await expect(apply.handler(owned.ctx, { ...request, recipients: ["nope"] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
        await expect(apply.handler(owned.ctx, { ...request, products: [{ id: "workers_requests", limit: 0.5 }] })).rejects.toMatchObject({
            code: "BAD_REQUEST",
        });
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe("default alert recipients", () => {
    it("lists the user ids of owners and admins only, and refuses a member", async () => {
        const { ctx } = await context(fakeNotifications().fetch);

        await expect(alertManagers.handler(ctx, { organizationId: "org_1" as never })).resolves.toStrictEqual(["usr_1", "usr_2"]);

        const member = await context(fakeNotifications().fetch, { members: [{ _id: "m_3", organizationId: "org_1", role: "member", userId: "usr_1" }] });

        await expect(alertManagers.handler(member.ctx, { organizationId: "org_1" as never })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("resolves their addresses at the edge, lowercased and sorted", async () => {
        const runQuery = vi.fn<(reference: unknown, args?: Record<string, unknown>) => Promise<unknown>>(() => Promise.resolve(["usr_1", "usr_2"]));
        const response = await handleCloudflareAlertRecipientsRoute(
            new Request("https://cloud.test/v1/cloudflare-accounts/alert-recipients", { body: JSON.stringify({ organizationId: "org_1" }), method: "POST" }),
            { __lunoraCtx: { runAction: vi.fn<() => Promise<never>>(), runMutation: vi.fn<() => Promise<never>>(), runQuery: runQuery as never } },
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ recipients: ["admin@example.com", "owner@example.com"] });
        expect(runQuery.mock.calls[0]?.[1]).toStrictEqual({ organizationId: "org_1" });
    });

    it("answers the query's refusal, and a 400 without an organization", async () => {
        const refusing = vi.fn<() => Promise<never>>(() => Promise.reject(new Error("forbidden")));
        const environment = {
            __lunoraCtx: { runAction: vi.fn<() => Promise<never>>(), runMutation: vi.fn<() => Promise<never>>(), runQuery: refusing as never },
        };
        const post = async (body: unknown) =>
            handleCloudflareAlertRecipientsRoute(
                new Request("https://cloud.test/v1/cloudflare-accounts/alert-recipients", { body: JSON.stringify(body), method: "POST" }),
                environment,
            );

        const refused = await post({ organizationId: "org_1" });
        const missing = await post({});

        expect(refused.status).toBe(403);
        expect(missing.status).toBe(400);
    });
});
