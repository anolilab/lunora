import { describe, expect, it } from "vitest";

import { buildAuth, cookieNamed, cookieValue, EMAIL, ORIGIN, SESSION_TOKEN, setCookies, signIn } from "./_helpers/auth-harness";

/**
 * The session cookie names and attributes the control plane emits and reads.
 *
 * Sibling tenant hosts share a registrable domain with the control plane, so a
 * `Domain`-scoped cookie from a tenant reaches it. The `__Host-` prefix is what
 * forbids a `Domain` attribute; these pin that the session cookies carry it, and
 * that the default `__Secure-` name (which does not forbid one) is never read.
 *
 * The real better-auth instance runs against an in-memory adapter (see the harness).
 */

describe("session cookie prefix", () => {
    it("sets the session token under the __Host- name with no Domain, Secure, HttpOnly and Path=/", async () => {
        expect.assertions(6);

        const auth = await buildAuth();
        const response = await signIn(auth);
        const token = cookieNamed(setCookies(response), SESSION_TOKEN);

        expect(response.status).toBe(200);
        expect(token).toMatch(/; Path=\/(;|$)/);
        expect(token).toContain("HttpOnly");
        expect(token).toContain("Secure");
        expect(token).not.toMatch(/Domain=/i);
        expect(token).toContain("SameSite=Lax");
    });

    it("sets no session cookie under the default __Secure- name", async () => {
        expect.assertions(2);

        const auth = await buildAuth();
        const lines = setCookies(await signIn(auth));

        expect(lines.some((line) => line.startsWith("__Secure-"))).toBe(false);
        expect(lines.some((line) => line.startsWith("better-auth."))).toBe(false);
    });

    it("reads the session back from the __Host- cookie", async () => {
        expect.assertions(2);

        const auth = await buildAuth();
        const token = cookieNamed(setCookies(await signIn(auth)), SESSION_TOKEN);

        const session = await auth.handler(new Request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie: `${SESSION_TOKEN}=${cookieValue(token)}` } }));

        expect(session.status).toBe(200);
        await expect(session.json()).resolves.toMatchObject({ user: { email: EMAIL } });
    });

    it("names all four auth cookies __Host- with Secure and Path=/", async () => {
        expect.assertions(8);

        const auth = await buildAuth();
        const { authCookies } = await auth.$context;

        for (const cookie of [authCookies.sessionToken, authCookies.sessionData, authCookies.accountData, authCookies.dontRememberToken]) {
            expect(cookie.name).toMatch(/^__Host-better-auth\./);
            expect(cookie.attributes).toMatchObject({ path: "/", secure: true });
        }
    });

    it("sets the dont_remember cookie under the __Host- name when rememberMe is false", async () => {
        expect.assertions(2);

        const auth = await buildAuth();
        const lines = setCookies(await signIn(auth, false));

        expect(cookieNamed(lines, "__Host-better-auth.dont_remember")).toContain("Secure");
        expect(lines.some((line) => line.startsWith("__Secure-"))).toBe(false);
    });

    it("keeps Secure on plugin cookies that carry no prefix override", async () => {
        expect.assertions(1);

        const auth = await buildAuth();
        const ctx = await auth.$context;

        expect(ctx.createAuthCookie("two_factor").attributes).toMatchObject({ httpOnly: true, path: "/", sameSite: "lax", secure: true });
    });

    it("does not read the old __Secure- session cookie as a session", async () => {
        expect.assertions(1);

        const auth = await buildAuth();
        const token = cookieNamed(setCookies(await signIn(auth)), SESSION_TOKEN);

        const session = await auth.handler(
            new Request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie: `__Secure-better-auth.session_token=${cookieValue(token)}` } }),
        );

        await expect(session.json()).resolves.toBeNull();
    });

    it("rejects a __Host- cookie with a forged signature", async () => {
        expect.assertions(1);

        const auth = await buildAuth();
        const token = cookieNamed(setCookies(await signIn(auth)), SESSION_TOKEN);
        const [payload] = decodeURIComponent(cookieValue(token)).split(".");
        const forged = `${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

        const session = await auth.handler(
            new Request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie: `${SESSION_TOKEN}=${encodeURIComponent(forged)}` } }),
        );

        await expect(session.json()).resolves.toBeNull();
    });
});
