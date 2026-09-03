import type { LunoraClient } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import type { McpAccessTokenClaims, McpAuthProtect } from "../src/authed-http";
import { createAuthedMcpFetchHandler, mcpTokenScopes } from "../src/authed-http";
import { DEFAULT_MAX_REQUEST_BYTES } from "../src/serve-stateless";

/** Minimal mock exposing only the methods the tools touch. */
const mockClient = (): LunoraClient =>
    ({
        listFunctions: vi.fn<() => Promise<{ kind: string; path: string }[]>>(async () => [{ kind: "query", path: "messages:list" }]),
    }) as unknown as LunoraClient;

/** A Streamable-HTTP client POSTs one JSON-RPC message and accepts JSON or SSE. */
const mcpRequest = (body: unknown): Request =>
    new Request("https://worker.example/mcp", {
        body: JSON.stringify(body),
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
        method: "POST",
    });

const initializeBody = {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: { capabilities: {}, clientInfo: { name: "test-client", version: "0.0.0" }, protocolVersion: "2025-06-18" },
} as const;

const listToolsBody = { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} } as const;

/**
 * A stand-in for `requireMcpAuth(auth, handler, opts)` partially applied.
 *
 * The real gate's job is verifying a JWT against the authorization server's
 * JWKS, which is better-auth's to test. What this package owns is the contract
 * it wraps: that an unauthorized request never reaches the MCP server, and
 * that the claims a successful verification produces reach the server factory.
 * So the double implements exactly that contract — bearer present → call the
 * handler with the claims; absent → the RFC 9728 challenge, handler untouched.
 */
const fakeProtect =
    (claims: McpAccessTokenClaims | undefined): McpAuthProtect =>
    (handler) =>
    async (request: Request): Promise<Response> => {
        if (claims === undefined) {
            return Response.json(
                { error: "unauthorized" },
                {
                    headers: {
                        "www-authenticate": 'Bearer resource_metadata="https://worker.example/.well-known/oauth-protected-resource"',
                    },
                    status: 401,
                },
            );
        }

        return await handler(request, claims);
    };

const toolNames = async (response: Response): Promise<string[]> => {
    const payload = (await response.json()) as { result: { tools: { name: string }[] } };

    return payload.result.tools.map((tool) => tool.name);
};

describe("mcpTokenScopes", () => {
    it("splits the space-delimited `scope` claim into a set", () => {
        expect.assertions(3);

        const scopes = mcpTokenScopes({ scope: "lunora:read lunora:write" });

        expect(scopes.has("lunora:read")).toBe(true);
        expect(scopes.has("lunora:write")).toBe(true);
        expect(scopes.size).toBe(2);
    });

    it("collapses repeated separators rather than yielding empty scopes", () => {
        expect.assertions(2);

        const scopes = mcpTokenScopes({ scope: "  lunora:read   lunora:write " });

        expect(scopes.has("")).toBe(false);
        expect(scopes.size).toBe(2);
    });

    // A malformed claim must DENY, not throw: a scope check is the thing standing
    // between an agent and the write tools, and an exception there surfaces as a
    // 500 that a caller could mistake for a transient fault and retry.
    it.each([{ scope: undefined }, { scope: 42 }, { scope: ["lunora:read"] }, {}])("returns an empty set for the malformed claim %o", (claims) => {
        expect.assertions(1);

        expect(mcpTokenScopes(claims).size).toBe(0);
    });
});

