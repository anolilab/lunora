import { createHash } from "node:crypto";

import { memoryAdapter } from "better-auth/adapters/memory";
import { getAuthTables } from "better-auth/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import workersCimdFetch from "../src/cimd-workers";
import type { LunoraAuthOptions } from "../src/create-auth";
import { createAuth, resolveAuthOptions } from "../src/create-auth";
import { cimd, jwt, mcp } from "../src/plugins";

/**
 * `workersCimdFetch` — the Workers transport for `cimd()` — on its own, then wired
 * into a real better-auth `mcp()` + `cimd()` authorization server, so the guarantees
 * it exists for are shown end to end rather than asserted about a stub (plan 461
 * workstream C). Network access is a `fetch` stub serving fixed documents; workerd's
 * compatibility-flag global is stubbed the same way.
 */

const ORIGIN = "https://api.example.com";
const RESOURCE = `${ORIGIN}/mcp`;
const ISSUER = `${ORIGIN}/api/auth`;
const CLIENT_ID = "https://client.example.com/oauth/client.json";
const REDIRECT_URI = "https://client.example.com/callback";

/** Turn the `global_fetch_strictly_public` flag on (or off) the way workerd exposes it. */
const stubCompatibilityFlag = (enabled: boolean): void => {
    vi.stubGlobal("Cloudflare", { compatibilityFlags: { global_fetch_strictly_public: enabled } });
};

/** A valid MCP-profile metadata document for {@link CLIENT_ID}, overridable per test. */
const metadataDocument = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    return {
        client_id: CLIENT_ID,
        client_name: "Example MCP client",
        grant_types: ["authorization_code"],
        redirect_uris: [REDIRECT_URI],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...overrides,
    };
};

const jsonResponse = (body: unknown): Response => Response.json(body, { headers: { "content-type": "application/json" } });

describe(workersCimdFetch, () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("refuses to build without the global_fetch_strictly_public flag", () => {
        expect.assertions(1);

        stubCompatibilityFlag(false);

        expect(() => workersCimdFetch()).toThrow("global_fetch_strictly_public");
    });

    // Every runtime that is not workerd lacks the `Cloudflare` global entirely. That
    // must read as "flag off", never as "nothing to check".
    it("refuses to build when the Cloudflare global is absent", () => {
        expect.assertions(1);

        expect(() => workersCimdFetch()).toThrow("global_fetch_strictly_public");
    });

    describe("with the flag on", () => {
        const upstream = vi.fn<(request: Request) => Promise<Response>>();

        beforeEach(() => {
            stubCompatibilityFlag(true);
            upstream.mockReset();
            vi.stubGlobal("fetch", upstream);
        });

        it("passes an https GET through and returns the response", async () => {
            expect.assertions(3);

            upstream.mockResolvedValue(jsonResponse(metadataDocument()));

            const response = await workersCimdFetch()(CLIENT_ID, { headers: { accept: "application/json" } });

            expect(response.status).toBe(200);
            expect(upstream.mock.calls[0]?.[0].url).toBe(CLIENT_ID);
            expect(upstream.mock.calls[0]?.[0].method).toBe("GET");
        });

        // cimd asks for `redirect: "error"`, which workerd's `Request` constructor
        // rejects; the transport must swap it for "manual" and police 3xx itself.
        it("fetches with redirect: manual whatever the caller asked for", async () => {
            expect.assertions(1);

            upstream.mockResolvedValue(jsonResponse(metadataDocument()));

            await workersCimdFetch()(CLIENT_ID, { redirect: "error" });

            expect(upstream.mock.calls[0]?.[0].redirect).toBe("manual");
        });

        it.each([301, 302, 303, 307, 308])("refuses a %i redirect instead of returning or following it", async (status) => {
            expect.assertions(1);

            upstream.mockResolvedValue(new Response(null, { headers: { location: "https://metadata.internal.example/latest" }, status }));

            await expect(workersCimdFetch()(CLIENT_ID)).rejects.toThrow("redirects");
        });

        it.each([
            ["plain http", "http://client.example.com/client.json"],
            // Placeholder userinfo, not a credential: the refusal of any userinfo is under test.
            ["embedded credentials", "https://user:pass@client.example.com/client.json"], // secret-scanner:allow
        ])("refuses a URL with %s without fetching", async (_label, url) => {
            expect.assertions(2);

            await expect(workersCimdFetch()(url)).rejects.toThrow(TypeError);
            expect(upstream).not.toHaveBeenCalled();
        });

        it("refuses any method but GET and HEAD without fetching", async () => {
            expect.assertions(2);

            await expect(workersCimdFetch()(CLIENT_ID, { body: "{}", method: "POST" })).rejects.toThrow("POST");
            expect(upstream).not.toHaveBeenCalled();
        });
    });
});

