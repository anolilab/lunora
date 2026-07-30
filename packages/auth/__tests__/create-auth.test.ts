import { resolveBaseURL } from "better-auth";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { createAuth, resolveAuthOptions } from "../src/create-auth";
import { DEFAULT_AUTH_BASE_PATH, handleAuthRequest } from "../src/handler";
import { sessionPresets } from "../src/session";

const SECRET_PATTERN = /secret/i;

/**
 * Unit smoke tests for the better-auth wrapper. End-to-end coverage lives in
 * the playground's e2e suite where we have a real D1 (Miniflare) — these
 * tests focus on the wrapper's invariants (secret required, request routing,
 * unrelated paths skipped).
 */
describe("createAuth", () => {
    it("throws when secret is missing", () => {
        expect.assertions(1);
        expect(() => createAuth({ secret: "" })).toThrow(SECRET_PATTERN);
    });

    it("throws when secret is whitespace-only", () => {
        expect.assertions(1);
        expect(() => createAuth({ secret: "   " })).toThrow(SECRET_PATTERN);
    });

    it("the missing-secret error points at AUTH_SECRET / .dev.vars", () => {
        expect.assertions(2);
        expect(() => createAuth({ secret: "" })).toThrow(/AUTH_SECRET/);
        expect(() => createAuth({ secret: "" })).toThrow(/\.dev\.vars/);
    });

    it("returns an instance with handler + api + options", () => {
        expect.assertions(2);

        const auth = createAuth({
            emailAndPassword: { enabled: true },
            secret: "s".repeat(32),
        });

        expectTypeOf(auth.handler).toBeFunction();

        expect(auth.api).toBeDefined();
        expect(auth.options.secret).toBe("s".repeat(32));
    });

    it("forwards a configured session policy to the underlying betterAuth options", () => {
        expect.assertions(3);

        const auth = createAuth({
            secret: "s".repeat(32),
            session: {
                disableSessionRefresh: false,
                expiresIn: 60 * 60 * 24 * 3,
                freshAge: 60 * 5,
                updateAge: 60 * 30,
            },
        });

        expect(auth.options.session?.expiresIn).toBe(60 * 60 * 24 * 3);
        expect(auth.options.session?.updateAge).toBe(60 * 30);
        expect(auth.options.session?.freshAge).toBe(60 * 5);
    });

    it("forwards a session preset to the underlying betterAuth options", () => {
        expect.assertions(2);

        const auth = createAuth({
            secret: "s".repeat(32),
            session: sessionPresets.strict,
        });

        expect(auth.options.session?.expiresIn).toBe(sessionPresets.strict.expiresIn);
        expect(auth.options.session?.updateAge).toBe(sessionPresets.strict.updateAge);
    });

    it("defaults a short-lived session cookie cache when the caller is silent", () => {
        expect.assertions(2);

        const auth = createAuth({ secret: "s".repeat(32) });

        expect(auth.options.session?.cookieCache?.enabled).toBe(true);
        expect(auth.options.session?.cookieCache?.maxAge).toBe(60);
    });

    it("forwards a caller-disabled cookie cache verbatim (does not re-enable it)", () => {
        expect.assertions(1);

        const auth = createAuth({
            secret: "s".repeat(32),
            session: { cookieCache: { enabled: false } },
        });

        expect(auth.options.session?.cookieCache?.enabled).toBe(false);
    });

    it("fills the cookie-cache default alongside a caller session that omits it", () => {
        expect.assertions(3);

        const auth = createAuth({
            secret: "s".repeat(32),
            session: { expiresIn: 60 * 60 * 24 * 3 },
        });

        expect(auth.options.session?.expiresIn).toBe(60 * 60 * 24 * 3);
        expect(auth.options.session?.cookieCache?.enabled).toBe(true);
        expect(auth.options.session?.cookieCache?.maxAge).toBe(60);
    });

    it("rejects a negative session duration", () => {
        expect.assertions(1);

        expect(() => createAuth({ secret: "s".repeat(32), session: { expiresIn: -1 } })).toThrow(/non-negative/i);
    });

    it("rejects a non-finite session duration", () => {
        expect.assertions(1);

        expect(() => createAuth({ secret: "s".repeat(32), session: { updateAge: Number.POSITIVE_INFINITY } })).toThrow(/finite/i);
    });
});

