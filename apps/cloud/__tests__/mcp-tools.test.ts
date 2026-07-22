import { describe, expect, it, vi } from "vitest";

import { createDeployRouter } from "../src/deploy/router";
import type { RegisteredRoute } from "../src/deploy/route-registry";
import { createMcpRouteHandler } from "../src/mcp/handler";
import type { McpRouterLike, McpTool } from "../src/mcp/tools";
import { buildMcpTools, dispatchMcpTool } from "../src/mcp/tools";
const noop = (): Promise<Response> => Promise.resolve(new Response());

const route = (path: string, spec: RegisteredRoute<typeof noop>["spec"], method: "GET" | "POST" = "POST"): RegisteredRoute<typeof noop> => ({
    handler: noop,
    method,
    path,
    spec,
});

describe(buildMcpTools, () => {
    it("exposes only routes that opt in via spec.mcp", () => {
        const tools = buildMcpTools([
            route("/v1/deployments/rollback", { auth: "deployKey", mcp: { description: "rollback" } }),
            route("/v1/deploy", { auth: "deployKey" }), // no mcp block → not a tool
        ]);

        expect(tools.map((tool) => tool.name)).toStrictEqual(["deployments.rollback"]);
        expect(tools[0]).toMatchObject({ description: "rollback", method: "POST", path: "/v1/deployments/rollback" });
    });

    it("hard-denies token/secret/tenant-access routes even when annotated", () => {
        const tools = buildMcpTools([
            route("/v1/secrets", { auth: "session", mcp: { description: "set secret" } }),
            route("/v1/admin", { auth: "session", mcp: { description: "proxy" } }),
            route("/v1/invitations/send", { auth: "session", mcp: { description: "invite" } }),
            route("/v1/logs/tail", { auth: "tailSecret", mcp: { description: "tail" } }),
            route("/v1/mcp", { auth: "deployKey", mcp: { description: "surface" } }),
        ]);

        expect(tools).toStrictEqual([]);
    });

    it("excludes non-bearer (session / webhook) auth kinds — an agent can't drive them", () => {
        const tools = buildMcpTools([
            route("/v1/domains", { auth: "session", mcp: { description: "add domain" } }),
            route("/v1/github/webhook", { auth: "webhookHmac", mcp: { description: "hook" } }),
            route("/v1/tenants/plan", { auth: "adminToken", mcp: { description: "plan" } }, "GET"),
        ]);

        // Only the adminToken (bearer) route survives.
        expect(tools.map((tool) => tool.name)).toStrictEqual(["tenants.plan"]);
    });
});

describe(dispatchMcpTool, () => {
    const tools: McpTool[] = [{ description: "rollback", method: "POST", name: "deployments.rollback", path: "/v1/deployments/rollback" }];

    it("dispatches through the router with the caller's credential and forwards arguments", async () => {
        let seen: { authorization: string | null; body: unknown; path: string } | undefined;
        const router: McpRouterLike = {
            fetch: async (request) => {
                seen = { authorization: request.headers.get("authorization"), body: await request.json(), path: new URL(request.url).pathname };

                return Response.json({ ok: true }, { status: 200 });
            },
        };

        const result = await dispatchMcpTool(router, tools, {
            arguments: { deploymentId: "dep_1", organizationId: "org_1" },
            credential: "dk_secret",
            name: "deployments.rollback",
        });

        expect(seen).toStrictEqual({
            authorization: "Bearer dk_secret",
            body: { deploymentId: "dep_1", organizationId: "org_1" },
            path: "/v1/deployments/rollback",
        });
        expect(result).toStrictEqual({ body: { ok: true }, ok: true, status: 200 });
    });

    it("returns 404 for an unknown tool (never falls through to an un-tooled route)", async () => {
        let called = false;
        const router: McpRouterLike = {
            fetch: () => {
                called = true;

                return Promise.resolve(new Response());
            },
        };

        const result = await dispatchMcpTool(router, tools, { credential: "dk", name: "nope" });

        expect(called).toBe(false);
        expect(result).toMatchObject({ ok: false, status: 404 });
    });

    it("reports the underlying route's failure as not-ok", async () => {
        const router: McpRouterLike = { fetch: () => Promise.resolve(Response.json({ error: "denied" }, { status: 403 })) };

        const result = await dispatchMcpTool(router, tools, { credential: "dk", name: "deployments.rollback" });

        expect(result).toMatchObject({ ok: false, status: 403 });
    });
});

