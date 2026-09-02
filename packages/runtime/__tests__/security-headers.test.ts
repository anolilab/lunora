import { describe, expect, it, vi } from "vitest";

import { decorateResponse, enforceOrigin, handleCorsPreflight, resolveSecurity } from "../src/security-headers";

const httpsRequest = (init: { headers?: Record<string, string>; method?: string; url?: string } = {}): Request =>
    new Request(init.url ?? "https://api.example.com/_lunora/rpc", { method: init.method ?? "GET", headers: init.headers });

describe("resolveSecurity", () => {
    it("defaults every layer on", () => {
        expect.hasAssertions();

        const resolved = resolveSecurity(undefined);

        expect(resolved.headers.enabled).toBe(true);
        expect(resolved.csrf.enabled).toBe(true);
        expect(resolved.cors.enabled).toBe(false); // CORS is deny-by-default until an allowlist is supplied
    });

    it("throws on a wildcard CORS origin with credentials", () => {
        expect.hasAssertions();

        expect(() => resolveSecurity({ cors: { allowedOrigins: ["*"], allowCredentials: true } })).toThrow(/wildcard/i);
    });

    it("warns for a custom allowedOrigins predicate, with or without credentials", () => {
        expect.assertions(3);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        // The predicate feeds the CSRF/WS origin trust even without credentials.
        resolveSecurity({ cors: { allowedOrigins: () => true } });

        expect(warn).toHaveBeenCalledWith(expect.stringContaining("predicate"));

        warn.mockClear();
        resolveSecurity({ cors: { allowCredentials: true, allowedOrigins: () => true } });

        expect(warn).toHaveBeenCalledWith(expect.stringContaining("allowCredentials"));
        expect(warn).toHaveBeenCalledTimes(1);

        warn.mockRestore();
    });

    it("denies an origin when the custom predicate returns a truthy non-boolean", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        // The predicate is consumed truthily at three security decision points —
        // preflight, header reflection, and the CSRF trusted-origin check — so it is
        // narrowed once at resolve time. `indexOf` is the classic slip: it returns
        // `-1` for "not found", which is TRUTHY and would have allowed every origin.
        const resolved = resolveSecurity({
            cors: { allowedOrigins: (origin) => ["https://app.example"].indexOf(origin) as unknown as boolean },
        });

        expect(resolved.cors.isAllowed("https://evil.example")).toBe(false);
        expect(resolved.cors.isExplicitlyAllowed("https://evil.example")).toBe(false);

        warn.mockRestore();
    });

    it("allows a wildcard origin without credentials", () => {
        expect.hasAssertions();

        expect(() => resolveSecurity({ cors: { allowedOrigins: ["*"] } })).not.toThrow();
    });

    it("honors the LUNORA_SECURITY_HEADERS / LUNORA_SECURITY_CSRF env opt-outs", () => {
        expect.hasAssertions();

        const resolved = resolveSecurity(undefined, { LUNORA_SECURITY_CSRF: "off", LUNORA_SECURITY_HEADERS: "false" });

        expect(resolved.headers.enabled).toBe(false);
        expect(resolved.csrf.enabled).toBe(false);
    });

    it("lets explicit code config override the env opt-out", () => {
        expect.hasAssertions();

        const resolved = resolveSecurity({ csrf: true, headers: true }, { LUNORA_SECURITY_CSRF: "off", LUNORA_SECURITY_HEADERS: "off" });

        expect(resolved.headers.enabled).toBe(true);
        expect(resolved.csrf.enabled).toBe(true);
    });

    it("ignores non-disable env values", () => {
        expect.hasAssertions();

        const resolved = resolveSecurity(undefined, { LUNORA_SECURITY_CSRF: "on", LUNORA_SECURITY_HEADERS: "1" });

        expect(resolved.headers.enabled).toBe(true);
        expect(resolved.csrf.enabled).toBe(true);
    });

    it("configures CORS from LUNORA_ALLOWED_ORIGINS when code config is absent", () => {
        expect.hasAssertions();

        const resolved = resolveSecurity(undefined, {
            LUNORA_ALLOWED_ORIGINS: "https://app.example.com, https://admin.example.com",
            LUNORA_CORS_ALLOW_CREDENTIALS: "true",
        });

        expect(resolved.cors.enabled).toBe(true);
        expect(resolved.cors.allowCredentials).toBe(true);
        expect(resolved.cors.isAllowed("https://app.example.com")).toBe(true);
        expect(resolved.cors.isAllowed("https://admin.example.com")).toBe(true);
        expect(resolved.cors.isAllowed("https://evil.example.com")).toBe(false);
    });

    it("sanitizes an env wildcard+credentials to wildcard-without-credentials instead of throwing", () => {
        expect.hasAssertions();

        const resolved = resolveSecurity(undefined, {
            LUNORA_ALLOWED_ORIGINS: "*",
            LUNORA_CORS_ALLOW_CREDENTIALS: "true",
        });

        expect(resolved.cors.enabled).toBe(true);
        expect(resolved.cors.allowCredentials).toBe(false); // credentials dropped, not thrown
        expect(resolved.cors.isAllowed("https://anything.example.com")).toBe(true);
    });

    it("leaves CORS deny-by-default when no env allowlist is set", () => {
        expect.hasAssertions();

        expect(resolveSecurity(undefined, { LUNORA_CORS_ALLOW_CREDENTIALS: "true" }).cors.enabled).toBe(false);
        expect(resolveSecurity(undefined, { LUNORA_ALLOWED_ORIGINS: "   ,  " }).cors.enabled).toBe(false);
    });

    it("lets explicit code CORS config override the env allowlist", () => {
        expect.hasAssertions();

        const resolved = resolveSecurity({ cors: { allowedOrigins: ["https://code.example.com"] } }, { LUNORA_ALLOWED_ORIGINS: "https://env.example.com" });

        expect(resolved.cors.isAllowed("https://code.example.com")).toBe(true);
        expect(resolved.cors.isAllowed("https://env.example.com")).toBe(false);
    });
});