describe("createAuth — durable rate-limit default", () => {
    it("defaults rate limiting on and storage to database when the caller is silent", () => {
        expect.assertions(2);

        const auth = createAuth({ secret: "s".repeat(32) });

        expect(auth.options.rateLimit?.enabled).toBe(true);
        expect(auth.options.rateLimit?.storage).toBe("database");
    });

    it("forwards a caller-supplied rateLimit.storage verbatim", () => {
        expect.assertions(2);

        const auth = createAuth({
            rateLimit: { storage: "secondary-storage" },
            secret: "s".repeat(32),
        });

        expect(auth.options.rateLimit?.storage).toBe("secondary-storage");
        // The `enabled` default still fills alongside the caller's storage choice.
        expect(auth.options.rateLimit?.enabled).toBe(true);
    });

    it("does not re-enable rate limiting a caller explicitly disabled, and fills no storage", () => {
        expect.assertions(2);

        const auth = createAuth({
            rateLimit: { enabled: false },
            secret: "s".repeat(32),
        });

        expect(auth.options.rateLimit?.enabled).toBe(false);
        // No `storage` fill under a disabled limiter — else `getAuthTables` emits
        // an unused `rateLimit` table.
        expect(auth.options.rateLimit?.storage).toBeUndefined();
    });
});

describe("resolveAuthOptions", () => {
    it("fills the rate-limit and cookie-cache defaults when the caller is silent", () => {
        expect.assertions(4);

        const resolved = resolveAuthOptions({ secret: "s".repeat(32) });

        expect(resolved.rateLimit?.enabled).toBe(true);
        expect(resolved.rateLimit?.storage).toBe("database");
        expect(resolved.session?.cookieCache?.enabled).toBe(true);
        expect(resolved.session?.cookieCache?.maxAge).toBe(60);
    });

    it("forwards explicit caller values verbatim instead of filling defaults", () => {
        expect.assertions(3);

        const resolved = resolveAuthOptions({
            rateLimit: { enabled: true, storage: "secondary-storage" },
            secret: "s".repeat(32),
            session: { cookieCache: { enabled: false } },
        });

        expect(resolved.rateLimit?.storage).toBe("secondary-storage");
        expect(resolved.rateLimit?.enabled).toBe(true);
        expect(resolved.session?.cookieCache?.enabled).toBe(false);
    });

    it("does not fill storage when the caller disabled rate limiting", () => {
        expect.assertions(2);

        const resolved = resolveAuthOptions({ rateLimit: { enabled: false }, secret: "s".repeat(32) });

        expect(resolved.rateLimit?.enabled).toBe(false);
        expect(resolved.rateLimit?.storage).toBeUndefined();
    });
});

