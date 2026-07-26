import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuth } from "../src/create-auth";
import { handleAuthRequest } from "../src/handler";
import { scim, sso } from "../src/plugins";
import authTables from "../src/schema";

/**
 * Round-trip behaviour for the enterprise-auth plugins Lunora re-exports —
 * `sso` (OIDC/OAuth2/SAML providers per email domain) and `scim` (SCIM 2.0 Users
 * provisioning). As with `plugins.behaviour.test.ts`, these drive the real
 * better-auth runtime against an in-memory adapter — the only stub is the external
 * IdP at the fetch boundary (see `stubIdentityProvider`), because provider
 * registration really does call out to the issuer's discovery endpoint.
 *
 * Deliberately covered here, because each is a claim plan 166 rests on:
 *
 * - `authTables` auto-derives the plugins' D1 tables, so an app gets the schema
 * from the plugin list alone.
 * - An OIDC provider registers and is then resolvable **by email domain**, which
 * is the whole point of enterprise SSO over plain OAuth.
 * - SCIM's non-GET/POST verbs survive Lunora's request routing. An IdP pushes
 * `PUT`/`PATCH`/`DELETE` at `/scim/v2/Users/:id`; if the dispatch chain dropped
 * them, provisioning would fail in a way no OIDC test would notice.
 *
 * NOT covered: a real IdP handshake (Okta/Entra token exchange) and SAML assertion
 * verification. Both need an external tenant, and SAML on workerd is still an open
 * question — see the note on the `sso` re-export in `src/plugins.ts`.
 */

const SECRET = "x".repeat(32);

const STRONG_PASSWORD = "correct horse battery staple";

const seedMemoryDatabase = (): Record<string, unknown[]> => {
    return {
        account: [],
        // better-auth's rate limiter stores counters through the same adapter, and
        // the SCIM routes hit it — an unseeded model throws "Model rateLimit not found".
        rateLimit: [],
        scimProvider: [],
        session: [],
        ssoProvider: [],
        user: [],
        verification: [],
    };
};

/**
 * The IdP origin must be trusted for provider registration to accept an OIDC
 * discovery URL — better-auth refuses an untrusted discovery endpoint outright
 * ("Untrusted OIDC discovery URL"), which is an SSRF guard, not a nuisance.
 */
const TRUSTED_IDP_ORIGIN = "https://idp.example.com";

const DISCOVERY_URL = `${TRUSTED_IDP_ORIGIN}/.well-known/openid-configuration`;

const oidcConfig = {
    authorizationEndpoint: `${TRUSTED_IDP_ORIGIN}/authorize`,
    clientId: "lunora-test-client",
    clientSecret: "lunora-test-secret",
    discoveryEndpoint: DISCOVERY_URL,
    jwksEndpoint: `${TRUSTED_IDP_ORIGIN}/jwks`,
    scopes: ["openid", "email", "profile"],
    tokenEndpoint: `${TRUSTED_IDP_ORIGIN}/token`,
};

/** What the IdP serves at its discovery URL — the minimum better-auth reads. */
const discoveryDocument = {
    authorization_endpoint: oidcConfig.authorizationEndpoint,
    id_token_signing_alg_values_supported: ["RS256"],
    issuer: TRUSTED_IDP_ORIGIN,
    jwks_uri: oidcConfig.jwksEndpoint,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    token_endpoint: oidcConfig.tokenEndpoint,
    userinfo_endpoint: `${TRUSTED_IDP_ORIGIN}/userinfo`,
};

/**
 * Stub the IdP at the fetch boundary and return the spy.
 *
 * Registering a provider is NOT a pure local write: better-auth fetches the
 * issuer's discovery document (unconditionally — omitting `discoveryEndpoint`
 * just derives it from `issuer`), so in a Worker this is an outbound subrequest
 * at registration time. Only the external IdP is stubbed; the better-auth
 * runtime, the adapter, and the endpoints are all real. Anything *other* than the
 * discovery URL rejects, so an unexpected outbound call fails loudly instead of
 * silently hitting the network.
 */
const stubIdentityProvider = () =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        let url: string;

        if (typeof input === "string") {
            url = input;
        } else if (input instanceof URL) {
            url = input.toString();
        } else {
            url = input.url;
        }

        if (url === DISCOVERY_URL) {
            return Response.json(discoveryDocument);
        }

        throw new Error(`unexpected outbound fetch in test: ${url}`);
    });

/** Sign in and pull the `cookie` header so later endpoint calls run "as that user". */
const signInAndCookie = async (auth: any, email: string, password: string): Promise<Headers> => {
    const response = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
    const setCookie = response.headers.get("set-cookie");

    if (!setCookie) {
        throw new Error("sign-in did not return a set-cookie header");
    }

    const headers = new Headers();

    headers.set("cookie", setCookie);

    return headers;
};

