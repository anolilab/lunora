import { DatabaseSync } from "node:sqlite";

import { getIP } from "better-auth/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lunoraAuthAdapter } from "../src/adapter";
import type { LunoraAuth, LunoraAuthOptions } from "../src/create-auth";
import { createAuth, resolveAuthOptions } from "../src/create-auth";
import { createSqlAuthStore } from "../src/sql-store";
import { executorFor, materialiseAuthSchema } from "./helpers/sqlite-auth-db";

/**
 * What the rate limiter counts *per*.
 *
 * `resolveAuthOptions` forces better-auth's limiter on and onto durable storage
 * so `/sign-in*` is capped at the built-in 3 requests per 10 seconds. That is
 * only brute-force protection if the bucket key identifies the client, and
 * better-auth resolves that key from `x-forwarded-for` alone unless told
 * otherwise — a header the client writes.
 *
 * These drive the **real** better-auth handler over the same in-memory SQLite
 * harness `integration.test.ts` uses, because the defect is in what the limiter
 * does with a request, not in the shape of an options object: the bucket key is
 * computed inside `onRequestRateLimit`, which only runs on `auth.handler`.
 */

const SECRET = "lunora-rate-limit-secret-lunora-rate-limit-xxxx";
// test-only credential for an in-memory better-auth instance — never a real secret
const PASSWORD = "correct-horse-battery-staple"; // secret-scanner:allow

const baseOptions = {
    baseURL: "http://localhost:3000",
    emailAndPassword: { enabled: true },
    secret: SECRET,
} as const satisfies LunoraAuthOptions;

let database: DatabaseSync;

/**
 * A sign-in attempt from one client.
 *
 * `x-forwarded-for` carries a client-chosen entry ahead of the real address —
 * the shape an edge that *appends* to a forwarded chain produces, and the shape
 * an attacker produces deliberately. Either way better-auth cannot resolve a
 * client from it without `trustedProxies`, so this is the request that used to
 * collapse every caller onto one shared bucket.
 */
const signInAttempt = (auth: LunoraAuth, clientIp: string): Promise<Response> =>
    auth.handler(
        new Request("http://localhost:3000/api/auth/sign-in/email", {
            body: JSON.stringify({ email: `nobody-${clientIp}@example.com`, password: PASSWORD }),
            headers: {
                "cf-connecting-ip": clientIp,
                "content-type": "application/json",
                "x-forwarded-for": `198.51.100.9, ${clientIp}`,
            },
            method: "POST",
        }),
    );

/**
 * `cf-connecting-ip` is a header the client cannot write only ON Cloudflare, so
 * the default IP-header policy is gated on the runtime: workerd stamps this
 * `navigator.userAgent` and Node does not. Both blocks below therefore stub it,
 * and every test asserts the Cloudflare policy unless it re-stubs it itself.
 */
const CLOUDFLARE_NAVIGATOR = { userAgent: "Cloudflare-Workers" };

describe("rate-limit bucket key", () => {
    const buildAuth = (): LunoraAuth =>
        createAuth({
            ...baseOptions,
            database: lunoraAuthAdapter(createSqlAuthStore(executorFor(database))),
        });

    beforeEach(() => {
        vi.stubGlobal("navigator", CLOUDFLARE_NAVIGATOR);
        database = new DatabaseSync(":memory:");
        materialiseAuthSchema(database, baseOptions);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        database.close();
    });

    it("gives four unrelated clients four buckets, not one", async () => {
        expect.assertions(4);

        const auth = buildAuth();

        // Four distinct clients, one attempt each, well inside the 10s window.
        // Keyed on `x-forwarded-for` they share a single `no-trusted-ip` bucket
        // and the fourth is refused sign-in on its very first attempt.
        for (const clientIp of ["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4"]) {
            // eslint-disable-next-line no-await-in-loop -- sequential on purpose: the limiter counts requests in order.
            const response = await signInAttempt(auth, clientIp);

            expect(response.status).not.toBe(429);
        }
    });

    it("reaches a `/**` custom rule for a nested path, which is what the fallback rides on", async () => {
        expect.assertions(2);

        // The catch-all is keyed `/**`, and better-auth's glob treats `/` as a
        // separator: `/*` would stop at the first one and never match
        // `/sign-in/email`, leaving the fallback installed but unreachable. This
        // pins the pattern through better-auth's own matcher, with a caller rule
        // whose effect is visible (1 per 10s instead of the built-in 3).
        database.close();
        database = new DatabaseSync(":memory:");

        const options = { ...baseOptions, rateLimit: { customRules: { "/**": { max: 1, window: 10 } } } } satisfies LunoraAuthOptions;

        materialiseAuthSchema(database, options);

        const auth = createAuth({ ...options, database: lunoraAuthAdapter(createSqlAuthStore(executorFor(database))) });

        const first = await signInAttempt(auth, "203.0.113.6");
        // A second attempt from the same client exceeds the caller's `max: 1`,
        // which only bites if `/**` matched `/sign-in/email` at all.
        const second = await signInAttempt(auth, "203.0.113.6");

        expect(first.status).not.toBe(429);
        expect(second.status).toBe(429);
    });

    it("still stops one client hammering the same endpoint", async () => {
        expect.assertions(1);

        const auth = buildAuth();
        let refused = false;

        // The other half of the contract: a per-client key must not become a
        // per-request key. Four attempts from ONE client exceed the built-in
        // 3-per-10s sign-in rule.
        for (let attempt = 0; attempt < 4; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential on purpose.
            const response = await signInAttempt(auth, "203.0.113.5");

            refused ||= response.status === 429;
        }

        expect(refused).toBe(true);
    });
});

