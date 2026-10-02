import type { LunoraAuth, LunoraAuthOptions } from "@lunora/auth";
import { createAuth, resolveAuthOptions } from "@lunora/auth";
import { jwt, mcp, mcpDiscoveryPaths, requireMcpAuth } from "@lunora/auth/plugins";
import type { LunoraClient } from "@lunora/client";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getAuthTables } from "better-auth/db";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { McpAccessTokenClaims } from "../src/authed-http";
import { createAuthedMcpFetchHandler, mcpTokenScopes } from "../src/authed-http";

/**
 * The OAuth gate end to end against a **real** better-auth instance — the
 * documented `requireMcpAuth(auth, handler, opts)` wiring, a real `mcp()`
 * authorization server, real JWTs signed by the `jwt()` plugin's keys, real JWKS
 * verification. `authed-http.test.ts` covers this package's own contract with a
 * gate double; this suite is what proves the *documented* wiring actually admits
 * a correctly minted token and refuses everything else (plan 461 workstream A).
 *
 * Tokens are minted through the provider's own token endpoint with the
 * `client_credentials` grant. That is not the grant an interactive MCP client
 * walks, but it issues the same audience-bound JWT access token through the same
 * code path, without a browser in the loop — and the audience and scope checks
 * under test are the resource server's, which do not care which grant minted it.
 */

const ORIGIN = "https://api.example.com";
/** The protected resource — what `mcp({ resource })` binds tokens to. */
const RESOURCE = `${ORIGIN}/mcp`;
/** A second resource the same authorization server issues tokens for. */
const OTHER_RESOURCE = "https://other.example.com/api";
/** better-auth's issuer: `baseURL` + the default `/api/auth` base path. */
const ISSUER = `${ORIGIN}/api/auth`;
const MCP_SCOPES = ["lunora:read", "lunora:write"];
// test-only credential for an in-memory better-auth instance — never a real secret
const PASSWORD = "correct horse battery staple"; // secret-scanner:allow

/**
 * The auth instance, with `api` narrowed to the plugin endpoints this suite calls —
 * `LunoraAuth`'s `api` is typed from the base options and does not see `mcp()`'s.
 */
type TestAuth = Omit<LunoraAuth, "api"> & {
    api: {
        adminCreateOAuthClient: (input: { body: Record<string, unknown>; headers: Headers }) => Promise<{ client_id: string; client_secret: string }>;
        signInEmail: (input: { body: { email: string; password: string }; returnHeaders: true }) => Promise<{ headers: Headers }>;
        signUpEmail: (input: { body: { email: string; name: string; password: string } }) => Promise<unknown>;
    };
};

interface Client {
    id: string;
    secret: string;
}

/** Minimal mock exposing only the methods the tools touch. */
const mockClient = (): LunoraClient =>
    ({
        listFunctions: vi.fn<() => Promise<{ kind: string; path: string }[]>>(async () => [{ kind: "query", path: "messages:list" }]),
    }) as unknown as LunoraClient;

/**
 * Build a real auth instance over an in-memory adapter. `clientPrivileges`
 * allows the test user to create a `client_credentials` client — better-auth
 * refuses that by default, and minting tokens without a browser needs one.
 */
const buildAuth = (mcpOptions: Partial<Parameters<typeof mcp>[0]> = {}): TestAuth => {
    const database: Record<string, unknown[]> = {};
    const options: LunoraAuthOptions = {
        baseURL: ORIGIN,
        database: memoryAdapter(database),
        emailAndPassword: { enabled: true },
        plugins: [
            jwt(),
            mcp({
                clientPrivileges: () => true,
                clientRegistrationDefaultResources: [OTHER_RESOURCE],
                consentPage: "/consent",
                loginPage: "/login",
                resource: RESOURCE,
                resources: [OTHER_RESOURCE],
                scopes: MCP_SCOPES,
                ...mcpOptions,
            }),
        ],
        secret: "x".repeat(32),
    };

    for (const table of Object.values(getAuthTables(resolveAuthOptions(options)))) {
        database[table.modelName] = [];
    }

    return createAuth(options) as unknown as TestAuth;
};

/** Register a confidential `client_credentials` client owned by a signed-in user. */
const registerClient = async (auth: TestAuth, scopes: ReadonlyArray<string>): Promise<Client> => {
    await auth.api.signUpEmail({ body: { email: "owner@example.com", name: "Owner", password: PASSWORD } });

    const { headers } = await auth.api.signInEmail({ body: { email: "owner@example.com", password: PASSWORD }, returnHeaders: true });
    const created = await auth.api.adminCreateOAuthClient({
        body: {
            client_credentials_scopes: scopes,
            grant_types: ["client_credentials"],
            redirect_uris: ["https://client.example.com/callback"],
            token_endpoint_auth_method: "client_secret_post",
        },
        headers: new Headers({ cookie: headers.get("set-cookie") ?? "" }),
    });

    return { id: created.client_id, secret: created.client_secret };
};

