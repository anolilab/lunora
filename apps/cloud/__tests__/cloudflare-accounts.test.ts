import { describe, expect, it, vi } from "vitest";

import { connect, costs, disconnect, list } from "../lunora/cloudflare-accounts";
import { CloudflareTokenError } from "../src/cloudflare/fetch";
import { handleCloudflareAccountConnectRoute } from "../src/deploy/routes/cloudflare-accounts";
import { decryptSecret, encryptSecret } from "../src/secrets/crypto";
import { inspectAccount, readScriptRequests, verifyToken } from "../src/targets/cloudflare-workers/api";
import { createCloudflareWorkersFleet } from "../src/targets/cloudflare-workers/driver";
import { resourceRefOf } from "../src/targets/placement";
import type { Row } from "./_helpers/fake-ctx";
import { makeCtx, owner } from "./_helpers/fake-ctx";

const NOW = 1_700_000_000_000;
const ACCOUNT = "a".repeat(32);
const OTHER_ACCOUNT = "b".repeat(32);
const TOKEN = "cf-token-that-must-never-leak-0123456789";

/** A fake Cloudflare API: `answers` maps a path (no query) to a status + envelope; anything else 404s. */
const fakeCloudflare = (answers: Record<string, { body: unknown; status?: number }>) =>
    vi.fn<typeof fetch>((input) => {
        const url = input instanceof Request ? input.url : String(input);
        const path = new URL(url).pathname.replace("/client/v4", "");

        return Promise.resolve(
            Object.hasOwn(answers, path)
                ? Response.json(answers[path]?.body, { status: answers[path]?.status ?? 200 })
                : Response.json({ errors: [{ message: "not found" }], success: false }, { status: 404 }),
        );
    });

const ok = (result: unknown) => {
    return { body: { result, success: true } };
};

const refused = { body: { errors: [{ code: 10_000, message: "Authentication error" }], success: false }, status: 403 };

/** An account whose token holds Workers Scripts and D1, but not KV/R2/Queues/Analytics. */
const healthyAccount = (overrides: Record<string, { body: unknown; status?: number }> = {}) =>
    fakeCloudflare({
        [`/accounts/${ACCOUNT}`]: ok({ name: "Acme" }),
        [`/accounts/${ACCOUNT}/d1/database`]: ok([]),
        [`/accounts/${ACCOUNT}/storage/kv/namespaces`]: refused,
        [`/accounts/${ACCOUNT}/workers/scripts`]: ok([]),
        [`/accounts/${ACCOUNT}/workers/subdomain`]: ok({ subdomain: "acme" }),
        "/graphql": refused,
        "/user/tokens/verify": ok({ expires_on: "2027-01-01T00:00:00Z", id: "tok_1", status: "active" }),
        ...overrides,
    });

