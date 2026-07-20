import { describe, expect, it } from "vitest";

import { createDeployRouter } from "../src/deploy/router";
import type { RegisteredRoute } from "../src/deploy/route-registry";
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

describe("/v1/mcp endpoint", () => {
    it("tools/list returns the opted-in rollback tool", async () => {
        const router = createDeployRouter();
        const response = await router.fetch(
            new Request("https://cloud/v1/mcp", {
                body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
                headers: { authorization: "Bearer dk_agent", "content-type": "application/json" },
                method: "POST",
            }),
        );

        expect(response.status).toBe(200);
        const payload = (await response.json()) as { result: { tools: { name: string }[] } };

        expect(payload.result.tools.map((tool) => tool.name)).toContain("deployments.rollback");
        // The surface never lists itself or any sensitive route.
        expect(payload.result.tools.map((tool) => tool.name)).not.toContain("mcp");
        expect(payload.result.tools.map((tool) => tool.name)).not.toContain("secrets");
    });

    it("401s without a bearer credential", async () => {
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

    it("tools/call dispatches to the tool's route (reaches the handler)", async () => {
        const router = createDeployRouter();
        const response = await router.fetch(
            new Request("https://cloud/v1/mcp", {
                body: JSON.stringify({
                    id: 2,
                    jsonrpc: "2.0",
                    method: "tools/call",
                    params: { arguments: { deploymentId: "dep_1", organizationId: "org_1" }, name: "deployments.rollback" },
                }),
                headers: { authorization: "Bearer dk_agent", "content-type": "application/json" },
                method: "POST",
            }),
        );

        // No lunora action context is injected in this unit test, so the rollback
        // handler returns its 500 — but reaching it proves the tool dispatched
        // through the real router (same path an HTTP caller takes).
        const payload = (await response.json()) as { result: { isError: boolean } };

        expect(response.status).toBe(200);
        expect(payload.result.isError).toBe(true);
    });
});