describe("authTables with the enterprise plugins", () => {
    it("derives the sso + scim tables from the plugin list alone", () => {
        expect.assertions(2);

        const tables = authTables({ plugins: [sso(), scim()], secret: SECRET });

        // An app declaring these plugins gets the storage for free — no hand-written
        // table definitions, which is what makes the plugins drop-in.
        expect(Object.keys(tables)).toContain("ssoProvider");
        expect(Object.keys(tables)).toContain("scimProvider");
    });

    it("carries the columns the SSO domain lookup and SCIM token auth depend on", () => {
        expect.assertions(3);

        const tables = authTables({ plugins: [sso(), scim()], secret: SECRET });

        // `domain` is what maps a work email to a provider; without it the
        // enterprise flow degrades to picking a provider by hand.
        expect(Object.keys(tables["ssoProvider"]?.shape ?? {})).toEqual(expect.arrayContaining(["domain", "issuer", "providerId"]));
        // `scimToken` is the shared secret an IdP presents on every request.
        expect(Object.keys(tables["scimProvider"]?.shape ?? {})).toEqual(expect.arrayContaining(["providerId", "scimToken"]));
        // The provider row points at a user, so it must be typed as an id, not a string.
        expect(tables["ssoProvider"]?.shape["userId"]?.kind).toBe("id");
    });

    it("adds nothing when the plugins are absent (no schema cost for apps that don't opt in)", () => {
        expect.assertions(2);

        const tables = authTables({ secret: SECRET });

        expect(Object.keys(tables)).not.toContain("ssoProvider");
        expect(Object.keys(tables)).not.toContain("scimProvider");
    });
});

describe("sso plugin behaviour (OIDC mode)", () => {
    let memoryDatabase: Record<string, unknown[]>;
    // `any` rather than `ReturnType<typeof createAuth>` so plugin-contributed
    // endpoints are reachable through `auth.api` without re-deriving the generics.
    let auth: any;
    let headers: Headers;

    beforeEach(async () => {
        stubIdentityProvider();

        memoryDatabase = seedMemoryDatabase();
        auth = createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(memoryDatabase),
            emailAndPassword: { enabled: true },
            plugins: [sso()],
            secret: SECRET,
            trustedOrigins: [TRUSTED_IDP_ORIGIN],
        });

        await auth.api.signUpEmail({ body: { email: "admin@acme.test", name: "Admin", password: STRONG_PASSWORD } });

        headers = await signInAndCookie(auth, "admin@acme.test", STRONG_PASSWORD);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("registers an OIDC provider against a domain", async () => {
        expect.assertions(2);

        const provider = await auth.api.registerSSOProvider({
            body: { domain: "acme.test", issuer: "https://idp.example.com", oidcConfig, providerId: "acme-oidc" },
            headers,
        });

        expect(provider).toMatchObject({ issuer: "https://idp.example.com" });
        expect(memoryDatabase["ssoProvider"]).toHaveLength(1);
    });

    it("resolves a provider from an email domain and hands back the IdP redirect", async () => {
        expect.assertions(2);

        await auth.api.registerSSOProvider({
            body: { domain: "acme.test", issuer: "https://idp.example.com", oidcConfig, providerId: "acme-oidc" },
            headers,
        });

        // The domain→provider lookup is the enterprise affordance: a user types a
        // work email and lands at their own IdP without choosing a provider.
        const result = await auth.api.signInSSO({ body: { callbackURL: "http://localhost/dashboard", email: "someone@acme.test" } });

        expect(result.url).toContain("https://idp.example.com/authorize");
        expect(result.redirect).toBe(true);
    });

    it("refuses an unknown domain rather than falling back to some other provider", async () => {
        expect.assertions(1);

        await auth.api.registerSSOProvider({
            body: { domain: "acme.test", issuer: "https://idp.example.com", oidcConfig, providerId: "acme-oidc" },
            headers,
        });

        await expect(auth.api.signInSSO({ body: { callbackURL: "http://localhost/dashboard", email: "someone@not-acme.test" } })).rejects.toThrow(/provider/iu);
    });
});

describe("scim plugin request routing", () => {
    let auth: any;

    beforeEach(() => {
        auth = createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(seedMemoryDatabase()),
            emailAndPassword: { enabled: true },
            plugins: [scim()],
            secret: SECRET,
        });
    });

    it("mounts the SCIM 2.0 Users endpoint under the auth base path", async () => {
        expect.assertions(2);

        const response = await handleAuthRequest(auth, new Request("http://localhost/api/auth/scim/v2/Users", { method: "GET" }));

        // Unauthenticated (no SCIM bearer token), which is the point: a *routed*
        // rejection rather than `undefined`, which is what "no such route" looks like.
        expect(response).toBeDefined();
        expect(response?.status).not.toBe(404);
    });

    it.each(["PUT", "PATCH", "DELETE"])("routes %s through to better-auth (an IdP needs it for provisioning)", async (method) => {
        expect.assertions(3);

        const response = await handleAuthRequest(
            auth,
            new Request("http://localhost/api/auth/scim/v2/Users/some-user-id", {
                ...(method === "DELETE" ? {} : { body: JSON.stringify({ active: false }), headers: { "content-type": "application/json" } }),
                method,
            }),
        );

        // `handleAuthRequest` is method-agnostic by design; this pins that, because a
        // method filter added upstream would break deactivation silently.
        expect(response).toBeDefined();
        expect(response?.status).not.toBe(404);
        expect(response?.status).not.toBe(405);
    });
});