describe("the cloudflare-workers account API", () => {
    it("inspects an account: token verified, permissions probed, subdomain and name read", async () => {
        const fetch = healthyAccount();

        await expect(inspectAccount({ accountId: ACCOUNT, apiToken: TOKEN, fetch })).resolves.toStrictEqual({
            displayName: "Acme",
            permissions: ["d1", "workersScripts"],
            token: { expiresAt: Date.parse("2027-01-01T00:00:00Z"), id: "tok_1" },
            workersSubdomain: "acme",
        });

        // Read-only: nothing but GETs (and the GraphQL probe's POST) ever reaches the account.
        const methods = fetch.mock.calls.map(([, init]) => init?.method ?? "GET");

        expect(methods.filter((method) => method !== "GET")).toStrictEqual(["POST"]);
        expect(fetch.mock.calls.every(([, init]) => (init?.headers as Record<string, string>)["authorization"] === `Bearer ${TOKEN}`)).toBe(true);
    });

    it("records Billing: Read when the token may read the account's billable usage", async () => {
        const fetch = healthyAccount({ [`/accounts/${ACCOUNT}/billable-usage`]: ok([]) });

        await expect(inspectAccount({ accountId: ACCOUNT, apiToken: TOKEN, fetch })).resolves.toMatchObject({
            permissions: ["billing", "d1", "workersScripts"],
        });
    });

    it("falls back to the account-owned verify endpoint", async () => {
        const fetch = fakeCloudflare({ [`/accounts/${ACCOUNT}/tokens/verify`]: ok({ status: "active" }), "/user/tokens/verify": refused });

        await expect(verifyToken({ accountId: ACCOUNT, apiToken: TOKEN, fetch })).resolves.toStrictEqual({});
    });

    it("refuses an inactive token, a token without Workers Scripts, and an account without a workers.dev subdomain", async () => {
        await expect(
            inspectAccount({ accountId: ACCOUNT, apiToken: TOKEN, fetch: healthyAccount({ "/user/tokens/verify": ok({ status: "disabled" }) }) }),
        ).rejects.toThrow("the token is disabled");
        await expect(
            inspectAccount({ accountId: ACCOUNT, apiToken: TOKEN, fetch: healthyAccount({ [`/accounts/${ACCOUNT}/workers/scripts`]: refused }) }),
        ).rejects.toThrow("Workers Scripts: Edit");
        await expect(
            inspectAccount({ accountId: ACCOUNT, apiToken: TOKEN, fetch: healthyAccount({ [`/accounts/${ACCOUNT}/workers/subdomain`]: ok({}) }) }),
        ).rejects.toThrow("no workers.dev subdomain");
        await expect(inspectAccount({ accountId: "acme", apiToken: TOKEN, fetch: healthyAccount() })).rejects.toBeInstanceOf(CloudflareTokenError);
    });

    it("never puts the token in an error", async () => {
        const fetch = fakeCloudflare({ "/user/tokens/verify": { body: { errors: [{ message: "boom" }], success: false }, status: 500 } });
        const error = await verifyToken({ accountId: ACCOUNT, apiToken: TOKEN, fetch }).catch((error_: unknown) => error_);

        expect(String(error)).not.toContain(TOKEN);
    });

    it("reads requests per script since a checkpoint from the GraphQL Analytics API", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(() =>
            Promise.resolve(
                Response.json({
                    data: {
                        viewer: {
                            accounts: [
                                {
                                    workersInvocationsAdaptive: [
                                        { dimensions: { scriptName: "web" }, sum: { requests: 40 } },
                                        { dimensions: { scriptName: "web" }, sum: { requests: 2 } },
                                        { dimensions: { scriptName: "api" }, sum: { requests: 0 } },
                                    ],
                                },
                            ],
                        },
                    },
                    errors: null,
                }),
            ),
        );

        await expect(readScriptRequests({ accountId: ACCOUNT, apiToken: TOKEN, fetch }, 1000)).resolves.toStrictEqual([{ requests: 42, scriptName: "web" }]);

        const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as { query: string; variables: Record<string, string> };

        expect(body.query).toContain("workersInvocationsAdaptive");
        expect(body.query).toContain("datetime_gt: $since");
        expect(body.variables).toStrictEqual({ accountTag: ACCOUNT, since: new Date(1000).toISOString() });
    });

    it("reports a GraphQL authorization error as a refused token", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(() =>
            Promise.resolve(Response.json({ data: null, errors: [{ message: "not authorized for that account" }] })),
        );

        await expect(readScriptRequests({ accountId: ACCOUNT, apiToken: TOKEN, fetch }, 0)).rejects.toBeInstanceOf(CloudflareTokenError);
    });
});

const account = (overrides: Row = {}): Row => {
    return {
        _id: "cfa_1",
        accountId: ACCOUNT,
        cellId: "cell_1",
        ciphertext: "sealed",
        createdAt: NOW,
        createdBy: "usr_1",
        iv: "iv",
        label: "production",
        organizationId: "org_1",
        permissions: ["workersScripts"],
        updatedAt: NOW,
        verifiedAt: NOW,
        workersSubdomain: "acme",
        ...overrides,
    };
};