/** POST to the provider's token endpoint; returns the raw response. */
const requestToken = async (auth: TestAuth, client: Client, resource: string, scope: string): Promise<Response> =>
    await auth.handler(
        new Request(`${ISSUER}/oauth2/token`, {
            body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, grant_type: "client_credentials", resource, scope }),
            headers: { "content-type": "application/x-www-form-urlencoded" },
            method: "POST",
        }),
    );

const mintToken = async (auth: TestAuth, client: Client, resource: string, scope: string): Promise<string> => {
    const response = await requestToken(auth, client, resource, scope);
    const body: { access_token?: string } = await response.json();

    if (response.status !== 200 || body.access_token === undefined) {
        throw new Error(`token request failed with ${String(response.status)}`);
    }

    return body.access_token;
};

const mcpRequest = (body: unknown, token?: string): Request =>
    new Request(RESOURCE, {
        body: JSON.stringify(body),
        headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        method: "POST",
    });

const initializeBody = {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: { capabilities: {}, clientInfo: { name: "test-client", version: "0.0.0" }, protocolVersion: "2025-06-18" },
} as const;

const listToolsBody = { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} } as const;

const toolNames = async (response: Response): Promise<string[]> => {
    const payload: { result: { tools: { name: string }[] } } = await response.json();

    return payload.result.tools.map((tool) => tool.name);
};

/** The `resource_metadata` URL out of a `WWW-Authenticate: Bearer …` challenge. */
const resourceMetadataUrl = (response: Response): string | undefined =>
    /resource_metadata="([^"]+)"/u.exec(response.headers.get("www-authenticate") ?? "")?.[1];

