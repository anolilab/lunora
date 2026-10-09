import { describe, expect, it, vi } from "vitest";

import { apply, assertAlertsManager, overview, remove } from "../lunora/cloudflare-alerts";
import { handleCloudflareAlertRecipientsRoute } from "../src/deploy/routes/cloudflare-accounts";
import { encryptSecret } from "../src/secrets/crypto";
import type { Row } from "./_helpers/fake-ctx";
import { makeCtx, owner } from "./_helpers/fake-ctx";

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
    { Description: "Workers Standard Requests", ID: "worker_requests" },
    { Description: "Durable Objects Storage Reads", ID: "worker_durable_objects_storage_reads" },
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

        if (method === "DELETE") {
            policies.splice(index, 1);

            return Promise.resolve(Response.json({ success: true }));
        }

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
        // Connected before last month, with Account Analytics: last month was read back.
        createdAt: SEPTEMBER - 1,
        createdBy: "usr_1",
        label: "production",
        organizationId: "org_1",
        permissions: ["workersScripts", "analytics"],
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
    const tables = {
        cloudflareAccounts: [options.row ?? (await account())],
        members: options.members ?? MEMBERS,
        platformUsage: options.usage ?? [],
    };
    const fake = makeCtx(tables, { now: NOW });

    return { ...fake, ctx: Object.assign(fake.ctx, { env: options.env ?? { SECRET_ENCRYPTION_KEY: KEY }, fetch }), tables };
};

const audits = (ops: ReturnType<typeof makeCtx>["ops"]): Row[] => ops.flatMap((op) => (op.kind === "insert" && op.table === "auditLog" ? [op.document] : []));

const ARGS = { id: "cfa_1" as never, organizationId: "org_1" as never };

