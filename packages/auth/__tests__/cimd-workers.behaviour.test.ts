import { createHash } from "node:crypto";

import { GLOBAL_FETCH_STRICTLY_PUBLIC_FLAG } from "@lunora/config/cloudflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import workersCimdFetch from "../src/cimd-workers";
import { cimd, jwt, mcp } from "../src/plugins";
import createMemoryAuth from "./helpers/memory-auth";

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

const jsonResponse = (body: unknown, headers: Record<string, string> = {}): Response =>
    Response.json(body, { headers: { "content-type": "application/json", ...headers } });

describe(workersCimdFetch, () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("refuses to build without the global_fetch_strictly_public flag", () => {
        expect.assertions(1);

        stubCompatibilityFlag(false);

        expect(() => workersCimdFetch()).toThrow("global_fetch_strictly_public");
    });

    // The transport keeps its own copy of the flag name (a runtime package cannot
    // depend on @lunora/config); `lunora doctor` checks the config's. They must agree,
    // or doctor passes a deploy whose transport then refuses to build.
    it("probes the same flag lunora doctor checks for", () => {
        expect.assertions(2);

        vi.stubGlobal("Cloudflare", { compatibilityFlags: { [GLOBAL_FETCH_STRICTLY_PUBLIC_FLAG]: true } });

        expect(() => workersCimdFetch()).not.toThrow();

        vi.stubGlobal("Cloudflare", { compatibilityFlags: {} });

        expect(() => workersCimdFetch()).toThrow(GLOBAL_FETCH_STRICTLY_PUBLIC_FLAG);
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

        // A 3xx, but not a redirect: the answer to cimd's own conditional revalidation.
        it("passes a 304 Not Modified through", async () => {
            expect.assertions(1);

            upstream.mockResolvedValue(new Response(null, { headers: { etag: '"v1"' }, status: 304 }));

            const response = await workersCimdFetch()(CLIENT_ID, { headers: { "if-none-match": '"v1"' } });

            expect(response.status).toBe(304);
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

    const buildAuth = (cimdOptions: Partial<Parameters<typeof cimd>[0]> = {}): { handler: (request: Request) => Promise<Response> } =>
        createMemoryAuth({
            baseURL: ORIGIN,
            plugins: [
                jwt(),
                mcp({ consentPage: "/consent", loginPage: "/login", resource: RESOURCE, scopes: ["lunora:read", "lunora:write"] }),
                cimd({ fetchClientMetadataResource: workersCimdFetch(), metadataProfile: "mcp-2026-07-28", ...cimdOptions }),
            ],
            secret: "x".repeat(32),
        });

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

    // cimd keeps a validated document with its ETag and, once it goes stale, asks the
    // origin `If-None-Match`. The 304 that comes back must reach cimd as a 304 — a
    // transport that refused it as a redirect would lock the client out for good at
    // its first expiry.
    it("keeps a client resolving after a stale document revalidates as 304 Not Modified", async () => {
        expect.assertions(4);

        // `no-cache` makes every cached document stale at once; the zero interval
        // lifts cimd's per-client fetch throttle so the second fetch is allowed.
        upstream.mockResolvedValueOnce(jsonResponse(metadataDocument(), { "cache-control": "no-cache", etag: '"v1"' }));
        upstream.mockResolvedValueOnce(new Response(null, { headers: { etag: '"v1"' }, status: 304 }));

        const auth = buildAuth({ metadataFetchPolicy: { minimumFetchInterval: 0 } });

        await expect(errorOf(await authorize(auth))).resolves.toBeNull();

        const revalidated = await authorize(auth);

        expect(upstream).toHaveBeenCalledTimes(2);
        expect(upstream.mock.calls[1]?.[0].headers.get("if-none-match")).toBe('"v1"');
        await expect(errorOf(revalidated)).resolves.toBeNull();
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
