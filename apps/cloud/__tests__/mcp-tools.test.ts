import { describe, expect, it, vi } from "vitest";

import { createDeployRouter } from "../src/deploy/router";
import type { RegisteredRoute } from "../src/deploy/route-registry";
import { createMcpRouteHandler } from "../src/mcp/handler";

const noop = (): Promise<Response> => Promise.resolve(new Response());

const route = (path: string, spec: RegisteredRoute<typeof noop>["spec"], method: "GET" | "POST" = "POST"): RegisteredRoute<typeof noop> => ({
    handler: noop,
    method,
    path,
    spec,
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