describe("cloudflareAlerts.overview", () => {
    it("proposes thresholds from last month's usage of this account, by product id", async () => {
        const { fetch } = fakeNotifications({
            policies: [
                { alert_type: "billing_usage_alert", filters: { limit: ["9"], product: ["worker_durable_objects_storage_reads"] }, id: "own", name: "mine" },
            ],
        });
        const { ctx } = await context(fetch, {
            usage: [
                { kind: "requests", periodStart: SEPTEMBER, placementRef: "cfa_1", quantity: 20_000_000 },
                // Another account's usage and this month's are not last month's history here.
                { kind: "requests", periodStart: SEPTEMBER, placementRef: "cfa_2", quantity: 900_000_000 },
                { kind: "requests", periodStart: Date.UTC(2026, 9, 1), placementRef: "cfa_1", quantity: 900_000_000 },
            ],
        });

        const result = await overview.handler(ctx, ARGS);

        expect(result).toMatchObject({ historyPeriodStart: SEPTEMBER, productSource: "listed", state: "ready" });
        expect(result.products.slice(0, 3)).toStrictEqual([
            {
                basis: "history",
                covered: [],
                description: "Workers Standard Requests",
                id: "worker_requests",
                lastMonth: 20_000_000,
                proposedLimit: 100_000_000,
            },
            {
                basis: "unmapped",
                covered: [{ enabled: true, limit: "9", managed: false, name: "mine", policyId: "own" }],
                description: "Durable Objects Storage Reads",
                id: "worker_durable_objects_storage_reads",
                lastMonth: null,
                proposedLimit: null,
            },
            // Durable Object requests are not read back for a connected account: never a history proposal.
            {
                basis: "no-data",
                covered: [],
                description: "Durable Objects requests",
                id: "worker_durable_objects_requests",
                lastMonth: null,
                proposedLimit: 1_000_000,
            },
        ]);
        expect(result.dashboard.budgetAlert).toBe(`https://dash.cloudflare.com/${ACCOUNT}/billing`);
    });

    it("says there is no data without Account Analytics, or for a month the account was connected during", async () => {
        const usage = [{ kind: "requests", periodStart: SEPTEMBER, placementRef: "cfa_1", quantity: 20_000_000 }];
        const unmetered = await context(fakeNotifications().fetch, { row: await account({ permissions: ["workersScripts"] }), usage });
        const midMonth = await context(fakeNotifications().fetch, { row: await account({ createdAt: SEPTEMBER + 1 }), usage });

        for (const { ctx } of [unmetered, midMonth]) {
            // eslint-disable-next-line no-await-in-loop -- two cases, read in turn
            const { products } = await overview.handler(ctx, ARGS);

            expect(products[0]).toMatchObject({ basis: "no-data", id: "worker_requests", lastMonth: null });
        }
    });

    it("offers the published product ids when Cloudflare lists none (AvailableValues: null)", async () => {
        const { ctx } = await context(fakeNotifications({ products: null }).fetch);
        const result = await overview.handler(ctx, ARGS);

        expect(result.productSource).toBe("published");
        expect(result.products.map((product) => product.id)).toContain("worker_requests");
        expect(result.products.map((product) => product.id).some((id) => id.includes("d1"))).toBe(false);
    });

    it("records a proven read of notifications on the LATEST row, audited", async () => {
        const cloudflare = fakeNotifications();
        const fake = await context(cloudflare.fetch);
        const rotated = { ...fake.tables.cloudflareAccounts[0], permissions: ["workersScripts", "analytics", "billing"] };

        // A rotation lands while Cloudflare is being read.
        cloudflare.fetch.mockImplementationOnce(async (input, init) => {
            fake.tables.cloudflareAccounts[0] = rotated;

            return cloudflare.fetch.getMockImplementation()?.(input, init) as Promise<Response>;
        });

        await overview.handler(fake.ctx, ARGS);

        expect(fake.ops).toContainEqual({ id: "cfa_1", kind: "patch", patch: { permissions: ["workersScripts", "analytics", "billing", "notifications"] } });
        expect(audits(fake.ops)).toContainEqual(
            expect.objectContaining({ action: "cloudflare_account.permission_seen", target: `${ACCOUNT}: notifications (read)` }),
        );

        const known = await context(cloudflare.fetch, { row: await account({ permissions: ["workersScripts", "notifications"] }) });

        await overview.handler(known.ctx, ARGS);

        expect(known.ops.filter((op) => op.kind === "patch")).toStrictEqual([]);
    });

    it("says when the token cannot read notifications, and when the account is not offered the alert", async () => {
        const refused = await context(fakeNotifications({ refuse: { method: "GET", status: 403 } }).fetch);

        await expect(overview.handler(refused.ctx, ARGS)).resolves.toMatchObject({ products: [], state: "missing-scope" });

        const ineligible = await context(fakeNotifications({ offered: false }).fetch);

        await expect(overview.handler(ineligible.ctx, ARGS)).resolves.toMatchObject({ products: [], state: "not-eligible" });
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
    const request = { ...ARGS, products: [{ id: "worker_requests", limit: 100_000_000 }], recipients: ["owner@example.com"] };

    it("creates a managed policy, reads back what Cloudflare stored, and audits products, thresholds and recipients", async () => {
        const cloudflare = fakeNotifications();
        const { ctx, ops } = await context(cloudflare.fetch);

        await expect(apply.handler(ctx, request)).resolves.toStrictEqual({
            results: [
                {
                    action: "created",
                    duplicates: 0,
                    keptDestinations: 0,
                    keptRecipients: [],
                    kind: null,
                    message: null,
                    productId: "worker_requests",
                    stored: [{ destinations: 0, enabled: true, limit: "100000000", policyId: "pol_1", recipients: ["owner@example.com"] }],
                },
            ],
        });
        expect(cloudflare.policies[0]).toMatchObject({
            alert_type: "billing_usage_alert",
            filters: { limit: ["100000000"], product: ["worker_requests"] },
            name: "Lunora Cloud usage alert: worker_requests",
        });
        expect(audits(ops)).toContainEqual(
            expect.objectContaining({
                action: "cloudflare_account.usage_alerts",
                actorUserId: "usr_1",
                organizationId: "org_1",
                target: `${ACCOUNT}: worker_requests=100000000 created; to owner@example.com`,
            }),
        );
    });

    it("updates in place, keeping a disable, a webhook and an added address the customer set in Cloudflare", async () => {
        const cloudflare = fakeNotifications({
            policies: [
                {
                    alert_type: "billing_usage_alert",
                    enabled: false,
                    filters: { limit: ["5"], product: ["worker_requests"] },
                    id: "pol_m",
                    mechanisms: { email: [{ id: "finance@example.com" }], webhooks: [{ id: "wh_1" }] },
                    name: "Lunora Cloud usage alert: worker_requests",
                },
            ],
        });
        const { ctx } = await context(cloudflare.fetch);
        const { results } = await apply.handler(ctx, request);

        expect(cloudflare.policies).toHaveLength(1);
        expect(cloudflare.policies[0]).toMatchObject({
            enabled: false,
            filters: { limit: ["100000000"] },
            id: "pol_m",
            mechanisms: { email: [{ id: "finance@example.com" }, { id: "owner@example.com" }], webhooks: [{ id: "wh_1" }] },
        });
        expect(results[0]).toMatchObject({
            action: "updated",
            keptDestinations: 1,
            keptRecipients: ["finance@example.com"],
            stored: [{ destinations: 1, enabled: false, limit: "100000000", recipients: ["finance@example.com", "owner@example.com"] }],
        });
    });

    it("updates every duplicate managed policy two concurrent setups left, and reports them", async () => {
        const name = "Lunora Cloud usage alert: worker_requests";
        const cloudflare = fakeNotifications({
            policies: [
                { alert_type: "billing_usage_alert", filters: { limit: ["1"], product: ["worker_requests"] }, id: "pol_a", name },
                { alert_type: "billing_usage_alert", filters: { limit: ["2"], product: ["worker_requests"] }, id: "pol_b", name },
            ],
        });
        const { ctx } = await context(cloudflare.fetch);
        const { results } = await apply.handler(ctx, request);

        expect(cloudflare.policies.map((policy) => (policy["filters"] as { limit: string[] }).limit[0])).toStrictEqual(["100000000", "100000000"]);
        expect(results[0]).toMatchObject({ action: "updated", duplicates: 1 });
        expect(results[0]?.stored).toHaveLength(2);
    });

    it("refuses a product Cloudflare neither lists nor publishes, writing nothing", async () => {
        const cloudflare = fakeNotifications();
        const { ctx, ops } = await context(cloudflare.fetch);

        await expect(apply.handler(ctx, { ...request, products: [{ id: "d1_rows_read", limit: 5 }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(cloudflare.fetch.mock.calls.filter(([, init]) => init?.method === "POST" || init?.method === "PUT")).toStrictEqual([]);
        expect(audits(ops)).toStrictEqual([]);
    });

    it("reports a refused write as a missing scope for every product, after the first refusal stops trying", async () => {
        const cloudflare = fakeNotifications({ refuse: { method: "POST", status: 403 } });
        const { ctx, ops } = await context(cloudflare.fetch);
        const { results } = await apply.handler(ctx, {
            ...request,
            products: [
                { id: "worker_requests", limit: 100 },
                { id: "worker_durable_objects_requests", limit: 100 },
            ],
        });

        expect(results.map((result) => [result.action, result.kind])).toStrictEqual([
            ["failed", "missing-scope"],
            ["failed", "missing-scope"],
        ]);
        expect(cloudflare.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
        expect(JSON.stringify(results)).not.toContain(TOKEN);

        const failedLines = ["worker_requests", "worker_durable_objects_requests"].map((id) => `${id}=100 failed`).join(", ");

        expect(audits(ops)[0]?.["target"]).toBe(`${ACCOUNT}: ${failedLines}; to owner@example.com`);
    });

    it("refuses a member, a bad recipient and a bad threshold with the shared messages, before calling Cloudflare", async () => {
        const { fetch } = fakeNotifications();
        const member = await context(fetch, { members: [{ _id: "m_3", organizationId: "org_1", role: "member", userId: "usr_1" }] });

        await expect(apply.handler(member.ctx, request)).rejects.toMatchObject({ code: "FORBIDDEN" });

        const owned = await context(fetch);

        await expect(apply.handler(owned.ctx, { ...request, recipients: ["nope"] })).rejects.toMatchObject({
            code: "BAD_REQUEST",
            message: 'recipients: "nope" is not an email address',
        });
        await expect(apply.handler(owned.ctx, { ...request, products: [{ id: "worker_requests", limit: 2e15 }] })).rejects.toMatchObject({
            code: "BAD_REQUEST",
            message: "worker_requests: a threshold must be a whole number from 1 to 1e+15",
        });
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe("cloudflareAlerts.remove", () => {
    it("deletes only the Lunora-managed policies, audited", async () => {
        const cloudflare = fakeNotifications({
            policies: [
                {
                    alert_type: "billing_usage_alert",
                    filters: { product: ["worker_requests"] },
                    id: "pol_m",
                    name: "Lunora Cloud usage alert: worker_requests",
                },
                { alert_type: "billing_usage_alert", filters: { product: ["worker_requests"] }, id: "own", name: "my own alert" },
            ],
        });
        const { ctx, ops } = await context(cloudflare.fetch);

        await expect(remove.handler(ctx, ARGS)).resolves.toStrictEqual({ failed: [], removed: ["Lunora Cloud usage alert: worker_requests"] });
        expect(cloudflare.policies.map((policy) => policy["id"])).toStrictEqual(["own"]);
        expect(audits(ops)).toContainEqual(
            expect.objectContaining({
                action: "cloudflare_account.usage_alerts_remove",
                target: `${ACCOUNT}: removed Lunora Cloud usage alert: worker_requests; 0 failed`,
            }),
        );
    });

    it("refuses a member, and deletes nothing when the policies cannot be listed", async () => {
        const { fetch } = fakeNotifications();
        const member = await context(fetch, { members: [{ _id: "m_3", organizationId: "org_1", role: "member", userId: "usr_1" }] });

        await expect(remove.handler(member.ctx, ARGS)).rejects.toMatchObject({ code: "FORBIDDEN" });

        const refusing = fakeNotifications({ refuse: { method: "GET", status: 403 } });
        const owned = await context(refusing.fetch);

        await expect(remove.handler(owned.ctx, ARGS)).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(refusing.fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toStrictEqual([]);
    });
});

describe("default alert recipients", () => {
    it("asserts an owner or admin, and refuses a member", async () => {
        const { ctx } = await context(fakeNotifications().fetch);

        await expect(assertAlertsManager.handler(ctx, { organizationId: "org_1" as never })).resolves.toBeNull();

        const member = await context(fakeNotifications().fetch, { members: [{ _id: "m_3", organizationId: "org_1", role: "member", userId: "usr_1" }] });

        await expect(assertAlertsManager.handler(member.ctx, { organizationId: "org_1" as never })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    const environment = (runQuery: unknown) => {
        return { __lunoraCtx: { runAction: vi.fn<() => Promise<never>>(), runMutation: vi.fn<() => Promise<never>>(), runQuery: runQuery as never } };
    };
    const post = async (body: unknown, runQuery: unknown, lookup: (environment: unknown, organizationId: string) => Promise<string[]>) =>
        handleCloudflareAlertRecipientsRoute(
            new Request("https://cloud.test/v1/cloudflare-accounts/alert-recipients", { body: JSON.stringify(body), method: "POST" }),
            environment(runQuery),
            lookup,
        );

    it("answers the shared owners-and-admins lookup once the caller is authorized", async () => {
        const runQuery = vi.fn<(reference: unknown, args?: Record<string, unknown>) => Promise<unknown>>(() => Promise.resolve(null));
        const lookup = vi.fn<(environment: unknown, organizationId: string) => Promise<string[]>>(() => Promise.resolve(["admin@example.com"]));
        const response = await post({ organizationId: "org_1" }, runQuery, lookup);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ recipients: ["admin@example.com"] });
        expect(runQuery.mock.calls[0]?.[1]).toStrictEqual({ organizationId: "org_1" });
        expect(lookup.mock.calls[0]?.[1]).toBe("org_1");
    });

    it("answers the query's refusal without looking anyone up, and a 400 without an organization", async () => {
        const lookup = vi.fn<(environment: unknown, organizationId: string) => Promise<string[]>>(() => Promise.resolve([]));
        const refusing = vi.fn<() => Promise<never>>(() => Promise.reject(new Error("forbidden")));
        const refused = await post({ organizationId: "org_1" }, refusing, lookup);
        const missing = await post({}, refusing, lookup);

        expect(refused.status).toBe(403);
        expect(missing.status).toBe(400);
        expect(lookup).not.toHaveBeenCalled();
    });
});
