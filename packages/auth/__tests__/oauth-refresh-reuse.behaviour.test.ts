import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lunoraAuthAdapter } from "../src/adapter";
import type { LunoraAuth, LunoraAuthOptions } from "../src/create-auth";
import { createAuth } from "../src/create-auth";
import { jwt, oauthProvider } from "../src/plugins";
import { createSqlAuthStore } from "../src/sql-store";
import signInAndCookie from "./_helpers/auth-session";
import memoryTables from "./helpers/memory-tables";
import { executorFor, materialiseAuthSchema } from "./helpers/sqlite-auth-db";

/**
 * Refresh-token reuse detection for apps that act as an OAuth provider through
 * `oauthProvider()` (RFC 9700 §4.14.2): presenting a refresh token that was
 * already rotated is treated as theft, so the whole token family dies.
 *
 * Lunora does not implement this; better-auth's `@better-auth/oauth-provider` does,
 * in `invalidateRefreshFamily`. This suite pins it through the real token endpoint
 * so a better-auth upgrade that weakens it — rejecting the replay but leaving the
 * thief's freshly rotated token alive — fails here instead of in production. It
 * also pins the rotation's adapter contract (`incrementOne` with a
 * `revoked IS NULL` guard, `deleteMany` with `in`), which is why it runs over
 * Lunora's own SQL store as well as better-auth's memory adapter.
 *
 * The family is (client, user), not one authorization: a replay revokes every
 * grant that user gave that client. No `resource` is requested, so access tokens
 * are opaque and linked to their refresh row — a JWT access token would outlive
 * the revocation until it expires.
 */

const ORIGIN = "https://app.example.com";
const ISSUER = `${ORIGIN}/api/auth`;
const CONSENT_PAGE = "/consent";
const REDIRECT_URI = "https://client.example.com/callback";
const PASSWORD = "correct horse battery staple"; // secret-scanner:allow -- test-only credential for an in-memory instance

type ProviderOptions = NonNullable<Parameters<typeof oauthProvider>[0]>;

interface Client {
    id: string;
    secret: string;
}

interface Tokens {
    access: string;
    refresh: string;
}

interface Backend {
    close: () => void;
    /** Creates the tables the options need and returns the adapter over them. */
    connect: (options: LunoraAuthOptions) => LunoraAuthOptions["database"];
}

const memoryBackend = (): Backend => {
    return {
        close: () => {},
        connect: (options) => memoryAdapter(memoryTables(options)),
    };
};

const sqliteBackend = (): Backend => {
    const database = new DatabaseSync(":memory:");

    return {
        close: () => {
            database.close();
        },
        connect: (options) => {
            materialiseAuthSchema(database, options);

            return lunoraAuthAdapter(createSqlAuthStore(executorFor(database)));
        },
    };
};

const backends: ReadonlyArray<[string, () => Backend]> = [
    ["better-auth memory adapter", memoryBackend],
    ["Lunora SQL store", sqliteBackend],
];

const form = (path: string, body: Record<string, string>): Request =>
    new Request(`${ISSUER}${path}`, {
        body: new URLSearchParams(body),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
    });

