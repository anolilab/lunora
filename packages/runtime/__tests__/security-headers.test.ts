import { describe, expect, it } from "vitest";

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

    it("skips the default CSP for HTML responses but keeps the other headers", () => {
        expect.hasAssertions();

        const html = new Response("<html></html>", { headers: { "content-type": "text/html; charset=utf-8" } });
        const out = decorateResponse(html, httpsRequest(), resolved);

        expect(out.headers.get("content-security-policy")).toBeNull();
        expect(out.headers.get("x-content-type-options")).toBe("nosniff");
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
});
