import { describe, expect, it } from "vitest";

import type { RestCachePolicy } from "../../../shared/rest-surface";
import { applyRestCache, requestCarriesCredentials, restCacheHeaders } from "../src/rest-cache";

const publicCache: RestCachePolicy = { maxAge: 60, scope: "public" };
const get = (init?: RequestInit): Request => new Request("https://app.example/_lunora/rest/messages/list", init);

describe("restCacheHeaders", () => {
    it("emits a shared-cacheable policy for an anonymous request under scope:public", () => {
        expect.assertions(2);

        const headers = restCacheHeaders(publicCache, get(), 200);

        expect(headers?.["cache-control"]).toBe("public, max-age=60");
        // The anonymous variant must be fenced off from credentialed callers, or a
        // shared cache could hand it to a signed-in user in place of their own data.
        // Shard/bookmark headers ride along because they change the body too.
        expect(headers?.vary).toBe("authorization, cf-access-jwt-assertion, cookie, x-d1-bookmark, x-lunora-shard-key");
    });

    it("downgrades scope:public to private when the request carries an Authorization header", () => {
        expect.assertions(1);

        const headers = restCacheHeaders(publicCache, get({ headers: { authorization: "Bearer t" } }), 200); // secret-scanner:allow -- fake test fixture, not a real credential

        expect(headers?.["cache-control"]).toBe("private, max-age=60");
    });

    it("downgrades scope:public to private when the request carries a Cookie", () => {
        expect.assertions(1);

        const headers = restCacheHeaders(publicCache, get({ headers: { cookie: "session=abc" } }), 200);

        expect(headers?.["cache-control"]).toBe("private, max-age=60");
    });

    it("includes stale-while-revalidate and a purge tag when declared", () => {
        expect.assertions(2);

        const headers = restCacheHeaders({ maxAge: 30, scope: "private", staleWhileRevalidate: 120, tag: "messages" }, get(), 200);

        expect(headers?.["cache-control"]).toBe("private, max-age=30, stale-while-revalidate=120");
        expect(headers?.["cache-tag"]).toBe("messages");
    });

    it("merges an author-declared Vary with the credential names, case-insensitively and without duplicates", () => {
        expect.assertions(1);

        const headers = restCacheHeaders({ ...publicCache, vary: "Accept-Language, AUTHORIZATION" }, get(), 200);

        expect(headers?.vary).toBe("accept-language, authorization, cf-access-jwt-assertion, cookie, x-d1-bookmark, x-lunora-shard-key");
    });

    it("still varies a private endpoint on the data-selecting headers", () => {
        expect.assertions(1);

        // `x-lunora-shard-key` picks WHICH rows come back; without it in Vary one
        // URL maps to many bodies even in a per-caller cache.
        expect(restCacheHeaders({ maxAge: 60, scope: "private" }, get(), 200)?.vary).toBe("x-d1-bookmark, x-lunora-shard-key");
    });

    it("downgrades for a Cloudflare Access service token, which sends a header and no cookie", () => {
        expect.assertions(1);

        // `@lunora/cloudflare-access` reads `cf-access-jwt-assertion` BEFORE its
        // cookie, so a machine client is identified by the header alone.
        const headers = restCacheHeaders(publicCache, get({ headers: { "cf-access-jwt-assertion": "jwt" } }), 200);

        expect(headers?.["cache-control"]).toBe("private, max-age=60");
    });

    it("downgrades on an app-declared credential header", () => {
        expect.assertions(2);

        const policy: RestCachePolicy = { ...publicCache, credentialHeaders: ["X-Api-Key"] };

        expect(restCacheHeaders(policy, get({ headers: { "x-api-key": "k" } }), 200)?.["cache-control"]).toBe("private, max-age=60");
        // ...and it joins Vary, so an intermediary keys on it too.
        expect(restCacheHeaders(policy, get(), 200)?.vary).toContain("x-api-key");
    });

    it("refuses to cache a non-GET exchange", () => {
        expect.assertions(1);

        expect(restCacheHeaders(publicCache, get({ method: "POST" }), 200)).toBeUndefined();
    });

    it("refuses to cache a non-2xx response, so an error is never stored as the resource", () => {
        expect.assertions(3);

        expect(restCacheHeaders(publicCache, get(), 403)).toBeUndefined();
        expect(restCacheHeaders(publicCache, get(), 404)).toBeUndefined();
        expect(restCacheHeaders(publicCache, get(), 500)).toBeUndefined();
    });

    it("clamps a negative or non-finite maxAge to 0 rather than emitting a broken directive", () => {
        expect.assertions(2);

        expect(restCacheHeaders({ maxAge: -5, scope: "private" }, get(), 200)?.["cache-control"]).toBe("private, max-age=0");
        expect(restCacheHeaders({ maxAge: Number.NaN, scope: "private" }, get(), 200)?.["cache-control"]).toBe("private, max-age=0");
    });
});

describe("requestCarriesCredentials", () => {
    it("is false only when no identity-bearing header is present", () => {
        expect.assertions(4);

        expect(requestCarriesCredentials(get(), publicCache)).toBe(false);
        expect(requestCarriesCredentials(get({ headers: { authorization: "Bearer t" } }), publicCache)).toBe(true); // secret-scanner:allow -- fake test fixture, not a real credential
        expect(requestCarriesCredentials(get({ headers: { cookie: "a=b" } }), publicCache)).toBe(true);
        expect(requestCarriesCredentials(get({ headers: { "cf-access-jwt-assertion": "jwt" } }), publicCache)).toBe(true);
    });
});

describe("applyRestCache", () => {
    it("returns the original response untouched when no cache is declared", async () => {
        expect.assertions(2);

        const original = Response.json({ ok: true });
        const result = applyRestCache(original, undefined, get());

        expect(result).toBe(original);
        await expect(result.json()).resolves.toEqual({ ok: true });
    });

    it("rebuilds the response with cache headers while preserving status and body", async () => {
        expect.assertions(3);

        const result = applyRestCache(Response.json({ items: [1, 2] }, { status: 200 }), publicCache, get());

        expect(result.status).toBe(200);
        expect(result.headers.get("cache-control")).toBe("public, max-age=60");
        await expect(result.json()).resolves.toEqual({ items: [1, 2] });
    });

    it("merges an existing Vary from the procedure response instead of replacing it", () => {
        expect.assertions(3);

        // A procedure that negotiated on `Accept-Language` must keep that Vary, or a
        // shared cache could hand one language's body to a caller expecting another.
        const original = Response.json({ ok: true }, { headers: { vary: "Accept-Language" } });
        const result = applyRestCache(original, publicCache, get());
        const vary = result.headers.get("vary") ?? "";

        expect(vary).toContain("accept-language");
        expect(vary).toContain("authorization");
        expect(vary).toContain("cookie");
    });

    it("leaves an error response uncached", () => {
        expect.assertions(1);

        const result = applyRestCache(Response.json({ error: "nope" }, { status: 403 }), publicCache, get());

        expect(result.headers.get("cache-control")).toBeNull();
    });
});
