import { describe, expect, it, vi } from "vitest";

import { createDeployRouter } from "../src/deploy/router";
import { mcpToolRoutes } from "../src/mcp/tools";

/**
 * The admin table is its own router seam: `LUNORA_ADMIN_TOKEN` authorizes the
 * dispatcher/operator routes and nothing else, and nothing else authorizes them.
 * Every case asserts the context was never touched — a refusal that still ran
 * the handler would be a refusal in name only.
 */

type ActionPort = (reference: unknown, args?: Record<string, unknown>) => Promise<unknown>;

const ADMIN_TOKEN = "platform-admin-token";
// A well-formed-looking deploy key and session token: real credentials of the wrong class.
const DEPLOY_KEY = "lk_live_deploykey";
const SESSION_TOKEN = "session.signature";

const makeCtx = () => {
    return {
        runAction: vi.fn<ActionPort>().mockResolvedValue({}),
        runMutation: vi.fn<ActionPort>().mockResolvedValue(null),
        runQuery: vi.fn<ActionPort>().mockResolvedValue(null),
    };
};

const untouched = (ctx: ReturnType<typeof makeCtx>): void => {
    expect(ctx.runAction).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
    expect(ctx.runQuery).not.toHaveBeenCalled();
};

const request = (method: "GET" | "POST", path: string, headers: Record<string, string>): Request =>
    new Request(`https://control.lunora.app${path}`, {
        ...(method === "POST" ? { body: "{}" } : {}),
        headers: { "cf-connecting-ip": "caller", "content-type": "application/json", ...headers },
        method,
    });

const ADMIN_ROUTES = [
    ["GET", "/v1/tenants/plan?script=acme"],
    ["POST", "/v1/tenants/preview-auth"],
    ["GET", "/v1/tenants/custom-domain?host=acme.example"],
    ["POST", "/v1/cells"],
    ["POST", "/v1/builds/dispatch"],
    ["POST", "/v1/builds/run"],
    ["POST", "/v1/hostd/releases"],
    ["POST", "/v1/hostd/rollout"],
] as const;

const WRONG_CREDENTIALS: ReadonlyArray<[string, Record<string, string>]> = [
    ["no credential", {}],
    ["a deploy key", { authorization: `Bearer ${DEPLOY_KEY}` }],
    ["a session cookie", { cookie: `better-auth.session_token=${SESSION_TOKEN}` }],
    ["a session bearer", { authorization: `Bearer ${SESSION_TOKEN}` }],
    ["the admin token without the Bearer scheme", { authorization: ADMIN_TOKEN }],
];

describe("the admin table", () => {
    describe.each(ADMIN_ROUTES)("%s %s", (method, path) => {
        it.each(WRONG_CREDENTIALS)("401s %s without running the handler", async (_label, headers) => {
            const ctx = makeCtx();
            const response = await createDeployRouter().fetch(request(method, path, headers), { __lunoraCtx: ctx, LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            expect(response.status).toBe(401);

            untouched(ctx);
        });

        // `Bearer ` with an empty token must not match an empty secret either.
        it.each([
            [undefined, `Bearer ${ADMIN_TOKEN}`],
            [undefined, "Bearer "],
            ["", `Bearer ${ADMIN_TOKEN}`],
            ["", "Bearer "],
        ])("fails closed when the platform admin token is %j (presented %j)", async (configured, authorization) => {
            const ctx = makeCtx();
            const response = await createDeployRouter().fetch(request(method, path, { authorization }), {
                __lunoraCtx: ctx,
                ...(configured === undefined ? {} : { LUNORA_ADMIN_TOKEN: configured }),
            });

            expect(response.status).toBe(401);

            untouched(ctx);
        });
    });

    it("lets the admin token through to the handler", async () => {
        const ctx = makeCtx();

        ctx.runQuery.mockResolvedValue({ plan: "pro" });

        const response = await createDeployRouter().fetch(request("GET", "/v1/tenants/plan?script=acme", { authorization: `Bearer ${ADMIN_TOKEN}` }), {
            __lunoraCtx: ctx,
            LUNORA_ADMIN_TOKEN: ADMIN_TOKEN,
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ plan: "pro" });
    });
});

describe("routes outside the admin table", () => {
    const deployKeyRoutes = [
        "/v1/deploy",
        "/v1/deployments/rollback",
        "/v1/eject",
        "/v1/logs",
        "/v1/logs/ingest",
        "/v1/mcp",
        "/v1/metrics",
        "/v1/telemetry",
        "/v1/traces",
        "/v1/usage",
    ];
    const sessionRoutes = ["/v1/admin", "/v1/backups", "/v1/domains", "/v1/invitations/send", "/v1/rollback", "/v1/secrets"];

    it.each([...deployKeyRoutes, ...sessionRoutes])("403s the admin token on POST %s without running the handler", async (path) => {
        const ctx = makeCtx();
        const response = await createDeployRouter().fetch(request("POST", path, { authorization: `Bearer ${ADMIN_TOKEN}` }), {
            __lunoraCtx: ctx,
            LUNORA_ADMIN_TOKEN: ADMIN_TOKEN,
        });

        expect(response.status).toBe(403);

        untouched(ctx);
    });

    it("403s the bare admin token the lenient OTLP parser would otherwise accept", async () => {
        const ctx = makeCtx();
        const response = await createDeployRouter().fetch(request("POST", "/v1/traces", { authorization: ADMIN_TOKEN }), {
            __lunoraCtx: ctx,
            LUNORA_ADMIN_TOKEN: ADMIN_TOKEN,
        });

        expect(response.status).toBe(403);

        untouched(ctx);
    });

    it("still reaches the handler with any other credential", async () => {
        const ctx = makeCtx();
        const response = await createDeployRouter().fetch(request("POST", "/v1/usage", { authorization: `Bearer ${DEPLOY_KEY}` }), {
            __lunoraCtx: ctx,
            LUNORA_ADMIN_TOKEN: ADMIN_TOKEN,
        });

        // The handler's own validation answers, not the guard.
        expect(response.status).toBe(400);
    });
});

describe("the MCP surface", () => {
    it("never exposes an adminToken route, even one annotated as a tool", () => {
        const handler = (): Promise<Response> => Promise.resolve(new Response());
        const tools = mcpToolRoutes([
            { handler, method: "POST", path: "/v1/cells", spec: { auth: "adminToken", mcp: { description: "register a cell" } } },
            { handler, method: "POST", path: "/v1/deployments/rollback", spec: { auth: "deployKey", mcp: { description: "roll back" } } },
        ]);

        expect(tools.map((entry) => entry.route.path)).toStrictEqual(["/v1/deployments/rollback"]);
    });
});