describe("createAuth — secure-by-default hardening", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("hardens session cookies (httpOnly, sameSite lax, path) by default", () => {
        expect.assertions(3);

        const auth = createAuth({ secret: "s".repeat(32) });

        expect(auth.options.advanced?.defaultCookieAttributes?.httpOnly).toBe(true);
        expect(auth.options.advanced?.defaultCookieAttributes?.sameSite).toBe("lax");
        expect(auth.options.advanced?.defaultCookieAttributes?.path).toBe("/");
    });

    it("does not override caller-provided cookie attributes", () => {
        expect.assertions(1);

        const auth = createAuth({
            advanced: { defaultCookieAttributes: { sameSite: "strict" } },
            secret: "s".repeat(32),
        });

        expect(auth.options.advanced?.defaultCookieAttributes?.sameSite).toBe("strict");
    });

    it("forces useSecureCookies on for an https baseURL", () => {
        expect.assertions(1);

        const auth = createAuth({ baseURL: "https://app.example.com", secret: "s".repeat(32) });

        expect(auth.options.advanced?.useSecureCookies).toBe(true);
    });

    it("disables useSecureCookies for an explicit http (dev) baseURL", () => {
        expect.assertions(1);

        const auth = createAuth({ baseURL: "http://localhost:8787", secret: "s".repeat(32) });

        expect(auth.options.advanced?.useSecureCookies).toBe(false);
    });

    it("treats the scheme case-insensitively (HTTP:// is still plain http)", () => {
        expect.assertions(1);

        const auth = createAuth({ baseURL: "HTTP://localhost:8787", secret: "s".repeat(32) });

        expect(auth.options.advanced?.useSecureCookies).toBe(false);
    });

    it("defaults useSecureCookies on when baseURL is unset (Workers serve HTTPS in prod)", () => {
        expect.assertions(1);

        const auth = createAuth({ secret: "s".repeat(32) });

        expect(auth.options.advanced?.useSecureCookies).toBe(true);
    });

    it("honours an explicit useSecureCookies even on https", () => {
        expect.assertions(1);

        const auth = createAuth({
            advanced: { useSecureCookies: false },
            baseURL: "https://app.example.com",
            secret: "s".repeat(32),
        });

        expect(auth.options.advanced?.useSecureCookies).toBe(false);
    });

    it("warns (does not throw) for a weak AUTH_SECRET on an explicit http:// dev baseURL", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        createAuth({ baseURL: "http://localhost:8787", secret: "short-secret" });

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toMatch(/AUTH_SECRET/);
    });

    it("throws for a weak AUTH_SECRET when baseURL is unset (Workers serve HTTPS in prod)", () => {
        expect.assertions(1);

        expect(() => createAuth({ secret: "short-secret" })).toThrow(/AUTH_SECRET/);
    });

    it("throws for a weak AUTH_SECRET on an https baseURL", () => {
        expect.assertions(1);

        expect(() => createAuth({ baseURL: "https://app.example.com", secret: "short-secret" })).toThrow(/AUTH_SECRET/);
    });

    it("does not warn for a 32+ character secret", () => {
        expect.assertions(1);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        createAuth({ secret: "s".repeat(32) });

        expect(warn).not.toHaveBeenCalled();
    });
});

describe("createAuth — port-agnostic local baseURL", () => {
    const secret = "s".repeat(32);

    it("resolves the origin from the request when the dev server moved to another port", () => {
        expect.assertions(1);

        // The regression this guards: `.dev.vars` pins :5173, Vite falls back to
        // :5174 because something else holds :5173, and every callback/cookie is
        // minted against an origin the browser is never on.
        const { baseURL } = resolveAuthOptions({ baseURL: "http://localhost:5173", secret });

        expect(resolveBaseURL(baseURL, "/api/auth", new Request("http://localhost:5174/api/auth/ok"))).toBe("http://localhost:5174/api/auth");
    });

    it("falls back to the configured origin when the request carries no host", () => {
        expect.assertions(1);

        const { baseURL } = resolveAuthOptions({ baseURL: "http://localhost:5173", secret });

        expect(resolveBaseURL(baseURL, "/api/auth")).toBe("http://localhost:5173/api/auth");
    });

    it("refuses a foreign host, so a spoofed Host header cannot become the base URL", () => {
        expect.assertions(1);

        const { baseURL } = resolveAuthOptions({ baseURL: "http://localhost:5173", secret });

        // Not in `allowedHosts` → falls back to the configured origin rather than
        // minting reset/callback links pointing at the attacker.
        expect(resolveBaseURL(baseURL, "/api/auth", new Request("http://evil.example.com/api/auth/ok"))).toBe("http://localhost:5173/api/auth");
    });

    it("leaves a deployed https baseURL as an untouched string", () => {
        expect.assertions(1);

        expect(resolveAuthOptions({ baseURL: "https://app.example.com", secret }).baseURL).toBe("https://app.example.com");
    });

    it("leaves a non-loopback http baseURL alone", () => {
        expect.assertions(1);

        expect(resolveAuthOptions({ baseURL: "http://staging.example.com", secret }).baseURL).toBe("http://staging.example.com");
    });

    it("keeps useSecureCookies off for the rewritten local origin", () => {
        expect.assertions(1);

        const auth = createAuth({ baseURL: "http://localhost:5173", secret });

        expect(auth.options.advanced?.useSecureCookies).toBe(false);
    });

    it("trusts the derived origin so better-auth's own CSRF check accepts it", async () => {
        expect.assertions(1);

        const auth = createAuth({ baseURL: "http://localhost:5173", secret });
        const context = await auth.$context;

        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- asserting the exact loopback dev origin better-auth derives; there is no https equivalent to assert here
        expect(context.trustedOrigins).toContain("http://localhost:*");
    });
});