const connectArgs = (overrides: Record<string, unknown> = {}) => {
    return {
        accountId: ACCOUNT,
        ciphertext: "sealed-2",
        iv: "iv-2",
        label: "production",
        organizationId: "org_1",
        permissions: ["workersScripts", "d1"],
        workersSubdomain: "acme",
        ...overrides,
    };
};

describe("the cloudflare-workers usage readback", () => {
    it("attributes a script by the resourceRef deployments.create wrote for a deployment placed in that account", async () => {
        const fleet = createCloudflareWorkersFleet({
            accounts: () => Promise.resolve(["cfa_1"]),
            credentials: () => Promise.resolve({ accountId: ACCOUNT, apiToken: TOKEN }),
            read: () => Promise.resolve([{ requests: 3, scriptName: "web" }]),
        });

        await expect(fleet.usage?.read("cfa_1", 0)).resolves.toStrictEqual([
            { requests: 3, resourceRef: resourceRefOf({ placementRef: "cfa_1", target: "cloudflare-workers" }, "web") },
        ]);
    });
});

describe("cloudflareAccounts.costs", () => {
    const KEY = "11".repeat(32);

    const run = async (row: Row, options: { env?: Record<string, unknown>; fetch?: typeof globalThis.fetch; organizationId?: string } = {}) => {
        const { ctx } = makeCtx({ cloudflareAccounts: [row], members: [owner("org_1")] });
        const context = Object.assign(ctx, { env: options.env ?? { SECRET_ENCRYPTION_KEY: KEY }, fetch: options.fetch ?? fakeCloudflare({}) });

        return costs.handler(context, { id: "cfa_1" as never, organizationId: (options.organizationId ?? "org_1") as never });
    };

    it("reads the billable usage of a connection granted Billing: Read, with its own token", async () => {
        const sealed = await encryptSecret(KEY, TOKEN);
        const fetch = fakeCloudflare({ [`/accounts/${ACCOUNT}/billable-usage`]: ok([{ cost: 1.5, period_end: "2026-09-30", product: "Workers" }]) });

        await expect(run(account({ ...sealed, permissions: ["workersScripts", "billing"] }), { fetch })).resolves.toMatchObject({
            status: "ok",
            view: { products: [{ costMinor: 150, product: "Workers" }], totalMinor: 150 },
        });
        expect((fetch.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    });

    it("answers a status, never a throw: no permission, no master key, a refused token", async () => {
        const sealed = await encryptSecret(KEY, TOKEN);
        const billing = account({ ...sealed, permissions: ["workersScripts", "billing"] });

        await expect(run(account({ ...sealed }))).resolves.toStrictEqual({ status: "no-permission", view: null });
        await expect(run(billing, { env: {} })).resolves.toStrictEqual({ status: "unconfigured", view: null });
        await expect(run(billing, { fetch: fakeCloudflare({ [`/accounts/${ACCOUNT}/billable-usage`]: refused }) })).resolves.toStrictEqual({
            status: "unauthorized",
            view: null,
        });
    });

    it("refuses another organization's connection", async () => {
        await expect(run(account({ organizationId: "org_2" }))).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
});

describe("cloudflareAccounts", () => {
    it("lists an org's connections without their ciphertext", async () => {
        const { ctx } = makeCtx({ cloudflareAccounts: [account(), account({ _id: "cfa_2", organizationId: "org_2" })], members: [owner("org_1")] });
        const views = await list.handler(ctx, { organizationId: "org_1" as never });

        expect(views).toHaveLength(1);
        expect(views[0]).not.toHaveProperty("ciphertext");
        expect(views[0]).not.toHaveProperty("iv");
    });

    it("connects an account, audits it, and refuses the same account twice", async () => {
        const fake = makeCtx(
            { cloudflareAccounts: [], members: [owner("org_1")], organizations: [{ _id: "org_1", cellId: "cell_1" }], subscriptions: [] },
            { now: NOW },
        );

        await connect.handler(fake.ctx, connectArgs() as never);

        // Stamped with its organization's cell, which converges and meters it.
        expect(fake.ops).toContainEqual(
            expect.objectContaining({
                document: expect.objectContaining({ accountId: ACCOUNT, cellId: "cell_1" }),
                kind: "insert",
                table: "cloudflareAccounts",
            }),
        );
        expect(fake.ops).toContainEqual(
            expect.objectContaining({ document: expect.objectContaining({ action: "cloudflare_account.connect", target: ACCOUNT }), table: "auditLog" }),
        );

        const again = makeCtx({ cloudflareAccounts: [account()], members: [owner("org_1")], subscriptions: [] }, { now: NOW });

        await expect(connect.handler(again.ctx, connectArgs({ accountId: ACCOUNT }) as never)).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("holds the free plan to one connected account", async () => {
        const fake = makeCtx({ cloudflareAccounts: [account()], members: [owner("org_1")], subscriptions: [] }, { now: NOW });

        await expect(connect.handler(fake.ctx, connectArgs({ accountId: OTHER_ACCOUNT }) as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("rotates a token in place, and refuses a token for another account", async () => {
        const fake = makeCtx({ cloudflareAccounts: [account()], members: [owner("org_1")] }, { now: NOW + 5 });

        await connect.handler(fake.ctx, connectArgs({ id: "cfa_1", label: "" }) as never);

        expect(fake.ops).toContainEqual({
            id: "cfa_1",
            kind: "patch",
            patch: {
                accountId: ACCOUNT,
                ciphertext: "sealed-2",
                iv: "iv-2",
                permissions: ["workersScripts", "d1"],
                updatedAt: NOW + 5,
                verifiedAt: NOW + 5,
                workersSubdomain: "acme",
            },
        });

        const other = makeCtx({ cloudflareAccounts: [account()], members: [owner("org_1")] }, { now: NOW });

        await expect(connect.handler(other.ctx, connectArgs({ accountId: OTHER_ACCOUNT, id: "cfa_1" }) as never)).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("refuses to rotate another organization's connection", async () => {
        const fake = makeCtx({ cloudflareAccounts: [account({ organizationId: "org_2" })], members: [owner("org_1")] }, { now: NOW });

        await expect(connect.handler(fake.ctx, connectArgs({ id: "cfa_1" }) as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("refuses a member who is not an owner or admin", async () => {
        const fake = makeCtx(
            { cloudflareAccounts: [], members: [{ _id: "m_1", organizationId: "org_1", role: "member", userId: "usr_1" }], subscriptions: [] },
            { now: NOW },
        );

        await expect(connect.handler(fake.ctx, connectArgs() as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("disconnects once the sweep has stamped the account's failed and destroyed deployments", async () => {
        const fake = makeCtx(
            {
                cloudflareAccounts: [account()],
                deployments: [
                    { _id: "dep_1", placementRef: "cfa_1", status: "failed", teardownAt: NOW },
                    { _id: "dep_2", placementRef: "cfa_1", status: "destroyed", teardownAt: NOW },
                ],
                members: [owner("org_1")],
                projects: [],
            },
            { now: NOW },
        );

        await disconnect.handler(fake.ctx, { id: "cfa_1" as never, organizationId: "org_1" as never });

        expect(fake.ops).toContainEqual({ id: "cfa_1", kind: "delete" });
    });

    it("disconnects an unused account and deletes its credential", async () => {
        const fake = makeCtx({ cloudflareAccounts: [account()], deployments: [], members: [owner("org_1")], projects: [] }, { now: NOW });

        await disconnect.handler(fake.ctx, { id: "cfa_1" as never, organizationId: "org_1" as never });

        expect(fake.ops).toContainEqual({ id: "cfa_1", kind: "delete" });
    });

    it("refuses to disconnect while a project or an un-torn-down deployment uses the account", async () => {
        const withProject = makeCtx(
            {
                cloudflareAccounts: [account()],
                deployments: [],
                members: [owner("org_1")],
                projects: [{ _id: "proj_1", placementRef: "cfa_1", organizationId: "org_1" }],
            },
            { now: NOW },
        );

        await expect(disconnect.handler(withProject.ctx, { id: "cfa_1" as never, organizationId: "org_1" as never })).rejects.toMatchObject({
            code: "CONFLICT",
        });

        const withDeployment = makeCtx(
            {
                cloudflareAccounts: [account()],
                deployments: [{ _id: "dep_1", placementRef: "cfa_1", status: "destroyed", teardownAt: null }],
                members: [owner("org_1")],
                projects: [],
            },
            { now: NOW },
        );

        await expect(disconnect.handler(withDeployment.ctx, { id: "cfa_1" as never, organizationId: "org_1" as never })).rejects.toMatchObject({
            code: "CONFLICT",
        });
        expect(withDeployment.ops.filter((op) => op.kind === "delete")).toStrictEqual([]);
    });
});

describe("pOST /v1/cloudflare-accounts", () => {
    const KEY = "11".repeat(32);

    const post = async (body: Record<string, unknown>, fetch: typeof globalThis.fetch) => {
        const runMutation = vi.fn<(reference: unknown, args?: Record<string, unknown>) => Promise<unknown>>(() => Promise.resolve("cfa_1"));

        vi.stubGlobal("fetch", fetch);

        try {
            const response = await handleCloudflareAccountConnectRoute(
                new Request("https://cloud.test/v1/cloudflare-accounts", { body: JSON.stringify(body), method: "POST" }),
                {
                    __lunoraCtx: { runAction: vi.fn<() => Promise<never>>(), runMutation: runMutation as never, runQuery: vi.fn<() => Promise<never>>() },
                    SECRET_ENCRYPTION_KEY: KEY,
                },
            );

            return { response, runMutation, text: await response.text() };
        } finally {
            vi.unstubAllGlobals();
        }
    };

    it("verifies the token, seals it, and stores only ciphertext", async () => {
        const { response, runMutation, text } = await post({ accountId: ACCOUNT, label: "prod", organizationId: "org_1", token: TOKEN }, healthyAccount());

        expect(response.status).toBe(200);
        expect(text).not.toContain(TOKEN);

        const args = runMutation.mock.calls[0]?.[1] as { ciphertext: string; iv: string; permissions: string[]; workersSubdomain: string };

        expect(JSON.stringify(args)).not.toContain(TOKEN);
        expect(args.permissions).toStrictEqual(["d1", "workersScripts"]);
        expect(args.workersSubdomain).toBe("acme");
        await expect(decryptSecret(KEY, { ciphertext: args.ciphertext, iv: args.iv })).resolves.toBe(TOKEN);
    });

    it("refuses a token Cloudflare does not accept, storing nothing", async () => {
        const { response, runMutation, text } = await post(
            { accountId: ACCOUNT, organizationId: "org_1", token: TOKEN },
            healthyAccount({ [`/accounts/${ACCOUNT}/tokens/verify`]: refused, "/user/tokens/verify": refused }),
        );

        expect(response.status).toBe(400);
        expect(text).not.toContain(TOKEN);
        expect(runMutation).not.toHaveBeenCalled();
    });

    it("refuses a malformed account id before calling Cloudflare", async () => {
        const fetch = healthyAccount();
        const { response } = await post({ accountId: "nope", organizationId: "org_1", token: TOKEN }, fetch);

        expect(response.status).toBe(400);
        expect(fetch).not.toHaveBeenCalled();
    });
});