describe("cimd() with workersCimdFetch behind a real mcp() server", () => {
    const upstream = vi.fn<(request: Request) => Promise<Response>>();

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const buildAuth = (): { handler: (request: Request) => Promise<Response> } => {
        const database: Record<string, unknown[]> = {};
        const options: LunoraAuthOptions = {
            baseURL: ORIGIN,
            database: memoryAdapter(database),
            plugins: [
                jwt(),
                mcp({ consentPage: "/consent", loginPage: "/login", resource: RESOURCE, scopes: ["lunora:read", "lunora:write"] }),
                cimd({ fetchClientMetadataResource: workersCimdFetch(), metadataProfile: "mcp-2026-07-28" }),
            ],
            secret: "x".repeat(32),
        };

        for (const table of Object.values(getAuthTables(resolveAuthOptions(options)))) {
            database[table.modelName] = [];
        }

        return createAuth(options);
    };

    /** Start an authorization-code request from the CIMD client, as an MCP host does. */
    const authorize = async (auth: { handler: (request: Request) => Promise<Response> }): Promise<Response> => {
        const query = new URLSearchParams({
            client_id: CLIENT_ID,
            code_challenge: createHash("sha256").update("pkce-verifier-for-tests").digest("base64url"),
            code_challenge_method: "S256",
            redirect_uri: REDIRECT_URI,
            resource: RESOURCE,
            response_type: "code",
            scope: "lunora:read",
            state: "state-1",
        });

        return await auth.handler(new Request(`${ISSUER}/oauth2/authorize?${query.toString()}`));
    };

    /**
     * The OAuth `error` a refused authorization request carries — on the redirect
     * when there is one, else in the JSON body — or `null` when it was not refused.
     */
    const errorOf = async (response: Response): Promise<string | null> => {
        const location = response.headers.get("location");

        if (location !== null) {
            return new URL(location, ORIGIN).searchParams.get("error");
        }

        const body: { error?: string } = await response.json();

        return body.error ?? null;
    };

    beforeEach(() => {
        stubCompatibilityFlag(true);
        upstream.mockReset();
        vi.stubGlobal("fetch", upstream);
    });

    it("advertises client_id_metadata_document_supported in the authorization-server metadata", async () => {
        expect.assertions(2);

        const response = await buildAuth().handler(new Request(`${ORIGIN}/.well-known/oauth-authorization-server/api/auth`));
        const metadata: { client_id_metadata_document_supported?: boolean; issuer: string } = await response.json();

        expect(metadata.client_id_metadata_document_supported).toBe(true);
        expect(metadata.issuer).toBe(ISSUER);
    });

    it("accepts a client whose metadata document validates, sending it on to sign-in", async () => {
        expect.assertions(3);

        upstream.mockResolvedValue(jsonResponse(metadataDocument()));

        const response = await authorize(buildAuth());

        expect(upstream).toHaveBeenCalledTimes(1);
        await expect(errorOf(response)).resolves.toBeNull();
        expect(response.headers.get("location")).toContain("/login");
    });

    it("rejects a client whose metadata URL redirects, without following it", async () => {
        expect.assertions(3);

        upstream.mockResolvedValue(new Response(null, { headers: { location: "https://evil.example.com/client.json" }, status: 302 }));

        const response = await authorize(buildAuth());

        expect(upstream).toHaveBeenCalledTimes(1);

        await expect(errorOf(response)).resolves.toBe("invalid_client");
        expect(response.headers.get("location") ?? "").not.toContain("/login");
    });

    it("rejects a metadata document whose client_id does not match its URL", async () => {
        expect.assertions(2);

        upstream.mockResolvedValue(jsonResponse(metadataDocument({ client_id: "https://other.example.com/client.json" })));

        const response = await authorize(buildAuth());

        await expect(errorOf(response)).resolves.toBe("invalid_client");
        expect(response.headers.get("location") ?? "").not.toContain("/login");
    });

    // The MCP 2026-07-28 profile makes `client_name` mandatory.
    it("rejects a metadata document that fails the MCP 2026-07-28 profile", async () => {
        expect.assertions(1);

        upstream.mockResolvedValue(jsonResponse(metadataDocument({ client_name: undefined })));

        await expect(errorOf(await authorize(buildAuth()))).resolves.toBe("invalid_client");
    });
});
