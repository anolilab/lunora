import { describe, expect, it } from "vitest";

import { clearLegacyAuthCookies } from "../src/auth-legacy-cookies";
import { buildAuth, cookieNamed, cookieValue, ORIGIN, SESSION_TOKEN, setCookies, signIn } from "./_helpers/auth-harness";

/**
 * The clearing of the pre-rename `__Secure-better-auth.*` cookies. The sign-out case
 * runs against the real better-auth instance, because it proves the appended clearing
 * lines sit beside better-auth's own Set-Cookie lines. The other cases use plain
 * Response objects, since they only look at the request and the response headers.
 */

const LEGACY_NAMES = [
    "__Secure-better-auth.account_data",
    "__Secure-better-auth.dont_remember",
    "__Secure-better-auth.session_data",
    "__Secure-better-auth.session_token",
];

describe(clearLegacyAuthCookies, () => {
    it("clears each pre-rename session cookie once on sign-out, and adds no __Host- clearing", async () => {
        expect.assertions(5);

        const auth = await buildAuth();
        const token = cookieNamed(setCookies(await signIn(auth)), SESSION_TOKEN);
        const request = new Request(`${ORIGIN}/api/auth/sign-out`, {
            headers: { cookie: `${SESSION_TOKEN}=${cookieValue(token)}`, origin: ORIGIN },
            method: "POST",
        });
        const upstream = await auth.handler(request);
        const response = clearLegacyAuthCookies(request, upstream.clone());
        const added = setCookies(response).slice(setCookies(upstream).length);

        expect(response.status).toBe(200);
        expect(added).toHaveLength(4);
        expect(new Set(added.map((line) => line.split("=")[0]))).toStrictEqual(new Set(LEGACY_NAMES));
        expect(added.every((line) => line.includes("Max-Age=0") && line.includes("Path=/") && line.includes("Secure"))).toBe(true);
        expect(added.some((line) => line.startsWith("__Host-"))).toBe(false);
    });

    it("clears the legacy cookies on an auth request that still carries one", () => {
        expect.assertions(2);

        const request = new Request(`${ORIGIN}/api/auth/get-session`, {
            headers: { cookie: "__Secure-better-auth.session_token=stale" },
        });
        const response = clearLegacyAuthCookies(request, new Response("{}", { headers: { "content-type": "application/json" } }));
        const cleared = setCookies(response).filter((line) => line.includes("Max-Age=0"));

        expect(cleared).toHaveLength(4);
        expect(cleared.some((line) => line.startsWith("__Host-"))).toBe(false);
    });

    it("leaves an auth response untouched when the request carries no legacy cookie", () => {
        expect.assertions(1);

        const request = new Request(`${ORIGIN}/api/auth/get-session`);
        const upstream = new Response("{}");

        expect(clearLegacyAuthCookies(request, upstream)).toBe(upstream);
    });
});
