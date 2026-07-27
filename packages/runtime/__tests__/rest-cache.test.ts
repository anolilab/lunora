import { describe, expect, it } from "vitest";

import type { RestCacheConfigLike } from "../src/rest-cache";
import { applyRestCache, mergeVary, requestCarriesCredentials, restCacheHeaders } from "../src/rest-cache";

const publicCache: RestCacheConfigLike = { maxAge: 60, scope: "public" };
const get = (init?: RequestInit): Request => new Request("https://app.example/_lunora/rest/messages/list", init);

describe("restCacheHeaders", () => {
    it("emits a shared-cacheable policy for an anonymous request under scope:public", () => {
        expect.assertions(2);

        const headers = restCacheHeaders(publicCache, get(), 200);

        expect(headers?.["cache-control"]).toBe("public, max-age=60");
        // The anonymous variant must be fenced off from credentialed callers, or a
        // shared cache could hand it to a signed-in user in place of their own data.
        expect(headers?.vary).toBe("authorization, cookie");
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

        expect(headers?.vary).toBe("accept-language, authorization, cookie");
    });

    it("omits Vary entirely for a private endpoint that declares none", () => {
        expect.assertions(1);

        const headers = restCacheHeaders({ maxAge: 60, scope: "private" }, get(), 200);

        expect(headers?.vary).toBeUndefined();
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
    it("is false only when neither Authorization nor Cookie is present", () => {
        expect.assertions(3);

        expect(requestCarriesCredentials(get())).toBe(false);
        expect(requestCarriesCredentials(get({ headers: { authorization: "Bearer t" } }))).toBe(true); // secret-scanner:allow -- fake test fixture, not a real credential
        expect(requestCarriesCredentials(get({ headers: { cookie: "a=b" } }))).toBe(true);
    });
});

describe("mergeVary", () => {
    it("returns undefined when every source is empty", () => {
        expect.assertions(1);

        expect(mergeVary(undefined, "", "  ,  ")).toBeUndefined();
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

    it("leaves an error response uncached", () => {
        expect.assertions(1);

        const result = applyRestCache(Response.json({ error: "nope" }, { status: 403 }), publicCache, get());

        expect(result.headers.get("cache-control")).toBeNull();
    });
});