const jsonError = (status: number, message: string): Response => Response.json({ error: message }, { status });

describe(createMcpRouteHandler, () => {
    const rollbackRoute = route("/v1/deployments/rollback", { auth: "deployKey", mcp: { description: "rollback" } });

    const rpc = (method: string, params?: unknown): Request =>
        new Request("https://cloud/v1/mcp", {
            body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
            headers: { authorization: "Bearer dk_agent", "cf-connecting-ip": "203.0.113.7", "content-type": "application/json" },
            method: "POST",
        });

    it("401s without a bearer credential", async () => {
        const handler = createMcpRouteHandler({ jsonError, routes: [rollbackRoute], verifyKey: () => Promise.resolve(true) });
        const response = await handler(new Request("https://cloud/v1/mcp", { body: "{}", method: "POST" }), {});

        expect(response.status).toBe(401);
    });

    it("403s when the deploy key is invalid — before exposing tools/list", async () => {
        const verifyKey = vi.fn(() => Promise.resolve(false));
        const handler = createMcpRouteHandler({ jsonError, routes: [rollbackRoute], verifyKey });
        const response = await handler(rpc("tools/list"), {});

        expect(response.status).toBe(403);
        expect(verifyKey).toHaveBeenCalledWith("dk_agent", {});
    });

    it("lists only opted-in tools once the key is valid", async () => {
        const handler = createMcpRouteHandler({
            jsonError,
            routes: [rollbackRoute, route("/v1/secrets", { auth: "session" })],
            verifyKey: () => Promise.resolve(true),
        });
        const payload = (await (await handler(rpc("tools/list"), {})).json()) as { result: { tools: { name: string }[] } };

        expect(payload.result.tools.map((tool) => tool.name)).toStrictEqual(["deployments.rollback"]);
    });

    it("tools/call dispatches to the tool route with the credential + forwarded client IP", async () => {
        let seen: { authorization: string | null; body: unknown; ip: string | null; path: string } | undefined;
        const capturing: RegisteredRoute<(request: Request) => Promise<Response>> = {
            handler: async (request) => {
                seen = {
                    authorization: request.headers.get("authorization"),
                    body: await request.json(),
                    ip: request.headers.get("cf-connecting-ip"),
                    path: new URL(request.url).pathname,
                };

                return Response.json({ ok: true }, { status: 200 });
            },
            method: "POST",
            path: "/v1/deployments/rollback",
            spec: { auth: "deployKey", mcp: { description: "rollback" } },
        };

        const handler = createMcpRouteHandler({ jsonError, routes: [capturing], verifyKey: () => Promise.resolve(true) });
        const payload = (await (
            await handler(rpc("tools/call", { arguments: { deploymentId: "dep_1", organizationId: "org_1" }, name: "deployments.rollback" }), {})
        ).json()) as {
            result: { isError: boolean };
        };

        expect(seen).toStrictEqual({
            authorization: "Bearer dk_agent",
            body: { deploymentId: "dep_1", organizationId: "org_1" },
            ip: "203.0.113.7",
            path: "/v1/deployments/rollback",
        });
        expect(payload.result.isError).toBe(false);
    });

    it("reports isError for an unknown tool without dispatching anywhere", async () => {
        const handler = createMcpRouteHandler({ jsonError, routes: [rollbackRoute], verifyKey: () => Promise.resolve(true) });
        const payload = (await (await handler(rpc("tools/call", { name: "nope" }), {})).json()) as { result: { isError: boolean } };

        expect(payload.result.isError).toBe(true);
    });
});

describe("/v1/mcp endpoint (wired in the real router)", () => {
    it("constructs and 401s a tools/list with no bearer (deploy-key gated)", async () => {
        const router = createDeployRouter();
        const response = await router.fetch(
            new Request("https://cloud/v1/mcp", {
                body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

        expect(response.status).toBe(401);
    });
});