describe("createAuthedMcpFetchHandler behind real better-auth", () => {
    let auth: TestAuth;
    let client: Client;

    beforeAll(async () => {
        auth = buildAuth();
        client = await registerClient(auth, MCP_SCOPES);
    });

    // `requireMcpAuth` fetches the JWKS from `${baseURL}/jwks` over the network. Route
    // that fetch to the same instance, which is exactly what a same-Worker deployment
    // does — the authorization server and the resource server are one origin.
    const stubJwksFetch = (): void => {
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => await auth.handler(new Request(input, init)));
    };

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    /** The documented wiring: the same `resource` passed to `mcp()` and `requireMcpAuth`. */
    const documentedHandler = (server: (claims: McpAccessTokenClaims) => { allowWrites: boolean; client: LunoraClient }) =>
        createAuthedMcpFetchHandler({
            protect: (handler) => requireMcpAuth(auth, handler, { requiredScopes: ["lunora:read"], resource: RESOURCE }),
            server,
        });

    const byScope = vi.fn<(claims: McpAccessTokenClaims) => { allowWrites: boolean; client: LunoraClient }>((claims) => {
        return { allowWrites: mcpTokenScopes(claims).has("lunora:write"), client: mockClient() };
    });

    it("advertises the lunora scopes in both discovery documents", async () => {
        expect.assertions(4);

        // The paths the docs route to `auth.handler`, derived the way the docs derive them.
        const [protectedResourcePath, authorizationServerPath] = mcpDiscoveryPaths(RESOURCE);
        const prm = await auth.handler(new Request(`${ORIGIN}${protectedResourcePath ?? ""}`));
        const prmBody: { resource: string; scopes_supported: string[] } = await prm.json();
        const as = await auth.handler(new Request(`${ORIGIN}${authorizationServerPath ?? ""}`));
        const asBody: { issuer: string; scopes_supported: string[] } = await as.json();

        expect(prmBody.resource).toBe(RESOURCE);
        expect(prmBody.scopes_supported).toStrictEqual(expect.arrayContaining(MCP_SCOPES));
        // RFC 8414 §3.3: the issuer in the document MUST equal the issuer the client
        // built the well-known URL from, or a compliant client discards it.
        expect(asBody.issuer).toBe(ISSUER);
        expect(asBody.scopes_supported).toStrictEqual(expect.arrayContaining(MCP_SCOPES));
    });

    it("answers a request with no token with the RFC 9728 challenge for the MCP resource, without building a server", async () => {
        expect.assertions(4);

        stubJwksFetch();
        byScope.mockClear();

        const response = await documentedHandler(byScope)(mcpRequest(initializeBody));
        const metadataUrl = resourceMetadataUrl(response);

        expect(response.status).toBe(401);
        expect(metadataUrl).toBe(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
        expect(response.headers.get("www-authenticate")).toContain('scope="lunora:read"');
        expect(byScope).not.toHaveBeenCalled();
    });

    it("serves the protected-resource metadata at the URL the challenge names", async () => {
        expect.assertions(3);

        stubJwksFetch();

        const challenge = await documentedHandler(byScope)(mcpRequest(initializeBody));
        const metadata = await auth.handler(new Request(resourceMetadataUrl(challenge) ?? "about:blank"));
        const body: { authorization_servers: string[]; resource: string } = await metadata.json();

        expect(metadata.status).toBe(200);
        expect(body.resource).toBe(RESOURCE);
        expect(body.authorization_servers).toStrictEqual([ISSUER]);
    });

    it("admits a token minted for the MCP resource and hides the write tools from a read-only one", async () => {
        expect.assertions(3);

        stubJwksFetch();

        const token = await mintToken(auth, client, RESOURCE, "lunora:read");
        const handle = documentedHandler(byScope);
        const initialize = await handle(mcpRequest(initializeBody, token));
        const tools = await toolNames(await handle(mcpRequest(listToolsBody, token)));

        expect(initialize.status).toBe(200);
        expect(tools).toContain("lunora_list_functions");
        expect(tools).not.toContain("lunora_run_mutation");
    });

    it("exposes the write tools to a token carrying lunora:write", async () => {
        expect.assertions(1);

        stubJwksFetch();

        const token = await mintToken(auth, client, RESOURCE, "lunora:read lunora:write");
        const tools = await toolNames(await documentedHandler(byScope)(mcpRequest(listToolsBody, token)));

        expect(tools).toContain("lunora_run_mutation");
    });

    it("passes the verified, audience-bound claims to the server factory", async () => {
        expect.assertions(2);

        stubJwksFetch();
        byScope.mockClear();

        const token = await mintToken(auth, client, RESOURCE, "lunora:read");

        await documentedHandler(byScope)(mcpRequest(initializeBody, token));

        const claims = byScope.mock.calls[0]?.[0];

        expect(claims?.["aud"]).toBe(RESOURCE);
        expect(claims?.["iss"]).toBe(ISSUER);
    });

    // RFC 8707 audience binding: a token the same authorization server issued for a
    // DIFFERENT resource must not open this one, or one leaked API token is an MCP token.
    it("refuses a valid token minted for another resource", async () => {
        expect.assertions(2);

        stubJwksFetch();
        byScope.mockClear();

        const token = await mintToken(auth, client, OTHER_RESOURCE, "lunora:read");
        const response = await documentedHandler(byScope)(mcpRequest(initializeBody, token));

        expect(response.status).toBe(401);
        expect(byScope).not.toHaveBeenCalled();
    });

    it("refuses a token whose signature does not verify", async () => {
        expect.assertions(2);

        stubJwksFetch();
        byScope.mockClear();

        const token = await mintToken(auth, client, RESOURCE, "lunora:read lunora:write");
        const [header, payload, signature] = token.split(".");
        // Flip the first signature character: the header and claims stay well formed,
        // so only the signature check can catch it.
        const forged = `${header ?? ""}.${payload ?? ""}.${signature?.startsWith("A") ? "B" : "A"}${signature?.slice(1) ?? ""}`;
        const response = await documentedHandler(byScope)(mcpRequest(initializeBody, forged));

        expect(response.status).toBe(401);
        expect(byScope).not.toHaveBeenCalled();
    });

    it("answers a token without the required scope with a 403 insufficient_scope step-up challenge", async () => {
        expect.assertions(4);

        stubJwksFetch();
        byScope.mockClear();

        const token = await mintToken(auth, client, RESOURCE, "lunora:write");
        const response = await documentedHandler(byScope)(mcpRequest(initializeBody, token));
        const challenge = response.headers.get("www-authenticate") ?? "";

        expect(response.status).toBe(403);
        expect(challenge).toContain('error="insufficient_scope"');
        expect(challenge).toContain('scope="lunora:read"');
        expect(byScope).not.toHaveBeenCalled();
    });

    // The regression this suite exists for: better-auth's `requireMcpAuth` falls back
    // to `audience = baseURL`, which no `mcp()` token carries, so the wiring the docs
    // used to show refused every request. Lunora's wrapper makes that unwritable.
    it("refuses to build the gate when `resource` is left off requireMcpAuth", () => {
        expect.assertions(1);

        expect(() =>
            createAuthedMcpFetchHandler({
                protect: (handler) => requireMcpAuth(auth, handler, { requiredScopes: ["lunora:read"] } as unknown as { resource: string }),
                server: byScope,
            }),
        ).toThrow(expect.objectContaining({ code: "AUTH_MCP_RESOURCE_INVALID" }));
    });

    // Why the documented wiring passes `scopes` to `mcp()`: left out, the provider
    // falls back to the OIDC defaults, so `lunora:read` / `lunora:write` are not
    // scopes it knows — no client can be registered for them, let alone issued a token.
    it("cannot grant lunora scopes when mcp() does not declare them", async () => {
        expect.assertions(1);

        await expect(registerClient(buildAuth({ scopes: undefined }), MCP_SCOPES)).rejects.toMatchObject({ body: { error: "invalid_scope" } });
    });
});