describe("createAuthedMcpFetchHandler", () => {
    it("refuses an unauthorized request with the RFC 9728 challenge, without building a server", async () => {
        expect.assertions(3);

        const server = vi.fn<() => { client: LunoraClient }>(() => {
            return { client: mockClient() };
        });
        const handle = createAuthedMcpFetchHandler({ protect: fakeProtect(undefined), server });
        const response = await handle(mcpRequest(initializeBody));

        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
        // The load-bearing assertion: the gate short-circuits BEFORE the server
        // factory runs, so an unauthenticated caller never causes a `LunoraClient`
        // holding the deployment's admin bearer to be constructed.
        expect(server).not.toHaveBeenCalled();
    });

    it("serves the MCP handshake once authorized", async () => {
        expect.assertions(2);

        const handle = createAuthedMcpFetchHandler({
            protect: fakeProtect({ scope: "lunora:read", sub: "user_1" }),
            server: { client: mockClient() },
        });
        const response = await handle(mcpRequest(initializeBody));

        expect(response.status).toBe(200);

        const payload = (await response.json()) as { result: { serverInfo: { name: string } } };

        expect(payload.result.serverInfo.name).toBe("lunora");
    });

    it("passes the verified claims to the server factory", async () => {
        expect.assertions(1);

        const claims = { scope: "lunora:read", sub: "user_1" };
        const server = vi.fn<() => { client: LunoraClient }>(() => {
            return { client: mockClient() };
        });
        const handle = createAuthedMcpFetchHandler({ protect: fakeProtect(claims), server });

        await handle(mcpRequest(initializeBody));

        expect(server).toHaveBeenCalledWith(claims);
    });

    it("awaits an async server factory", async () => {
        expect.assertions(1);

        const handle = createAuthedMcpFetchHandler({
            protect: fakeProtect({ sub: "user_1" }),
            server: async () => await Promise.resolve({ client: mockClient() }),
        });
        const response = await handle(mcpRequest(initializeBody));

        expect(response.status).toBe(200);
    });

    /**
     * The point of threading claims through: one endpoint, two capability sets.
     * A read-only token must not even be *told* the write tools exist, because
     * `createLunoraMcpServer` omits them from `tools/list` when `allowWrites` is
     * false — so the difference has to be visible in the advertised list.
     */
    it("scopes write-tool exposure to the token's own scopes", async () => {
        expect.assertions(4);

        const byScope = (claims: McpAccessTokenClaims): { allowWrites: boolean; client: LunoraClient } => {
            return { allowWrites: mcpTokenScopes(claims).has("lunora:write"), client: mockClient() };
        };

        const readOnly = createAuthedMcpFetchHandler({ protect: fakeProtect({ scope: "lunora:read" }), server: byScope });
        const readWrite = createAuthedMcpFetchHandler({ protect: fakeProtect({ scope: "lunora:read lunora:write" }), server: byScope });

        await readOnly(mcpRequest(initializeBody));
        await readWrite(mcpRequest(initializeBody));

        const readOnlyTools = await toolNames(await readOnly(mcpRequest(listToolsBody)));
        const readWriteTools = await toolNames(await readWrite(mcpRequest(listToolsBody)));

        expect(readOnlyTools).toContain("lunora_list_functions");
        expect(readOnlyTools).not.toContain("lunora_run_mutation");
        expect(readWriteTools).toContain("lunora_list_functions");
        expect(readWriteTools).toContain("lunora_run_mutation");
    });

    /**
     * A read-scoped token is still a token: without this, one authorized POST
     * of a JSON-RPC array turns into that many admin-bearer upstream calls.
     */
    it("refuses a batched request from an authorized caller", async () => {
        expect.assertions(2);

        const handle = createAuthedMcpFetchHandler({ protect: fakeProtect({ scope: "lunora:read" }), server: { client: mockClient() } });
        const response = await handle(mcpRequest([initializeBody, listToolsBody, listToolsBody]));

        expect(response.status).toBe(400);
        await expect(response.text()).resolves.toContain("batched requests are not supported");
    });

    it("refuses a body over the size limit from an authorized caller", async () => {
        expect.assertions(2);

        const handle = createAuthedMcpFetchHandler({ protect: fakeProtect({ scope: "lunora:read" }), server: { client: mockClient() } });
        const response = await handle(
            mcpRequest({
                id: 1,
                jsonrpc: "2.0",
                method: "tools/call",
                params: { arguments: { path: "z".repeat(DEFAULT_MAX_REQUEST_BYTES) }, name: "lunora_run_query" },
            }),
        );

        expect(response.status).toBe(413);
        await expect(response.text()).resolves.toContain("exceeds");
    });
});
