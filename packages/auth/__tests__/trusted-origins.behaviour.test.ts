import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lunoraAuthAdapter } from "../src/adapter";
import type { LunoraAuth, LunoraAuthOptions } from "../src/create-auth";
import { createAuth } from "../src/create-auth";
import { createSqlAuthStore } from "../src/sql-store";
import { executorFor, materialiseAuthSchema } from "./helpers/sqlite-auth-db";

/**
 * Sign-in must work on a freshly deployed worker that configured **neither**
 * `baseURL` **nor** `trustedOrigins`.
 *
 * That shape is the common one on Cloudflare Workers, and `create-auth.ts` documents
 * why: `baseURL` is very often left unset so better-auth infers the origin per request.
 * The risk is that better-auth's CSRF layer (`validateOrigin`) rejects every
 * cookie-bearing POST with `INVALID_ORIGIN` when its trusted list is empty — which is
 * what a naive read of `getTrustedOrigins(options)` suggests, since the context-time
 * call passes no `request` and therefore resolves no origin at all.
 *
 * It does not, because `createBetterAuth`'s handler recomputes the list per request
 * (`auth/base.mjs`: when `options.baseURL` is unset it derives the base URL from the
 * request, then re-runs `getTrustedOrigins(trustOptions, request)`), so the origin the
 * browser actually connected to is trusted for that request. These tests pin that
 * behaviour: it is the reason Lunora ships no `trustedOrigins` default of its own, and
 * it is load-bearing for zero-config sign-in after deploy. A better-auth change that
 * moved the resolution back to context-creation time would break every deployment
 * relying on origin inference, silently and only in production.
 *
 * Deliberately driven through `auth.handler(request)` rather than `auth.api.*`: the
 * origin/CSRF middleware only runs on the HTTP path, so a direct `api` call proves
 * nothing here.
 *
 * ## Why every case sets `disableOriginCheck: false`
 *
 * better-auth resolves `skipOriginCheck` in `context/create-context.mjs` as: the caller's
 * `advanced.disableOriginCheck` when set, else **true** under `isTest()`. Vitest sets
 * `NODE_ENV=test`, so without the explicit `false` the middleware returns early and every
 * origin is accepted — the two positive cases below then pass while proving nothing, and
 * the two negative ones fail outright. Setting it restores the production code path, the
 * only one worth asserting on.
 *
 * Which is also the property that keeps this suite honest: it asserts in **both**
 * directions, so it cannot quietly decay into a vacuous pass. An accept-everything
 * regression breaks the negative cases; a reject-everything regression breaks the
 * positive ones.
 *
 * ## Why the environment is stubbed
 *
 * `getBaseURL` consults `BETTER_AUTH_URL` and its framework-prefixed variants *before*
 * falling back to the request, and `getTrustedOrigins` appends
 * `BETTER_AUTH_TRUSTED_ORIGINS` to the list. Any of those set in the ambient shell silently
 * changes the verdict: pointing `BETTER_AUTH_TRUSTED_ORIGINS` at the foreign origin below
 * turns "CSRF protection is intact" red with no hint that the environment is the cause, and
 * `BETTER_AUTH_URL` is exactly what a developer working on a better-auth app would have
 * exported. Clearing them is what makes the run hermetic.
 */

const SECRET = "lunora-trusted-origins-secret-lunora-trusted-xx";
const EMAIL = "ada@example.com";
// test-only credential for an in-memory better-auth instance — never a real secret
const PASSWORD = "correct-horse-battery-staple"; // secret-scanner:allow

/** The origin the "deployment" is reached on; never configured on the auth instance. */
const OWN_ORIGIN = "https://app.example.com";
const FOREIGN_ORIGIN = "https://evil.example";

let database: DatabaseSync;

/**
 * Every env key that can pre-empt or widen the request-derived origin — the
 * `BETTER_AUTH_URL` family read by `getBaseURL`, plus `BETTER_AUTH_TRUSTED_ORIGINS`
 * appended by `getTrustedOrigins`. `BASE_URL` is deliberately absent: Vitest owns that
 * key, and stubbing it breaks the runner rather than the dependency.
 */
const AMBIENT_ORIGIN_KEYS = [
    "BETTER_AUTH_URL",
    "NEXT_PUBLIC_BETTER_AUTH_URL",
    "PUBLIC_BETTER_AUTH_URL",
    "NUXT_PUBLIC_BETTER_AUTH_URL",
    "NUXT_PUBLIC_AUTH_URL",
    "BETTER_AUTH_TRUSTED_ORIGINS",
] as const;

/**
 * The deployment under test: no `baseURL`, no `trustedOrigins`, schema materialised to
 * match the options it will actually run with.
 *
 * Rate limiting is off so a burst of cases can't turn into a 429 that masks the origin
 * verdict — the limiter has no bearing on the origin middleware.
 */
const deployAuth = (): LunoraAuth => {
    const options: LunoraAuthOptions = {
        // Undo better-auth's `isTest()` default of skipping the origin check; see the
        // module comment. Everything else is left at Lunora's own defaults.
        advanced: { disableOriginCheck: false },
        database: lunoraAuthAdapter(createSqlAuthStore(executorFor(database))),
        emailAndPassword: { enabled: true },
        rateLimit: { enabled: false },
        secret: SECRET,
    };

    materialiseAuthSchema(database, options);

    return createAuth(options);
};

/**
 * A sign-in POST carrying valid credentials, so a rejection can only ever be the origin
 * verdict. The `cookie` header matters: `validateOrigin` only engages on a request that
 * carries cookies.
 */
const signInRequest = ({ callbackURL, origin }: { callbackURL?: string; origin: string }): Request =>
    new Request(`${OWN_ORIGIN}/api/auth/sign-in/email`, {
        body: JSON.stringify({ email: EMAIL, password: PASSWORD, ...(callbackURL === undefined ? {} : { callbackURL }) }),
        headers: {
            "content-type": "application/json",
            cookie: "prior-session=1",
            origin,
        },
        method: "POST",
    });

describe("trusted origins with neither baseURL nor trustedOrigins configured", () => {
    let auth: LunoraAuth;

    beforeEach(async () => {
        for (const key of AMBIENT_ORIGIN_KEYS) {
            vi.stubEnv(key, undefined);
        }

        database = new DatabaseSync(":memory:");
        auth = deployAuth();

        // `auth.api.*` has no Request, so this bypasses the origin middleware under test.
        await auth.api.signUpEmail({ body: { email: EMAIL, name: "Ada", password: PASSWORD } });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        database.close();
    });

    it("accepts a sign-in from the origin the request arrived on", async () => {
        expect.assertions(1);

        const response = await auth.handler(signInRequest({ origin: OWN_ORIGIN }));

        expect(response.status).toBe(200);
    });

    it("still rejects a cross-origin sign-in, so CSRF protection is intact", async () => {
        expect.assertions(2);

        const response = await auth.handler(signInRequest({ origin: FOREIGN_ORIGIN }));

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ code: "INVALID_ORIGIN" });
    });

    it("accepts a callbackURL on the deployment's own origin", async () => {
        expect.assertions(1);

        const response = await auth.handler(signInRequest({ callbackURL: `${OWN_ORIGIN}/welcome`, origin: OWN_ORIGIN }));

        expect(response.status).toBe(200);
    });

    it("rejects a callbackURL pointing at another origin", async () => {
        expect.assertions(2);

        const response = await auth.handler(signInRequest({ callbackURL: `${FOREIGN_ORIGIN}/steal`, origin: OWN_ORIGIN }));

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ code: "INVALID_CALLBACK_URL" });
    });
});
