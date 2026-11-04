import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { memoryAdapter } from "better-auth/adapters/memory";
import { getAuthTables } from "better-auth/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lunoraAuthAdapter } from "../src/adapter";
import type { LunoraAuth, LunoraAuthOptions } from "../src/create-auth";
import { createAuth, resolveAuthOptions } from "../src/create-auth";
import { jwt, oauthProvider } from "../src/plugins";
import { createSqlAuthStore } from "../src/sql-store";
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
const REDIRECT_URI = "https://client.example.com/callback";
// test-only credential for an in-memory better-auth instance — never a real secret
const PASSWORD = "correct horse battery staple"; // secret-scanner:allow

type ProviderOptions = NonNullable<Parameters<typeof oauthProvider>[0]>;

/** `LunoraAuth`'s `api` is typed from the base options and does not see the provider's endpoints. */
type ProviderAuth = Omit<LunoraAuth, "api"> & {
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

interface Tokens {
    access: string;
    refresh: string;
}

interface Backend {
    close: () => void;
    database: LunoraAuthOptions["database"];
    materialise: (options: LunoraAuthOptions) => void;
}

const memoryBackend = (): Backend => {
    const tables: Record<string, unknown[]> = {};

    return {
        close: () => {},
        database: memoryAdapter(tables),
        materialise: (options) => {
            for (const table of Object.values(getAuthTables(resolveAuthOptions(options)))) {
                tables[table.modelName] = [];
            }
        },
    };
};

const sqliteBackend = (): Backend => {
    const database = new DatabaseSync(":memory:");

    return {
        close: () => {
            database.close();
        },
        database: lunoraAuthAdapter(createSqlAuthStore(executorFor(database))),
        materialise: (options) => {
            materialiseAuthSchema(database, options);
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

describe.each(backends)("oauthProvider refresh-token reuse over %s", (_name, makeBackend) => {
    let backend: Backend | undefined;

    afterEach(() => {
        vi.useRealTimers();
        backend?.close();
        backend = undefined;
    });

    const deploy = (providerOptions: Partial<ProviderOptions> = {}): ProviderAuth => {
        backend = makeBackend();

        const options: LunoraAuthOptions = {
            baseURL: ORIGIN,
            database: backend.database,
            emailAndPassword: { enabled: true },
            plugins: [jwt(), oauthProvider({ consentPage: "/consent", loginPage: "/login", ...providerOptions })],
            rateLimit: { enabled: false },
            secret: "x".repeat(32),
        };

        backend.materialise(options);

        return createAuth(options) as unknown as ProviderAuth;
    };

    /** Signs a user in and returns the session cookie the authorize endpoint reads. */
    const signIn = async (auth: ProviderAuth, email: string): Promise<Headers> => {
        await auth.api.signUpEmail({ body: { email, name: email, password: PASSWORD } });

        const { headers } = await auth.api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });

        return new Headers({ cookie: headers.get("set-cookie") ?? "" });
    };

    /** A confidential client that skips consent, so the code flow needs no consent page. */
    const registerClient = async (auth: ProviderAuth, session: Headers): Promise<Client> => {
        const created = await auth.api.adminCreateOAuthClient({
            body: {
                grant_types: ["authorization_code", "refresh_token"],
                redirect_uris: [REDIRECT_URI],
                skip_consent: true,
                token_endpoint_auth_method: "client_secret_post",
            },
            headers: session,
        });

        return { id: created.client_id, secret: created.client_secret };
    };

    const readTokens = async (response: Response): Promise<Tokens> => {
        const body: { access_token?: string; refresh_token?: string } = await response.json();

        if (response.status !== 200 || body.access_token === undefined || body.refresh_token === undefined) {
            throw new Error(`token request failed with ${String(response.status)}: ${JSON.stringify(body)}`);
        }

        return { access: body.access_token, refresh: body.refresh_token };
    };

    /** One full authorization-code grant with PKCE and `offline_access`. */
    const authorize = async (auth: ProviderAuth, client: Client, session: Headers): Promise<Tokens> => {
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

        const redirect = await auth.handler(new Request(url, { headers: session }));
        const location = redirect.headers.get("location");
        const code = location === null ? null : new URL(location).searchParams.get("code");

        if (code === null) {
            throw new Error(`authorize did not issue a code (status ${String(redirect.status)}, location ${String(location)})`);
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

    const refresh = async (auth: ProviderAuth, client: Client, refreshToken: string): Promise<Response> =>
        await auth.handler(
            form("/oauth2/token", { client_id: client.id, client_secret: client.secret, grant_type: "refresh_token", refresh_token: refreshToken }),
        );

    const isActive = async (auth: ProviderAuth, client: Client, token: string, hint: "access_token" | "refresh_token"): Promise<boolean> => {
        const response = await auth.handler(form("/oauth2/introspect", { client_id: client.id, client_secret: client.secret, token, token_type_hint: hint }));
        const body: { active?: boolean } = await response.json();

        return body.active === true;
    };

    it("revokes the whole (client, user) family when a rotated refresh token is replayed", async () => {
        expect.assertions(12);

        const auth = deploy();
        const session = await signIn(auth, "ada@example.com");
        const client = await registerClient(auth, session);
        // A second, independent grant by the same user to the same client — another device.
        const sibling = await authorize(auth, client, session);
        const first = await authorize(auth, client, session);
        const rotated = await readTokens(await refresh(auth, client, first.refresh));

        await expect(isActive(auth, client, rotated.access, "access_token")).resolves.toBe(true);
        await expect(isActive(auth, client, sibling.refresh, "refresh_token")).resolves.toBe(true);

        const replay = await refresh(auth, client, first.refresh);

        expect(replay.status).toBe(400);
        await expect(replay.json()).resolves.toMatchObject({ error: "invalid_grant" });

        // The token the attacker (or the victim) rotated to is dead too…
        const descendant = await refresh(auth, client, rotated.refresh);

        expect(descendant.status).toBe(400);
        await expect(descendant.json()).resolves.toMatchObject({ error: "invalid_grant" });
        await expect(isActive(auth, client, rotated.access, "access_token")).resolves.toBe(false);
        await expect(isActive(auth, client, first.access, "access_token")).resolves.toBe(false);
        await expect(isActive(auth, client, rotated.refresh, "refresh_token")).resolves.toBe(false);

        // …and so is every other grant this user gave this client.
        await expect(isActive(auth, client, sibling.access, "access_token")).resolves.toBe(false);
        await expect(isActive(auth, client, sibling.refresh, "refresh_token")).resolves.toBe(false);

        const siblingRefresh = await refresh(auth, client, sibling.refresh);

        expect(siblingRefresh.status).toBe(400);
    });

    it("leaves another user's grant to the same client alive", async () => {
        expect.assertions(3);

        const auth = deploy();
        const adaSession = await signIn(auth, "ada@example.com");
        const client = await registerClient(auth, adaSession);
        const grace = await authorize(auth, client, await signIn(auth, "grace@example.com"));
        const ada = await authorize(auth, client, adaSession);

        await readTokens(await refresh(auth, client, ada.refresh));

        const replay = await refresh(auth, client, ada.refresh);

        expect(replay.status).toBe(400);
        await expect(isActive(auth, client, grace.access, "access_token")).resolves.toBe(true);
        await expect(readTokens(await refresh(auth, client, grace.refresh))).resolves.toMatchObject({ refresh: expect.any(String) });
    });

    it("answers a retry inside refreshTokenReuseInterval with the same tokens, and revokes after it", async () => {
        expect.assertions(5);

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

        const late = await refresh(auth, client, first.refresh);

        expect(late.status).toBe(400);
        await expect(isActive(auth, client, rotated.refresh, "refresh_token")).resolves.toBe(false);
    });

    // Each rotation restarts `refreshTokenExpiresIn`, so the lifetime slides: a
    // client that keeps refreshing never hits it, one that goes quiet does.
    it("expires a refresh token refreshTokenExpiresIn after it was issued, counted from the last rotation", async () => {
        expect.assertions(3);

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

        vi.advanceTimersByTime(61_000);

        const expired = await refresh(auth, client, kept.refresh);

        expect(expired.status).toBe(400);
        await expect(expired.json()).resolves.toMatchObject({ error: "invalid_grant" });
    });
});