describe("client IP resolution policy", () => {
    beforeEach(() => {
        vi.stubGlobal("navigator", CLOUDFLARE_NAVIGATOR);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("reads cf-connecting-ip and ignores a client-supplied x-forwarded-for", () => {
        expect.assertions(2);

        const resolved = resolveAuthOptions(baseOptions);

        // The audit trail (`audit-hooks.ts`'s `resolveIp`) already treats
        // `cf-connecting-ip` as the only header a client cannot write. The
        // limiter must agree, or the two disagree about who a request came from.
        expect(getIP(new Headers({ "cf-connecting-ip": "203.0.113.1", "x-forwarded-for": "198.51.100.9" }), resolved)).toBe("203.0.113.1");
        expect(getIP(new Headers({ "cf-connecting-ip": "203.0.113.2", "x-forwarded-for": "198.51.100.9, 203.0.113.2" }), resolved)).toBe("203.0.113.2");
    });

    it("re-admits x-forwarded-for once the caller declares trustedProxies", () => {
        expect.assertions(2);

        // The non-Cloudflare answer: declaring the proxy addresses is what makes
        // the forwarded chain interpretable, so the default must not lock a
        // correctly-configured non-Cloudflare deployment out of its own header.
        const resolved = resolveAuthOptions({ ...baseOptions, advanced: { ipAddress: { trustedProxies: ["192.0.2.10"] } } });

        expect(resolved.advanced?.ipAddress?.ipAddressHeaders).toStrictEqual(["cf-connecting-ip", "x-forwarded-for"]);
        expect(getIP(new Headers({ "x-forwarded-for": "203.0.113.1, 192.0.2.10" }), resolved)).toBe("203.0.113.1");
    });

    it("leaves a caller's own ipAddressHeaders alone", () => {
        expect.assertions(1);

        const resolved = resolveAuthOptions({ ...baseOptions, advanced: { ipAddress: { ipAddressHeaders: ["x-real-ip"] } } });

        expect(resolved.advanced?.ipAddress?.ipAddressHeaders).toStrictEqual(["x-real-ip"]);
    });

    it("does not trust cf-connecting-ip off Cloudflare", () => {
        expect.assertions(2);

        // On a Node host taking direct traffic, nothing sets that header — so it
        // is whatever the client typed, and trusting it hands an attacker a fresh
        // bucket per request: the sign-in limit stops applying to exactly the
        // traffic it exists to stop. Better to resolve nothing and let those
        // requests share the coarse `no-trusted-ip` bucket, which the `/**`
        // fallback above already re-sizes by UNRESOLVED_IP_BUCKET_FACTOR.
        vi.stubGlobal("navigator", { userAgent: "Node.js/24" });

        const resolved = resolveAuthOptions(baseOptions);

        expect(resolved.advanced?.ipAddress?.ipAddressHeaders).toStrictEqual([]);
        // Two attacker-chosen values, one bucket. (`getIP` answers `127.0.0.1`
        // rather than `null` under NODE_ENV=test — the point is that it is the
        // SAME answer either way, so rotating the header buys nothing.)
        expect(getIP(new Headers({ "cf-connecting-ip": "203.0.113.1" }), resolved)).toBe(getIP(new Headers({ "cf-connecting-ip": "203.0.113.2" }), resolved));
    });

    it("uses the declared proxy chain off Cloudflare", () => {
        expect.assertions(2);

        // The non-Cloudflare answer stays available: declared proxies are what
        // make `x-forwarded-for` interpretable, and `cf-connecting-ip` is still
        // not in the list because nothing out there writes it.
        vi.stubGlobal("navigator", { userAgent: "Node.js/24" });

        const resolved = resolveAuthOptions({ ...baseOptions, advanced: { ipAddress: { trustedProxies: ["192.0.2.10"] } } });

        expect(resolved.advanced?.ipAddress?.ipAddressHeaders).toStrictEqual(["x-forwarded-for"]);
        expect(getIP(new Headers({ "x-forwarded-for": "203.0.113.1, 192.0.2.10" }), resolved)).toBe("203.0.113.1");
    });
});

/** better-auth's per-path rule shape, as the custom-rule callback receives and returns it. */
interface RateLimitRule {
    max: number;
    window: number;
}

type CustomRule = (request: Request, rule: RateLimitRule) => RateLimitRule;

/** The catch-all rule `resolveAuthOptions` installs, typed for direct invocation. */
const catchAllRule = (options: LunoraAuthOptions): CustomRule => resolveAuthOptions(options).rateLimit?.customRules?.["/**"] as CustomRule;

describe("shared bucket when no client IP can be resolved", () => {
    /*
     * Exercised through the rule callback rather than a request, because
     * better-auth falls back to `127.0.0.1` whenever `NODE_ENV` is `test` or
     * `development` — under vitest no request can reach the unresolved state at
     * all. `disableIpTracking` is the one input that makes the real `getIP`
     * return `null` regardless of environment, which is the branch a deployment
     * forwarding no trusted header takes in production.
     */
    const SIGN_IN_RULE: RateLimitRule = { max: 3, window: 10 };

    it("widens the bucket instead of rationing every client to one client's budget", () => {
        expect.assertions(2);

        const request = new Request("http://localhost:3000/api/auth/sign-in/email", { method: "POST" });
        const options = { ...baseOptions, advanced: { ipAddress: { disableIpTracking: true } } };

        expect(getIP(request, resolveAuthOptions(options))).toBeNull();
        // A bucket every client shares cannot be sized for one client: at 3
        // per 10s the app denies sign-in to everybody the moment a handful of
        // people use it at once.
        expect(catchAllRule(options)(request, SIGN_IN_RULE)).toStrictEqual({ max: 300, window: 10 });
    });

    it("leaves the rule untouched when a client IP did resolve", () => {
        expect.assertions(1);

        const request = new Request("http://localhost:3000/api/auth/sign-in/email", {
            headers: { "cf-connecting-ip": "203.0.113.1" },
            method: "POST",
        });

        expect(catchAllRule(baseOptions)(request, SIGN_IN_RULE)).toStrictEqual(SIGN_IN_RULE);
    });

    it("is consulted after the caller's own rules, never instead of them", () => {
        expect.assertions(2);

        const resolved = resolveAuthOptions({ ...baseOptions, rateLimit: { customRules: { "/sign-in/email": { max: 1, window: 60 } } } });

        // better-auth takes the FIRST key whose pattern matches the path, so the
        // caller's own rule has to come first in insertion order.
        expect(Object.keys(resolved.rateLimit?.customRules ?? {})).toStrictEqual(["/sign-in/email", "/**"]);
        expect(resolved.rateLimit?.customRules?.["/sign-in/email"]).toStrictEqual({ max: 1, window: 60 });
    });

    it("does not overwrite a caller who declared the same catch-all pattern", () => {
        expect.assertions(1);

        // Key ordering cannot protect this one: same key, so the later spread wins.
        const resolved = resolveAuthOptions({ ...baseOptions, rateLimit: { customRules: { "/**": { max: 7, window: 30 } } } });

        expect(resolved.rateLimit?.customRules?.["/**"]).toStrictEqual({ max: 7, window: 30 });
    });

    it("adds no custom rule when the caller disabled rate limiting", () => {
        expect.assertions(2);

        const resolved = resolveAuthOptions({ ...baseOptions, rateLimit: { enabled: false } });

        expect(resolved.rateLimit?.enabled).toBe(false);
        expect(resolved.rateLimit?.customRules).toBeUndefined();
    });
});
