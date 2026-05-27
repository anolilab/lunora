import { beforeEach, describe, expect, test, vi } from "vitest";

import { createAuth } from "../src/createAuth.js";
import { emailPassword } from "../src/providers/emailPassword.js";
import { github } from "../src/providers/github.js";
import { google } from "../src/providers/google.js";
import { FakeD1 } from "./_fakeD1.js";
import { createFakeSessionNamespace, type FakeSessionNamespace } from "./_fakeSession.js";

const readCookie = (response: Response, name: string): string | null => {
    const setCookie = response.headers.get("set-cookie");

    if (!setCookie) {
        return null;
    }

    const match = new RegExp(`${name}=([^;]+)`).exec(setCookie);

    return match?.[1] ?? null;
};

describe("createAuth", () => {
    let env: { DB: FakeD1; SESSION: FakeSessionNamespace };

    beforeEach(() => {
        env = { DB: new FakeD1(), SESSION: createFakeSessionNamespace() };
    });

    test("throws when secret is missing", () => {
        expect(() => createAuth({ secret: "", providers: [emailPassword()] })).toThrow(/secret/);
    });

    test("throws when no providers configured", () => {
        expect(() => createAuth({ secret: "s", providers: [] })).toThrow(/provider/);
    });

    test("end-to-end signup -> me -> signout flow with cookie session", async () => {
        const auth = createAuth({ secret: "s", providers: [emailPassword()] });
        const routes = auth.routes();

        const signupRequest = new Request("https://app.test/auth/signup", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "a@b.test", password: "hunter22", name: "Alice" }),
        });
        const signupResponse = await routes["POST /auth/signup"]!(signupRequest, env, {});

        expect(signupResponse.status).toBe(201);

        const sessionId = readCookie(signupResponse, "cirrus_session");

        expect(sessionId).toBeTruthy();

        const meRequest = new Request("https://app.test/auth/me", {
            headers: { cookie: `cirrus_session=${sessionId}` },
        });
        const meResponse = await routes["GET /auth/me"]!(meRequest, env, {});
        const meBody = (await meResponse.json()) as { authenticated: boolean; user: { email: string } };

        expect(meResponse.status).toBe(200);
        expect(meBody.authenticated).toBe(true);
        expect(meBody.user.email).toBe("a@b.test");

        const resolved = await auth.resolveAuth(meRequest, env);

        expect(resolved.authenticated).toBe(true);

        if (resolved.authenticated) {
            expect(resolved.user.email).toBe("a@b.test");
        }

        const signoutRequest = new Request("https://app.test/auth/signout", {
            method: "POST",
            headers: { cookie: `cirrus_session=${sessionId}` },
        });
        const signoutResponse = await routes["POST /auth/signout"]!(signoutRequest, env, {});

        expect(signoutResponse.status).toBe(200);

        const afterMeRequest = new Request("https://app.test/auth/me", {
            headers: { cookie: `cirrus_session=${sessionId}` },
        });
        const afterMeResponse = await routes["GET /auth/me"]!(afterMeRequest, env, {});
        const afterMeBody = (await afterMeResponse.json()) as { authenticated: boolean };

        expect(afterMeBody.authenticated).toBe(false);
    });

    test("signin rejects unknown email + wrong password", async () => {
        const auth = createAuth({ secret: "s", providers: [emailPassword()] });
        const routes = auth.routes();

        const unknown = await routes["POST /auth/signin"]!(
            new Request("https://app.test/auth/signin", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email: "nope@x.test", password: "x" }),
            }),
            env,
            {},
        );

        expect(unknown.status).toBe(401);

        await routes["POST /auth/signup"]!(
            new Request("https://app.test/auth/signup", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email: "u@x.test", password: "goodpassword" }),
            }),
            env,
            {},
        );

        const wrong = await routes["POST /auth/signin"]!(
            new Request("https://app.test/auth/signin", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email: "u@x.test", password: "badpassword" }),
            }),
            env,
            {},
        );

        expect(wrong.status).toBe(401);
    });

    test("signup returns a generic pending_verification response for duplicate emails", async () => {
        // Per audit H4: leaking "email already in use" enables enumeration. We
        // return the same 201 + `{ status: "pending_verification" }` for both
        // first signups and duplicates; the legitimate owner gets a real
        // verification email (v0.2). The duplicate response MUST NOT include
        // a session cookie because no new session was created.
        const auth = createAuth({ secret: "s", providers: [emailPassword()] });
        const routes = auth.routes();
        const make = () =>
            new Request("https://app.test/auth/signup", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email: "dup@x.test", password: "hunter22" }),
            });

        const first = await routes["POST /auth/signup"]!(make(), env, {});

        expect(first.status).toBe(201);
        expect(readCookie(first, "cirrus_session")).toBeTruthy();

        const second = await routes["POST /auth/signup"]!(make(), env, {});

        expect(second.status).toBe(201);

        const secondBody = (await second.json()) as { status?: string };

        expect(secondBody.status).toBe("pending_verification");
        expect(readCookie(second, "cirrus_session")).toBeNull();
    });

    test("signup rejects passwords shorter than 8 characters", async () => {
        const auth = createAuth({ secret: "s", providers: [emailPassword()] });
        const response = await auth.routes()["POST /auth/signup"]!(
            new Request("https://app.test/auth/signup", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email: "weak@x.test", password: "pw" }),
            }),
            env,
            {},
        );

        expect(response.status).toBe(400);

        const body = (await response.json()) as { error?: { code?: string } };

        expect(body.error?.code).toBe("WEAK_PASSWORD");
    });

    test("signup is disabled when allowSignup=false", async () => {
        const auth = createAuth({ secret: "s", providers: [emailPassword({ allowSignup: false })] });
        const response = await auth.routes()["POST /auth/signup"]!(
            new Request("https://app.test/auth/signup", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email: "x@x.test", password: "hunter22" }),
            }),
            env,
            {},
        );

        expect(response.status).toBe(403);
    });

    test("github start route 302s to the provider authorization endpoint", async () => {
        const auth = createAuth({
            secret: "s",
            providers: [github({ clientId: "id", clientSecret: "secret" })],
        });
        const response = await auth.routes()["GET /auth/oauth/github/start"]!(
            new Request("https://app.test/auth/oauth/github/start"),
            env,
            {},
        );

        expect(response.status).toBe(302);
        expect(response.headers.get("location")?.startsWith("https://github.com/login/oauth/authorize")).toBe(true);
    });

    test("github callback exchanges code against the real endpoints and issues a session", async () => {
        // Per audit C6: the callback validates the `state` query param against
        // the state cookie set during `/start`. We must drive the full flow so
        // the cookie value is in scope before hitting the callback.
        const auth = createAuth({
            secret: "s",
            providers: [github({ clientId: "id", clientSecret: "secret" })],
        });
        const routes = auth.routes();

        const startResponse = await routes["GET /auth/oauth/github/start"]!(
            new Request("https://app.test/auth/oauth/github/start"),
            env,
            {},
        );

        const setCookie = startResponse.headers.get("set-cookie") ?? "";
        const stateMatch = /cirrus_oauth_s_github=([^;]+)/.exec(setCookie);
        const verifierMatch = /cirrus_oauth_v_github=([^;]+)/.exec(setCookie);

        expect(stateMatch?.[1]).toBeTruthy();
        expect(verifierMatch?.[1]).toBeTruthy();

        const state = stateMatch![1]!;
        const verifier = verifierMatch![1]!;

        const tokenForm = new URLSearchParams();

        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
            const url = typeof input === "string" ? input : (input as Request).url;
            const method = (init?.method ?? (typeof input === "string" ? "GET" : (input as Request).method)) ?? "GET";

            if (url === "https://github.com/login/oauth/access_token" && method === "POST") {
                const body = (init?.body ?? "").toString();

                for (const [key, value] of new URLSearchParams(body).entries()) {
                    tokenForm.set(key, value);
                }

                return new Response(JSON.stringify({ access_token: "gh-access-token", token_type: "bearer", scope: "read:user" }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }

            if (url === "https://api.github.com/user") {
                return new Response(
                    JSON.stringify({ id: 4242, login: "octocat", name: "The Octocat", email: "octo@example.test" }),
                    { status: 200, headers: { "content-type": "application/json" } },
                );
            }

            throw new Error(`unexpected fetch to ${url}`);
        });

        const response = await routes["GET /auth/oauth/github/callback"]!(
            new Request(`https://app.test/auth/oauth/github/callback?code=abc&state=${state}`, {
                headers: { cookie: `cirrus_oauth_s_github=${state}; cirrus_oauth_v_github=${verifier}` },
            }),
            env,
            {},
        );

        expect(response.status).toBe(200);

        const body = (await response.json()) as { user: { provider: string; providerAccountId: string | null; email: string | null } };

        expect(body.user.provider).toBe("github");
        expect(body.user.providerAccountId).toBe("4242");
        expect(body.user.email).toBe("octo@example.test");
        expect(readCookie(response, "cirrus_session")).toBeTruthy();

        // Assert the token-exchange request shape — the PKCE verifier and the
        // redirect_uri must be forwarded verbatim.
        expect(tokenForm.get("client_id")).toBe("id");
        expect(tokenForm.get("client_secret")).toBe("secret");
        expect(tokenForm.get("code")).toBe("abc");
        expect(tokenForm.get("code_verifier")).toBe(verifier);
        expect(tokenForm.get("redirect_uri")).toBe("https://app.test/auth/oauth/github/callback");

        fetchSpy.mockRestore();
    });

    test("github callback falls back to /user/emails when the primary email is private", async () => {
        const auth = createAuth({
            secret: "s",
            providers: [github({ clientId: "id", clientSecret: "secret" })],
        });
        const routes = auth.routes();

        const startResponse = await routes["GET /auth/oauth/github/start"]!(new Request("https://app.test/auth/oauth/github/start"), env, {});
        const setCookie = startResponse.headers.get("set-cookie") ?? "";
        const state = /cirrus_oauth_s_github=([^;]+)/.exec(setCookie)![1]!;
        const verifier = /cirrus_oauth_v_github=([^;]+)/.exec(setCookie)![1]!;
        let emailsHit = false;

        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
            const url = typeof input === "string" ? input : (input as Request).url;

            if (url === "https://github.com/login/oauth/access_token") {
                return new Response(JSON.stringify({ access_token: "tok" }), { status: 200, headers: { "content-type": "application/json" } });
            }

            if (url === "https://api.github.com/user") {
                return new Response(JSON.stringify({ id: 99, login: "private-octo", name: null, email: null }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }

            if (url === "https://api.github.com/user/emails") {
                emailsHit = true;

                return new Response(
                    JSON.stringify([
                        { email: "noreply@github.test", primary: false, verified: true },
                        { email: "real@octo.test", primary: true, verified: true },
                    ]),
                    { status: 200, headers: { "content-type": "application/json" } },
                );
            }

            throw new Error(`unexpected fetch to ${url}`);
        });

        const response = await routes["GET /auth/oauth/github/callback"]!(
            new Request(`https://app.test/auth/oauth/github/callback?code=zzz&state=${state}`, {
                headers: { cookie: `cirrus_oauth_s_github=${state}; cirrus_oauth_v_github=${verifier}` },
            }),
            env,
            {},
        );

        expect(response.status).toBe(200);
        expect(emailsHit).toBe(true);

        const body = (await response.json()) as { user: { email: string | null } };

        expect(body.user.email).toBe("real@octo.test");

        fetchSpy.mockRestore();
    });

    test("google callback exchanges code, decodes id_token, and issues a session", async () => {
        const auth = createAuth({
            secret: "s",
            providers: [google({ clientId: "google-id", clientSecret: "google-secret" })],
        });
        const routes = auth.routes();

        const startResponse = await routes["GET /auth/oauth/google/start"]!(new Request("https://app.test/auth/oauth/google/start"), env, {});
        const setCookie = startResponse.headers.get("set-cookie") ?? "";
        const state = /cirrus_oauth_s_google=([^;]+)/.exec(setCookie)![1]!;
        const verifier = /cirrus_oauth_v_google=([^;]+)/.exec(setCookie)![1]!;

        // Build a minimal JWT (header.payload.signature). Signature value is
        // never verified in v0.1 — we just need a valid base64url payload.
        const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
        const payload = btoa(JSON.stringify({ sub: "google-sub-1", email: "user@gmail.test", email_verified: true, name: "G User" }))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replaceAll("=", "");
        const idToken = `${header}.${payload}.signature-placeholder`;
        const tokenForm = new URLSearchParams();

        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
            const url = typeof input === "string" ? input : (input as Request).url;

            if (url === "https://oauth2.googleapis.com/token") {
                const body = (init?.body ?? "").toString();

                for (const [key, value] of new URLSearchParams(body).entries()) {
                    tokenForm.set(key, value);
                }

                return new Response(JSON.stringify({ access_token: "acc", id_token: idToken, expires_in: 3600 }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }

            throw new Error(`unexpected fetch to ${url}`);
        });

        const response = await routes["GET /auth/oauth/google/callback"]!(
            new Request(`https://app.test/auth/oauth/google/callback?code=g-code&state=${state}`, {
                headers: { cookie: `cirrus_oauth_s_google=${state}; cirrus_oauth_v_google=${verifier}` },
            }),
            env,
            {},
        );

        expect(response.status).toBe(200);

        const body = (await response.json()) as { user: { provider: string; providerAccountId: string; email: string | null; name: string | null } };

        expect(body.user.provider).toBe("google");
        expect(body.user.providerAccountId).toBe("google-sub-1");
        expect(body.user.email).toBe("user@gmail.test");
        expect(body.user.name).toBe("G User");

        expect(tokenForm.get("client_id")).toBe("google-id");
        expect(tokenForm.get("client_secret")).toBe("google-secret");
        expect(tokenForm.get("grant_type")).toBe("authorization_code");
        expect(tokenForm.get("code")).toBe("g-code");
        expect(tokenForm.get("code_verifier")).toBe(verifier);

        fetchSpy.mockRestore();
    });

    test("oauth callback returns 503 when client credentials are unset", async () => {
        const auth = createAuth({
            secret: "s",
            providers: [github({ clientId: "", clientSecret: "" })],
        });
        const routes = auth.routes();

        const startResponse = await routes["GET /auth/oauth/github/start"]!(new Request("https://app.test/auth/oauth/github/start"), env, {});
        const setCookie = startResponse.headers.get("set-cookie") ?? "";
        const state = /cirrus_oauth_s_github=([^;]+)/.exec(setCookie)![1]!;
        const verifier = /cirrus_oauth_v_github=([^;]+)/.exec(setCookie)![1]!;

        const response = await routes["GET /auth/oauth/github/callback"]!(
            new Request(`https://app.test/auth/oauth/github/callback?code=abc&state=${state}`, {
                headers: { cookie: `cirrus_oauth_s_github=${state}; cirrus_oauth_v_github=${verifier}` },
            }),
            env,
            {},
        );

        expect(response.status).toBe(503);

        const body = (await response.json()) as { error: { code: string } };

        expect(body.error.code).toBe("OAUTH_NOT_CONFIGURED");
    });

    test("github callback rejects requests with mismatched state (CSRF guard)", async () => {
        const auth = createAuth({
            secret: "s",
            providers: [github({ clientId: "id", clientSecret: "secret" })],
        });

        const response = await auth.routes()["GET /auth/oauth/github/callback"]!(
            new Request("https://app.test/auth/oauth/github/callback?code=abc&state=attacker-supplied", {
                headers: { cookie: "cirrus_oauth_s_github=legitimate-state; cirrus_oauth_v_github=v" },
            }),
            env,
            {},
        );

        expect(response.status).toBe(400);

        const body = (await response.json()) as { error?: { code?: string } };

        expect(body.error?.code).toBe("STATE_MISMATCH");
    });

    test("github callback rejects requests with no state cookie at all", async () => {
        const auth = createAuth({
            secret: "s",
            providers: [github({ clientId: "id", clientSecret: "secret" })],
        });

        const response = await auth.routes()["GET /auth/oauth/github/callback"]!(
            new Request("https://app.test/auth/oauth/github/callback?code=abc&state=xyz"),
            env,
            {},
        );

        expect(response.status).toBe(400);
    });

    test("resolveAuth returns unauthenticated when no cookie is present", async () => {
        const auth = createAuth({ secret: "s", providers: [emailPassword()] });
        const state = await auth.resolveAuth(new Request("https://app.test/x"), env);

        expect(state.authenticated).toBe(false);
    });

    test("session writes route through env.SESSION (SessionDO namespace)", async () => {
        // The wiring contract: every signup/signin must hit env.SESSION via
        // idFromName so apps that bind a real SessionDO see traffic land in
        // the DO. This is the spec-asserting test for Task 3.
        const auth = createAuth({ secret: "s", providers: [emailPassword()] });
        const routes = auth.routes();

        await routes["POST /auth/signup"]!(
            new Request("https://app.test/auth/signup", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email: "do@x.test", password: "longenough" }),
            }),
            env,
            {},
        );

        expect(env.SESSION.idFromName).toHaveBeenCalled();
        // Sharding key derives from the cookie token's first 16 chars.
        const firstCall = env.SESSION.idFromName.mock.calls[0]?.[0];

        expect(typeof firstCall).toBe("string");
        expect((firstCall as string).length).toBe(16);
        expect(env.SESSION.instances.size).toBeGreaterThan(0);
    });
});
