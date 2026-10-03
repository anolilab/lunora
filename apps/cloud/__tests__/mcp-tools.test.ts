import { describe, expect, it, vi } from "vitest";

import type { RegisteredRoute } from "../src/deploy/route-registry";
import { createDeployRouter } from "../src/deploy/router";
import { createMcpRouteHandler } from "../src/mcp/handler";
import { MCP_DENY_PATHS } from "../src/mcp/tools";
import readJson from "./_helpers/read-json";

const noop = (): Promise<Response> => Promise.resolve(new Response());

const route = (path: string, spec: RegisteredRoute<typeof noop>["spec"], method: "GET" | "POST" = "POST"): RegisteredRoute<typeof noop> => {
    return {
        handler: noop,
        method,
        path,
        spec,
    };
};

const jsonError = (status: number, message: string): Response => Response.json({ error: message }, { status });

describe(createMcpRouteHandler, () => {
    const rollbackRoute = route("/v1/deployments/rollback", { auth: "deployKey", mcp: { description: "rollback" } });

    const rpc = (method: string, params?: unknown): Request =>
        new Request("https://cloud/v1/mcp", {
            body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
            headers: { authorization: "Bearer dk_agent", "cf-connecting-ip": "203.0.113.7", "content-type": "application/json" }, // gitleaks:allow -- fabricated fixture token, not a credential
            method: "POST",
        });

    it("401s without a bearer credential", async () => {
        const handler = createMcpRouteHandler({ jsonError, routes: [rollbackRoute], verifyKey: () => Promise.resolve(true) });
        const response = await handler(new Request("https://cloud/v1/mcp", { body: "{}", method: "POST" }), {});

        expect(response.status).toBe(401);
    });

    it("403s when the deploy key is invalid — before exposing tools/list", async () => {
        const verifyKey = vi.fn<(key: string, environment: unknown) => Promise<boolean>>(() => Promise.resolve(false));
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
        const response = await handler(rpc("tools/list"), {});
        const payload = await readJson<{ result: { tools: { name: string }[] } }>(response);

        expect(payload.result.tools.map((tool) => tool.name)).toStrictEqual(["deployments.rollback"]);
    });

    /**
     * The deny-list is the belt to the opt-in's suspenders, and nothing proved it
     * holds — "sensitive routes can never become tools even if one is mistakenly
     * annotated" was a claim with no test behind it. This annotates every denied
     * path as a tool, which is exactly the mistake the list exists to survive, and
     * asserts none of them surface.
     */
    it("hard-denies sensitive paths even when they are annotated as tools", async () => {
        const annotated = [...MCP_DENY_PATHS].map((path) => route(path, { auth: "deployKey", mcp: { description: "should never appear" } }));
        const handler = createMcpRouteHandler({
            jsonError,
            routes: [...annotated, rollbackRoute],
            verifyKey: () => Promise.resolve(true),
        });
        const response = await handler(rpc("tools/list"), {});
        const payload = await readJson<{ result: { tools: { name: string }[] } }>(response);

        expect(payload.result.tools.map((tool) => tool.name)).toStrictEqual(["deployments.rollback"]);
    });

    /**
     * `/v1/eject` returns a tenant's entire data snapshot in one response. It is a
     * deliberate, authorized bulk export — which is exactly why an agent holding a
     * deploy key must not be able to trigger it as a side effect of another task.
     */
    it("never exposes the bulk-export route as a tool", () => {
        expect(MCP_DENY_PATHS.has("/v1/eject")).toBe(true);
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
        const response = await handler(rpc("tools/call", { arguments: { deploymentId: "dep_1", organizationId: "org_1" }, name: "deployments.rollback" }), {});
        const payload = await readJson<{ result: { isError: boolean } }>(response);

        expect(seen).toStrictEqual({
            authorization: "Bearer dk_agent", // gitleaks:allow -- the same fabricated fixture, asserted as forwarded verbatim
            body: { deploymentId: "dep_1", organizationId: "org_1" },
            ip: "203.0.113.7",
            path: "/v1/deployments/rollback",
        });
        expect(payload.result.isError).toBe(false);
    });

    it("reports isError for an unknown tool without dispatching anywhere", async () => {
        const handler = createMcpRouteHandler({ jsonError, routes: [rollbackRoute], verifyKey: () => Promise.resolve(true) });
        const response = await handler(rpc("tools/call", { name: "nope" }), {});
        const payload = await readJson<{ result: { isError: boolean } }>(response);

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