describe("handleAuthRequest", () => {
    const auth = createAuth({
        emailAndPassword: { enabled: true },
        secret: "s".repeat(32),
    });

    it("returns undefined for paths outside the auth base path", async () => {
        expect.assertions(1);

        const response = await handleAuthRequest(auth, new Request("https://app.test/api/other/thing"));

        expect(response).toBeUndefined();
    });

    it("returns undefined for the runtime's RPC path", async () => {
        expect.assertions(1);

        const response = await handleAuthRequest(auth, new Request("https://app.test/_lunora/rpc"));

        expect(response).toBeUndefined();
    });

    it("delegates to auth.handler for /api/auth/* paths", async () => {
        expect.assertions(1);

        // Better-auth returns a real Response even when the underlying op
        // fails (e.g. no DB) — we just need to assert we *got* a Response,
        // proving routing dispatched.
        const response = await handleAuthRequest(auth, new Request("https://app.test/api/auth/get-session"));

        expect(response).toBeInstanceOf(Response);
    });

    it("honours a custom basePath", async () => {
        expect.assertions(1);

        const response = await handleAuthRequest(auth, new Request("https://app.test/auth/get-session"), "/auth");

        expect(response).toBeInstanceOf(Response);
    });

    it("dispatches on the exact basePath (no trailing segment)", async () => {
        expect.assertions(1);

        const response = await handleAuthRequest(auth, new Request("https://app.test/api/auth"));

        expect(response).toBeInstanceOf(Response);
    });

    it("does not capture sibling routes sharing the basePath prefix", async () => {
        expect.assertions(1);

        // "/api/authzzz" shares the "/api/auth" prefix but is a different route
        // — the `${base}/` segment-boundary guard must reject it. Pins the
        // behaviour so a refactor to a looser `startsWith(basePath)` can't
        // silently swallow sibling routes.
        const response = await handleAuthRequest(auth, new Request("https://app.test/api/authzzz"));

        expect(response).toBeUndefined();
    });

    it("normalizes a trailing-slash basePath so nested routes still match", async () => {
        expect.assertions(2);

        // A caller passing a trailing-slash basePath ("/auth/") must still
        // route both the exact path and nested paths instead of 404ing.
        const nested = await handleAuthRequest(auth, new Request("https://app.test/auth/get-session"), "/auth/");
        const exact = await handleAuthRequest(auth, new Request("https://app.test/auth"), "/auth/");

        expect(nested).toBeInstanceOf(Response);
        expect(exact).toBeInstanceOf(Response);
    });

    it("dEFAULT_AUTH_BASE_PATH is /api/auth", () => {
        expect.assertions(1);
        expect(DEFAULT_AUTH_BASE_PATH).toBe("/api/auth");
    });
});