/** A JSON POST as the signed-in browser makes it; better-auth checks `origin` on cookie-bearing requests. */
const postAsUser = (path: string, session: Headers, body: Record<string, unknown>): Request =>
    new Request(`${ISSUER}${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", cookie: session.get("cookie") ?? "", origin: ORIGIN },
        method: "POST",
    });

/** Signs a user up and returns the session cookie the authorize endpoint reads. */
const signIn = async (auth: LunoraAuth, email: string): Promise<Headers> => {
    await auth.api.signUpEmail({ body: { email, name: email, password: PASSWORD } });

    return signInAndCookie(auth, email, PASSWORD);
};

/** A confidential client registered by the signed-in user. */
const registerClient = async (auth: LunoraAuth, session: Headers): Promise<Client> => {
    const response = await auth.handler(
        postAsUser("/oauth2/create-client", session, {
            grant_types: ["authorization_code", "refresh_token"],
            redirect_uris: [REDIRECT_URI],
            token_endpoint_auth_method: "client_secret_post",
        }),
    );
    const body: { client_id?: string; client_secret?: string } = await response.json();

    if (response.status !== 201 || body.client_id === undefined || body.client_secret === undefined) {
        throw new Error(`client registration failed with ${String(response.status)}: ${JSON.stringify(body)}`);
    }

    return { id: body.client_id, secret: body.client_secret };
};

const readTokens = async (response: Response): Promise<Tokens> => {
    const body: { access_token?: string; refresh_token?: string } = await response.json();

    if (response.status !== 200 || body.access_token === undefined || body.refresh_token === undefined) {
        throw new Error(`token request failed with ${String(response.status)}: ${JSON.stringify(body)}`);
    }

    return { access: body.access_token, refresh: body.refresh_token };
};

/** The `code` on the redirect back to the client, accepting consent first when the provider asks for it. */
const authorizationCode = async (auth: LunoraAuth, session: Headers, url: URL): Promise<string | null> => {
    const redirect = await auth.handler(new Request(url, { headers: session }));
    const location = redirect.headers.get("location");

    if (location === null) {
        throw new Error(`authorize did not redirect (status ${String(redirect.status)})`);
    }

    let target = new URL(location, ORIGIN);

    if (target.pathname === CONSENT_PAGE) {
        const consent = await auth.handler(postAsUser("/oauth2/consent", session, { accept: true, oauth_query: target.search.slice(1) }));
        const body: { url?: string } = await consent.json();

        if (body.url === undefined) {
            throw new Error(`consent failed with ${String(consent.status)}: ${JSON.stringify(body)}`);
        }

        target = new URL(body.url, ORIGIN);
    }

    return target.searchParams.get("code");
};

/** One full authorization-code grant with PKCE and `offline_access`. */
const authorize = async (auth: LunoraAuth, client: Client, session: Headers): Promise<Tokens> => {
    const verifier = randomBytes(32).toString("base64url");
    const url = new URL(`${ISSUER}/oauth2/authorize`);

    url.search = new URLSearchParams({
        client_id: client.id,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "openid offline_access",
        state: "state",
    }).toString();

    const code = await authorizationCode(auth, session, url);

    if (code === null) {
        throw new Error("authorize did not issue a code");
    }

    const response = await auth.handler(
        form("/oauth2/token", {
            client_id: client.id,
            client_secret: client.secret,
            code,
            code_verifier: verifier,
            grant_type: "authorization_code",
            redirect_uri: REDIRECT_URI,
        }),
    );

    return readTokens(response);
};

const refresh = (auth: LunoraAuth, client: Client, refreshToken: string): Promise<Response> =>
    auth.handler(form("/oauth2/token", { client_id: client.id, client_secret: client.secret, grant_type: "refresh_token", refresh_token: refreshToken }));

const isActive = async (auth: LunoraAuth, client: Client, token: string, hint: "access_token" | "refresh_token"): Promise<boolean> => {
    const response = await auth.handler(form("/oauth2/introspect", { client_id: client.id, client_secret: client.secret, token, token_type_hint: hint }));
    const body: { active?: boolean } = await response.json();

    // A failed introspection must not pass as "revoked".
    if (response.status !== 200) {
        throw new Error(`introspection failed with ${String(response.status)}: ${JSON.stringify(body)}`);
    }

    return body.active === true;
};

/** Two assertions: the token endpoint refused the grant as `invalid_grant`. */
const expectInvalidGrant = async (response: Response): Promise<void> => {
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_grant" });
};

describe.each(backends)("oauthProvider refresh-token reuse over %s", (_name, makeBackend) => {
    let backend: Backend | undefined;

    afterEach(() => {
        vi.useRealTimers();
        backend?.close();
        backend = undefined;
    });

    const deploy = (providerOptions: Partial<ProviderOptions> = {}): LunoraAuth => {
        backend = makeBackend();

        const options: LunoraAuthOptions = {
            baseURL: ORIGIN,
            emailAndPassword: { enabled: true },
            plugins: [jwt(), oauthProvider({ consentPage: CONSENT_PAGE, loginPage: "/login", ...providerOptions })],
            rateLimit: { enabled: false },
            secret: "x".repeat(32),
        };

        return createAuth({ ...options, database: backend.connect(options) });
    };

    it("revokes the whole (client, user) family when a rotated refresh token is replayed", async () => {
        expect.assertions(13);

        const auth = deploy();
        const session = await signIn(auth, "ada@example.com");
        const client = await registerClient(auth, session);
        // A second, independent grant by the same user to the same client — another device.
        const sibling = await authorize(auth, client, session);
        const first = await authorize(auth, client, session);
        const rotated = await readTokens(await refresh(auth, client, first.refresh));

        await expect(isActive(auth, client, rotated.access, "access_token")).resolves.toBe(true);
        await expect(isActive(auth, client, sibling.refresh, "refresh_token")).resolves.toBe(true);

        await expectInvalidGrant(await refresh(auth, client, first.refresh));

        // The token the attacker (or the victim) rotated to is dead too…
        await expectInvalidGrant(await refresh(auth, client, rotated.refresh));

        await expect(isActive(auth, client, rotated.access, "access_token")).resolves.toBe(false);
        await expect(isActive(auth, client, first.access, "access_token")).resolves.toBe(false);
        await expect(isActive(auth, client, rotated.refresh, "refresh_token")).resolves.toBe(false);

        // …and so is every other grant this user gave this client.
        await expect(isActive(auth, client, sibling.access, "access_token")).resolves.toBe(false);
        await expect(isActive(auth, client, sibling.refresh, "refresh_token")).resolves.toBe(false);

        await expectInvalidGrant(await refresh(auth, client, sibling.refresh));
    });

    it("leaves another user's grant to the same client alive", async () => {
        expect.assertions(6);

        const auth = deploy();
        const adaSession = await signIn(auth, "ada@example.com");
        const client = await registerClient(auth, adaSession);
        const grace = await authorize(auth, client, await signIn(auth, "grace@example.com"));
        const ada = await authorize(auth, client, adaSession);
        const adaRotated = await readTokens(await refresh(auth, client, ada.refresh));

        await expectInvalidGrant(await refresh(auth, client, ada.refresh));

        await expect(isActive(auth, client, adaRotated.refresh, "refresh_token")).resolves.toBe(false);
        await expect(isActive(auth, client, adaRotated.access, "access_token")).resolves.toBe(false);

        await expect(isActive(auth, client, grace.access, "access_token")).resolves.toBe(true);
        await expect(readTokens(await refresh(auth, client, grace.refresh))).resolves.toMatchObject({ refresh: expect.any(String) });
    });

    it("leaves the same user's grant to another client alive", async () => {
        expect.assertions(5);

        const auth = deploy();
        const session = await signIn(auth, "ada@example.com");
        const client = await registerClient(auth, session);
        const otherClient = await registerClient(auth, session);
        const other = await authorize(auth, otherClient, session);
        const first = await authorize(auth, client, session);
        const rotated = await readTokens(await refresh(auth, client, first.refresh));

        await expectInvalidGrant(await refresh(auth, client, first.refresh));

        await expect(isActive(auth, client, rotated.refresh, "refresh_token")).resolves.toBe(false);

        await expect(isActive(auth, otherClient, other.access, "access_token")).resolves.toBe(true);
        await expect(readTokens(await refresh(auth, otherClient, other.refresh))).resolves.toMatchObject({ refresh: expect.any(String) });
    });

    it("answers a retry inside refreshTokenReuseInterval with the same tokens, and revokes after it", async () => {
        expect.assertions(6);

        vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z"), toFake: ["Date"] });

        const auth = deploy({ refreshTokenReuseInterval: 60 });
        const session = await signIn(auth, "ada@example.com");
        const client = await registerClient(auth, session);
        const first = await authorize(auth, client, session);
        const rotated = await readTokens(await refresh(auth, client, first.refresh));
        const retried = await readTokens(await refresh(auth, client, first.refresh));

        expect(retried).toStrictEqual(rotated);
        await expect(isActive(auth, client, rotated.access, "access_token")).resolves.toBe(true);
        await expect(isActive(auth, client, rotated.refresh, "refresh_token")).resolves.toBe(true);

        vi.advanceTimersByTime(61_000);

        await expectInvalidGrant(await refresh(auth, client, first.refresh));

        await expect(isActive(auth, client, rotated.refresh, "refresh_token")).resolves.toBe(false);
    });

    // Each rotation restarts `refreshTokenExpiresIn`, so the lifetime slides: a
    // client that keeps refreshing never hits it, one that goes quiet does.
    it("expires a refresh token refreshTokenExpiresIn after its last rotation, without revoking the family", async () => {
        expect.assertions(6);

        vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z"), toFake: ["Date"] });

        const auth = deploy({ refreshTokenExpiresIn: 60 });
        const session = await signIn(auth, "ada@example.com");
        const client = await registerClient(auth, session);
        const first = await authorize(auth, client, session);

        vi.advanceTimersByTime(50_000);

        const rotated = await readTokens(await refresh(auth, client, first.refresh));

        // 100 s after the grant, past the first token's lifetime but not the rotated one's.
        vi.advanceTimersByTime(50_000);

        const kept = await readTokens(await refresh(auth, client, rotated.refresh));

        expect(kept.refresh).not.toBe(rotated.refresh);

        // A sibling grant from the same family, issued late enough to outlive `kept`.
        vi.advanceTimersByTime(30_000);

        const sibling = await authorize(auth, client, session);

        vi.advanceTimersByTime(31_000);

        await expectInvalidGrant(await refresh(auth, client, kept.refresh));

        await expect(isActive(auth, client, sibling.access, "access_token")).resolves.toBe(true);
        await expect(isActive(auth, client, sibling.refresh, "refresh_token")).resolves.toBe(true);
        await expect(readTokens(await refresh(auth, client, sibling.refresh))).resolves.toMatchObject({ refresh: expect.any(String) });
    });
});
