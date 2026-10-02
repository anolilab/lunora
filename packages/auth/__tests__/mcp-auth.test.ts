import { describe, expect, it } from "vitest";

import { mcpDiscoveryPaths, requireMcpAuth } from "../src/mcp-auth";
import { jwt, mcp } from "../src/plugins";
import createMemoryAuth from "./helpers/memory-auth";

const ORIGIN = "https://api.example.com";
const RESOURCE = `${ORIGIN}/mcp`;

const buildAuth = () =>
    createMemoryAuth({
        baseURL: ORIGIN,
        plugins: [jwt(), mcp({ consentPage: "/consent", loginPage: "/login", resource: RESOURCE, scopes: ["lunora:read"] })],
        secret: "x".repeat(32),
    });

const okHandler = async (): Promise<Response> => new Response("ok");

describe(requireMcpAuth, () => {
    // better-auth's own default for a missing `resource` is the auth `baseURL`, an
    // audience no `mcp()` token carries. The wrapper refuses to build instead.
    it.each([
        ["missing", undefined],
        ["empty", ""],
        ["relative", "/mcp"],
    ])("refuses a %s resource before serving anything", (_label, resource) => {
        expect.assertions(1);

        expect(() => requireMcpAuth(buildAuth(), okHandler, { resource } as unknown as { resource: string })).toThrow(
            expect.objectContaining({ code: "AUTH_MCP_RESOURCE_INVALID" }),
        );
    });

    it("answers an unauthenticated request with the challenge for the resource it was given", async () => {
        expect.assertions(2);

        const auth = buildAuth();
        const response = await requireMcpAuth(auth, okHandler, { resource: RESOURCE })(new Request(RESOURCE, { method: "POST" }));

        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    });
});

describe(mcpDiscoveryPaths, () => {
    it("derives the protected-resource path from the resource and the issuer path from the auth base path", () => {
        expect.assertions(2);

        expect(mcpDiscoveryPaths(RESOURCE)).toStrictEqual(["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server/api/auth"]);
        expect(mcpDiscoveryPaths(`${ORIGIN}/v1/mcp/`, "/auth/")).toStrictEqual([
            "/.well-known/oauth-protected-resource/v1/mcp",
            "/.well-known/oauth-authorization-server/auth",
        ]);
    });

    // The paths are only worth routing if better-auth answers them.
    it("names paths the mcp() auth handler serves", async () => {
        expect.assertions(2);

        const auth = buildAuth();
        const responses = await Promise.all(mcpDiscoveryPaths(RESOURCE).map(async (path) => await auth.handler(new Request(`${ORIGIN}${path}`))));

        expect(responses.map((response) => response.status)).toStrictEqual([200, 200]);
        expect(() => mcpDiscoveryPaths("mcp")).toThrow(expect.objectContaining({ code: "AUTH_MCP_RESOURCE_INVALID" }));
    });
});