describe("decorateResponse", () => {
    const resolved = resolveSecurity(undefined);

    it("adds baseline security headers", () => {
        expect.hasAssertions();

        const out = decorateResponse(Response.json({ ok: true }), httpsRequest(), resolved);

        expect(out.headers.get("x-content-type-options")).toBe("nosniff");
        expect(out.headers.get("x-frame-options")).toBe("SAMEORIGIN");
        expect(out.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
        expect(out.headers.get("permissions-policy")).toContain("camera=()");
        expect(out.headers.get("cross-origin-opener-policy")).toBe("same-origin");
        expect(out.headers.get("strict-transport-security")).toContain("max-age=31536000");
        expect(out.headers.get("content-security-policy")).toContain("default-src 'none'");
    });

    it("omits HSTS over plain HTTP (so localhost dev is never pinned to HTTPS)", () => {
        expect.hasAssertions();

        const out = decorateResponse(Response.json({ ok: true }), httpsRequest({ url: "http://localhost:8787/_lunora/rpc" }), resolved);

        expect(out.headers.get("strict-transport-security")).toBeNull();
        expect(out.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("never clobbers a header the inner handler already set", () => {
        expect.hasAssertions();

        const inner = new Response("x", { headers: { "x-frame-options": "DENY", "content-security-policy": "default-src 'self'" } });
        const out = decorateResponse(inner, httpsRequest(), resolved);

        expect(out.headers.get("x-frame-options")).toBe("DENY");
        expect(out.headers.get("content-security-policy")).toBe("default-src 'self'");
    });

    it("applies the conservative default CSP for HTML responses (no default-src) and keeps the other headers", () => {
        expect.hasAssertions();

        const html = new Response("<html></html>", { headers: { "content-type": "text/html; charset=utf-8" } });
        const out = decorateResponse(html, httpsRequest(), resolved);

        const csp = out.headers.get("content-security-policy");

        // Conservative HTML hardening; frame-ancestors mirrors the default SAMEORIGIN frameOptions.
        expect(csp).toContain("base-uri 'none'");
        expect(csp).toContain("object-src 'none'");
        expect(csp).toContain("frame-ancestors 'self'");
        expect(csp).not.toContain("default-src");
        expect(out.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("derives the HTML CSP frame-ancestors from frameOptions (DENY → 'none', disabled → omitted)", () => {
        expect.hasAssertions();

        const deny = resolveSecurity({ headers: { frameOptions: "DENY" } });
        const denyCsp = decorateResponse(new Response("<html></html>", { headers: { "content-type": "text/html" } }), httpsRequest(), deny).headers.get(
            "content-security-policy",
        );

        // Must NOT weaken X-Frame-Options: DENY with a looser 'self'.
        expect(denyCsp).toContain("frame-ancestors 'none'");
        expect(denyCsp).not.toContain("frame-ancestors 'self'");

        const noFraming = resolveSecurity({ headers: { frameOptions: false } });
        const noFramingCsp = decorateResponse(
            new Response("<html></html>", { headers: { "content-type": "text/html" } }),
            httpsRequest(),
            noFraming,
        ).headers.get("content-security-policy");

        // Framing disabled → no frame-ancestors directive (framing left unrestricted), base hardening stays.
        expect(noFramingCsp).not.toContain("frame-ancestors");
        expect(noFramingCsp).toContain("base-uri 'none'");
    });

    it("applies an explicit CSP string to HTML too", () => {
        expect.hasAssertions();

        const custom = resolveSecurity({ headers: { csp: "default-src 'self'" } });
        const html = new Response("<html></html>", { headers: { "content-type": "text/html" } });
        const out = decorateResponse(html, httpsRequest(), custom);

        expect(out.headers.get("content-security-policy")).toBe("default-src 'self'");
    });

    it("adds nothing when headers are disabled", () => {
        expect.hasAssertions();

        const off = resolveSecurity({ headers: false });
        const out = decorateResponse(Response.json({ ok: true }), httpsRequest(), off);

        expect(out.headers.get("x-content-type-options")).toBeNull();
        expect(out.headers.get("strict-transport-security")).toBeNull();
    });

    it("leaves websocket upgrade responses untouched", () => {
        // workerd surfaces an upgrade as a Response carrying a `webSocket`; Node's
        // undici forbids constructing a 101 status, so emulate the shape here.
        expect.hasAssertions();

        const upgrade = { headers: new Headers(), status: 200, webSocket: {} } as unknown as Response;
        const out = decorateResponse(upgrade, httpsRequest(), resolved);

        expect(out).toBe(upgrade);
        expect(out.headers.get("x-content-type-options")).toBeNull();
    });

    it("echoes CORS headers only for an allowed origin", () => {
        expect.hasAssertions();

        const cors = resolveSecurity({ cors: { allowedOrigins: ["https://app.example.com"], allowCredentials: true } });
        const allowed = decorateResponse(Response.json({}), httpsRequest({ headers: { origin: "https://app.example.com" } }), cors);
        const denied = decorateResponse(Response.json({}), httpsRequest({ headers: { origin: "https://evil.example.com" } }), cors);

        expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
        expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");
        expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    });
});

describe("handleCorsPreflight", () => {
    const cors = resolveSecurity({ cors: { allowedOrigins: ["https://app.example.com"] } });

    it("answers an allowed preflight with 204 and allow-* headers", () => {
        expect.hasAssertions();

        const response = handleCorsPreflight(
            httpsRequest({ method: "OPTIONS", headers: { origin: "https://app.example.com", "access-control-request-method": "POST" } }),
            cors,
        );

        expect(response?.status).toBe(204);
        expect(response?.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
        expect(response?.headers.get("access-control-allow-methods")).toContain("POST");
    });

    it("ignores a preflight from a disallowed origin", () => {
        expect.hasAssertions();

        const response = handleCorsPreflight(
            httpsRequest({ method: "OPTIONS", headers: { origin: "https://evil.example.com", "access-control-request-method": "POST" } }),
            cors,
        );

        expect(response).toBeUndefined();
    });

    it("enforces the configured allowedHeaders instead of echoing the requested list", () => {
        expect.hasAssertions();

        const restricted = resolveSecurity({ cors: { allowedOrigins: ["https://app.example.com"], allowedHeaders: ["Content-Type"] } });

        const response = handleCorsPreflight(
            httpsRequest({
                method: "OPTIONS",
                headers: {
                    origin: "https://app.example.com",
                    "access-control-request-method": "POST",
                    "access-control-request-headers": "content-type, x-evil",
                },
            }),
            restricted,
        );

        const allowHeaders = response?.headers.get("access-control-allow-headers") ?? "";

        expect(allowHeaders.toLowerCase()).toContain("content-type");
        expect(allowHeaders.toLowerCase()).not.toContain("x-evil");
    });

    it("exposes the response headers the SDK reads back", () => {
        expect.hasAssertions();

        // A browser hides every non-safelisted response header unless it is
        // named here, and `headers.get(...)` then returns `null` with no error
        // anywhere. So a header the client consumes but that is unexposed does
        // not fail loudly — it silently drops the guarantee it carries:
        // `x-d1-bookmark` is D1 read-your-writes, `x-lunora-shard-key` is what
        // keys the replica bookmark.
        const out = decorateResponse(
            Response.json({ ok: true }),
            httpsRequest({ headers: { origin: "https://app.example.com" } }),
            resolveSecurity({ cors: { allowedOrigins: ["https://app.example.com"] } }),
        );

        const exposed = (out.headers.get("access-control-expose-headers") ?? "").toLowerCase();

        expect(exposed).toContain("x-d1-bookmark");
        expect(exposed).toContain("x-lunora-shard-key");
        // The REST edge-cache hit indicator: documented as readable, so a browser
        // client has to actually be able to read it.
        expect(exposed).toContain("x-lunora-edge-cache");
    });

    it("ignores non-preflight OPTIONS and disabled CORS", () => {
        expect.hasAssertions();

        expect(handleCorsPreflight(httpsRequest({ method: "OPTIONS" }), cors)).toBeUndefined();
        expect(
            handleCorsPreflight(
                httpsRequest({ method: "OPTIONS", headers: { origin: "https://app.example.com", "access-control-request-method": "POST" } }),
                resolveSecurity({ cors: false }),
            ),
        ).toBeUndefined();
    });
});

describe("enforceOrigin", () => {
    const resolved = resolveSecurity(undefined);

    it("rejects an unsafe cross-origin cookie request", () => {
        expect.hasAssertions();

        const blocked = enforceOrigin(httpsRequest({ method: "POST", headers: { cookie: "session=1", origin: "https://evil.example.com" } }), resolved);

        expect(blocked?.status).toBe(403);
    });

    it("allows a same-origin cookie request", () => {
        expect.hasAssertions();

        const ok = enforceOrigin(httpsRequest({ method: "POST", headers: { cookie: "session=1", origin: "https://api.example.com" } }), resolved);

        expect(ok).toBeUndefined();
    });

    it("allows a trusted cross-origin request", () => {
        expect.hasAssertions();

        const trusted = resolveSecurity({ csrf: { trustedOrigins: ["https://app.example.com"] } });
        const ok = enforceOrigin(httpsRequest({ method: "POST", headers: { cookie: "session=1", origin: "https://app.example.com" } }), trusted);

        expect(ok).toBeUndefined();
    });

    it("names the received and expected origin plus the knob in the 403 body", async () => {
        expect.assertions(4);

        const blocked = enforceOrigin(httpsRequest({ method: "POST", headers: { cookie: "session=1", origin: "https://evil.example.com" } }), resolved);
        const body = (await blocked?.json()) as { error: { expectedOrigin: string; message: string; receivedOrigin: string } };

        // "cross-origin request rejected" alone sends the reader hunting. The body has
        // to say which origin arrived, which one the worker serves, and the fix.
        expect(body.error.receivedOrigin).toBe("https://evil.example.com");
        expect(body.error.expectedOrigin).toBe("https://api.example.com");
        expect(body.error.message).toContain("security.csrf.trustedOrigins");
        expect(body.error.message).toContain("dev proxy");
    });

    it("exempts safe methods, bearer/no-cookie requests, and disabled csrf", () => {
        expect.hasAssertions();

        expect(enforceOrigin(httpsRequest({ method: "GET", headers: { cookie: "s=1", origin: "https://evil.example.com" } }), resolved)).toBeUndefined();
        expect(
            enforceOrigin(httpsRequest({ method: "POST", headers: { authorization: "Bearer x", origin: "https://evil.example.com" } }), resolved),
        ).toBeUndefined();
        expect(
            enforceOrigin(httpsRequest({ method: "POST", headers: { cookie: "s=1", origin: "https://evil.example.com" } }), resolveSecurity({ csrf: false })),
        ).toBeUndefined();
    });

    it("blocks an unsafe cookie request with no Origin or Referer", () => {
        expect.hasAssertions();

        const blocked = enforceOrigin(httpsRequest({ method: "POST", headers: { cookie: "session=1" } }), resolved);

        expect(blocked?.status).toBe(403);
    });

    it("does NOT treat a wildcard CORS allowlist as CSRF-trusted", () => {
        expect.hasAssertions();

        // A `*` CORS allowlist means "any origin may read my non-credentialed
        // responses" — it must NOT confer CSRF trust for state-changing requests.
        const wildcard = resolveSecurity({ cors: { allowedOrigins: ["*"] } });
        const blocked = enforceOrigin(httpsRequest({ method: "POST", headers: { cookie: "session=1", origin: "https://evil.example.com" } }), wildcard);

        expect(blocked?.status).toBe(403);
    });

    it("trusts an explicit (non-wildcard) CORS origin for CSRF", () => {
        expect.hasAssertions();

        const explicit = resolveSecurity({ cors: { allowedOrigins: ["https://partner.example.com"] } });
        const ok = enforceOrigin(httpsRequest({ method: "POST", headers: { cookie: "session=1", origin: "https://partner.example.com" } }), explicit);

        expect(ok).toBeUndefined();
    });
});

/**
 * The dev-proxy shape: the browser loads the app from the dev server (`:3000`),
 * which proxies to wrangler (`:8787`). With `changeOrigin` the two ports differ, so
 * a strict same-origin rule rejects the cookie-bearing WS upgrade and the app hangs
 * on its loading state with no diagnosis.
 */
/* eslint-disable sonarjs/no-clear-text-protocols -- plain-http loopback URLs ARE the subject under test; the exemption only applies to them */
describe("enforceOrigin — loopback dev exemption", () => {
    const localRequest = (headers: Record<string, string>): Request => new Request("http://localhost:8787/_lunora/rpc", { headers, method: "POST" });

    it("trusts a loopback origin when the worker itself serves on loopback", () => {
        expect.assertions(3);

        const resolved = resolveSecurity(undefined);

        expect(enforceOrigin(localRequest({ cookie: "s=1", origin: "http://localhost:3000" }), resolved)).toBeUndefined();
        expect(enforceOrigin(localRequest({ cookie: "s=1", origin: "http://127.0.0.1:5173" }), resolved)).toBeUndefined();
        expect(enforceOrigin(localRequest({ cookie: "s=1", origin: "http://[::1]:3210" }), resolved)).toBeUndefined();
    });

    it("does NOT loosen a deployed worker — the exemption needs a loopback self origin", () => {
        expect.assertions(1);

        const resolved = resolveSecurity(undefined);
        const blocked = enforceOrigin(httpsRequest({ method: "POST", headers: { cookie: "s=1", origin: "http://localhost:3000" } }), resolved);

        expect(blocked?.status).toBe(403);
    });

    it("rejects a non-loopback origin even when the worker is local", () => {
        expect.assertions(1);

        const resolved = resolveSecurity(undefined);
        const blocked = enforceOrigin(localRequest({ cookie: "s=1", origin: "https://evil.example.com" }), resolved);

        expect(blocked?.status).toBe(403);
    });

    it("rejects a public *.localhost hostname that only looks local", () => {
        expect.assertions(1);

        // `evil.localhost` can be pointed at by public DNS — only the three canonical
        // loopback spellings count.
        const resolved = resolveSecurity(undefined);
        const blocked = enforceOrigin(localRequest({ cookie: "s=1", origin: "http://evil.localhost" }), resolved);

        expect(blocked?.status).toBe(403);
    });

    it("honors allowLoopback: false for a hardened local setup", () => {
        expect.assertions(1);

        const resolved = resolveSecurity({ csrf: { allowLoopback: false } });
        const blocked = enforceOrigin(localRequest({ cookie: "s=1", origin: "http://localhost:3000" }), resolved);

        expect(blocked?.status).toBe(403);
    });
});
