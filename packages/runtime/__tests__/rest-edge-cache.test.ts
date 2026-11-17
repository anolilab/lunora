import type { HttpCacheLike } from "@lunora/platform";
import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike } from "../../../shared/execution-context";
import type { RestCachePolicy } from "../../../shared/rest-surface";
import { applyRestCache } from "../src/rest-cache";
import { EDGE_CACHE_HEADER, KEY_SCOPE_PARAM, restEdgeCacheFor } from "../src/rest-edge-cache";
import { contextWith, fakeCache } from "./helpers/edge-cache";

const publicCache: RestCachePolicy = { maxAge: 60, scope: "public" };

const get = (init: { headers?: Record<string, string>; method?: string; url?: string } = {}): Request =>
    new Request(init.url ?? "https://api.example.com/_lunora/rest/messages/list", { headers: init.headers, method: init.method ?? "GET" });

/** The URL a stored entry landed under — the cache key, observed through the double. */
const onlyKey = (entries: Map<string, Response>): string => [...entries.keys()][0] ?? "";

describe("restEdgeCacheFor", () => {
    it("is undefined for a route that can never use a shared cache", () => {
        expect.assertions(4);

        const { cache } = fakeCache();

        // No declared policy at all.
        expect(restEdgeCacheFor(undefined, cache)).toBeUndefined();
        // The explicit opt-out.
        expect(restEdgeCacheFor(publicCache, null)).toBeUndefined();
        // A declared-private policy: the browser may keep it, a shared cache must not.
        expect(restEdgeCacheFor({ maxAge: 60, scope: "private" }, cache)).toBeUndefined();
        // No window in which a stored copy would be fresh.
        expect(restEdgeCacheFor({ maxAge: 0, scope: "public" }, cache)).toBeUndefined();
    });

    it("is built for a public policy with a real max-age", () => {
        expect.assertions(1);

        expect(restEdgeCacheFor(publicCache, fakeCache().cache)).toBeDefined();
    });
});

describe("the shareable exchange", () => {
    it("stores a public GET and serves the next identical request from the cache", async () => {
        expect.assertions(4);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        const request = get();

        edge?.forRequest(request, {}, context)?.store(applyRestCache(Response.json({ items: [1, 2] }), publicCache, request, context));
        await settled();

        expect(entries.size).toBe(1);

        const hit = await edge?.forRequest(get(), {}, context)?.lookup();

        expect(hit?.status).toBe(200);
        expect(hit?.headers.get(EDGE_CACHE_HEADER)).toBe("hit");
        // The stored copy carries the headers the first caller received.
        expect(hit?.headers.get("cache-control")).toBe("public, max-age=60");
    });

    it("leaves the served response's body readable after the cache takes its copy", async () => {
        expect.assertions(1);

        const { cache } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        const request = get();
        const served = edge?.forRequest(request, {}, context)?.store(applyRestCache(Response.json({ items: [1, 2] }), publicCache, request, context));

        await settled();

        await expect(served?.json()).resolves.toStrictEqual({ items: [1, 2] });
    });

    it("refuses a non-GET", () => {
        expect.assertions(1);

        const { cache } = fakeCache();
        const { context } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);

        // No exchange at all, so there is nothing to read from or write to.
        expect(edge?.forRequest(get({ method: "POST" }), {}, context)).toBeUndefined();
    });

    it("never stores a credentialed exchange, and never serves one from the shared cache", async () => {
        expect.assertions(5);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        const anonymous = get();

        edge?.forRequest(anonymous, {}, context)?.store(applyRestCache(Response.json({ secret: false }), publicCache, anonymous, context));
        await settled();

        expect(entries.size).toBe(1);

        // Each credential form must be refused the stored anonymous body.
        // secret-scanner:allow -- fake test fixture, not a real credential
        expect(edge?.forRequest(get({ headers: { authorization: "Bearer t" } }), {}, context)).toBeUndefined();
        expect(edge?.forRequest(get({ headers: { cookie: "session=abc" } }), {}, context)).toBeUndefined();
        expect(edge?.forRequest(get({ headers: { "cf-access-jwt-assertion": "jwt" } }), {}, context)).toBeUndefined();

        // Cloudflare Access authenticates out-of-band, so the credential is on the
        // execution context with no header to see.
        const accessContext = { access: { email: "a@b.c" }, waitUntil: () => {} } as unknown as ExecutionContextLike;

        expect(edge?.forRequest(get(), {}, accessContext)).toBeUndefined();
    });

    it("refuses an app-declared credential header", async () => {
        expect.assertions(1);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const policy: RestCachePolicy = { credentialHeaders: ["x-api-key"], maxAge: 60, scope: "public" };
        const edge = restEdgeCacheFor(policy, cache);
        const request = get({ headers: { "x-api-key": "k" } });

        edge?.forRequest(request, {}, context)?.store(applyRestCache(Response.json({}), policy, request, context));
        await settled();

        expect(entries.size).toBe(0);
    });

    // x402 v2 (what `@x402/core` reads and `@x402/fetch` sends) is `PAYMENT-SIGNATURE`;
    // v1's `X-PAYMENT` stays fenced for a client still sending the old name.
    it.each(["payment-signature", "x-payment"])("treats an x402 payment (%s) as the credential it is, so a paid response is never shared", async (header) => {
        expect.assertions(3);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        // A payer's request: the charge gate runs INSIDE the dispatch, so a stored
        // response would be replayed to callers who never paid.
        const paid = get({ headers: { [header]: "signed-payload" } });
        const answered = applyRestCache(Response.json({ premium: true }), publicCache, paid, context);

        // The header path agrees: a paid exchange is caller-specific.
        expect(answered.headers.get("cache-control")).toContain("private");

        edge?.forRequest(paid, {}, context)?.store(answered);
        await settled();

        expect(entries.size).toBe(0);
        // And an unpaid caller finds nothing to be served.
        await expect(edge?.forRequest(get(), {}, context)?.lookup()).resolves.toBeUndefined();
    });

    it.each(["payment-response", "x-payment-response"])("does not store a settlement receipt (%s) even if one reaches it", async (header) => {
        expect.assertions(1);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        const request = get();

        edge?.forRequest(request, {}, context)?.store(Response.json({ premium: true }, { headers: { [header]: "settled" } }));
        await settled();

        expect(entries.size).toBe(0);
    });

    it("does not store a non-200 or a Set-Cookie-bearing response", async () => {
        expect.assertions(2);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        const request = get();

        edge?.forRequest(request, {}, context)?.store(Response.json({ error: "nope" }, { status: 403 }));
        edge?.forRequest(request, {}, context)?.store(Response.json({}, { headers: { "set-cookie": "a=1" } }));
        await settled();

        expect(entries.size).toBe(0);
        await expect(edge?.forRequest(request, {}, context)?.lookup()).resolves.toBeUndefined();
    });

    it("still stores when the host gives no waitUntil", async () => {
        expect.assertions(1);

        const { cache, entries } = fakeCache();
        const edge = restEdgeCacheFor(publicCache, cache);
        const request = get();

        edge?.forRequest(request, {})?.store(applyRestCache(Response.json({}), publicCache, request));
        // The unawaited `put` settles on the microtask queue.
        await Promise.resolve();

        expect(entries.size).toBe(1);
    });
});

describe("the cache key", () => {
    it("folds the varying header values into the key rather than trusting Vary", async () => {
        expect.assertions(3);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        const tenantA = get({ headers: { "x-lunora-shard-key": "a" } });

        edge?.forRequest(tenantA, {}, context)?.store(applyRestCache(Response.json({ tenant: "a" }), publicCache, tenantA, context));
        await settled();

        expect(onlyKey(entries)).toContain("x-lunora-shard-key%3Da");
        await expect(edge?.forRequest(get({ headers: { "x-lunora-shard-key": "a" } }), {}, context)?.lookup()).resolves.toBeDefined();
        // A different shard is a different body, so it must miss rather than hit.
        await expect(edge?.forRequest(get({ headers: { "x-lunora-shard-key": "b" } }), {}, context)?.lookup()).resolves.toBeUndefined();
    });

    it("treats an absent and an empty varying header alike, and neither like a present one", async () => {
        expect.assertions(2);

        const { cache } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        const absent = get();

        edge?.forRequest(absent, {}, context)?.store(applyRestCache(Response.json({}), publicCache, absent, context));
        await settled();

        // An absent header and an empty one select the same data, so they share a key.
        await expect(edge?.forRequest(get({ headers: { "x-lunora-shard-key": "" } }), {}, context)?.lookup()).resolves.toBeDefined();
        await expect(edge?.forRequest(get({ headers: { "x-lunora-shard-key": "a" } }), {}, context)?.lookup()).resolves.toBeUndefined();
    });

    it("separates values that would otherwise concatenate into the same key", async () => {
        expect.assertions(1);

        const { cache } = fakeCache();
        const { context, settled } = contextWith();
        const policy: RestCachePolicy = { maxAge: 60, scope: "public", vary: "x-a, x-b" };
        const edge = restEdgeCacheFor(policy, cache);
        const first = get({ headers: { "x-a": "1", "x-b": "23" } });

        edge?.forRequest(first, {}, context)?.store(applyRestCache(Response.json({}), policy, first, context));
        await settled();

        await expect(edge?.forRequest(get({ headers: { "x-a": "12", "x-b": "3" } }), {}, context)?.lookup()).resolves.toBeUndefined();
    });

    it("keeps the original request's own query string", async () => {
        expect.assertions(2);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        const request = get({ url: "https://api.example.com/_lunora/rest/messages/list?limit=10" });

        edge?.forRequest(request, {}, context)?.store(applyRestCache(Response.json({}), publicCache, request, context));
        await settled();

        expect(new URL(onlyKey(entries)).searchParams.get("limit")).toBe("10");
        await expect(
            edge?.forRequest(get({ url: "https://api.example.com/_lunora/rest/messages/list?limit=20" }), {}, context)?.lookup(),
        ).resolves.toBeUndefined();
    });

    it("shares one entry between query strings that differ only in parameter order", async () => {
        expect.assertions(1);

        const { cache } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        const request = get({ url: "https://api.example.com/_lunora/rest/messages/list?a=1&b=2" });

        edge?.forRequest(request, {}, context)?.store(applyRestCache(Response.json({}), publicCache, request, context));
        await settled();

        await expect(
            edge?.forRequest(get({ url: "https://api.example.com/_lunora/rest/messages/list?b=2&a=1" }), {}, context)?.lookup(),
        ).resolves.toBeDefined();
    });

    it("keeps a repeated parameter's value order in the key, since the last value is the arg", async () => {
        expect.assertions(1);

        const { cache } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        const request = get({ url: "https://api.example.com/_lunora/rest/messages/list?a=1&a=2" });

        edge?.forRequest(request, {}, context)?.store(applyRestCache(Response.json({}), publicCache, request, context));
        await settled();

        await expect(
            edge?.forRequest(get({ url: "https://api.example.com/_lunora/rest/messages/list?a=2&a=1" }), {}, context)?.lookup(),
        ).resolves.toBeUndefined();
    });

    it("ignores a caller-supplied copy of the reserved parameter rather than keying on it", async () => {
        expect.assertions(2);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        // Two forged copies: `set` alone replaces only the first occurrence, so a
        // second would otherwise ride into the key.
        const forged = get({ url: `https://api.example.com/_lunora/rest/messages/list?${KEY_SCOPE_PARAM}=evil&${KEY_SCOPE_PARAM}=eviler` });

        edge?.forRequest(forged, {}, context)?.store(applyRestCache(Response.json({}), publicCache, forged, context));
        await settled();

        expect(onlyKey(entries)).not.toContain("evil");
        // Which means the forged request keyed exactly where the clean one does —
        // it bought the attacker no partition of its own.
        await expect(edge?.forRequest(get(), {}, context)?.lookup()).resolves.toBeDefined();
    });
});

describe("the deploy a key belongs to", () => {
    const versioned = (id: string): Record<string, unknown> => {
        return { CF_VERSION_METADATA: { id, tag: "v1", timestamp: "2026-01-01T00:00:00Z" } };
    };

    it("never serves a response stored by a previous deploy", async () => {
        expect.assertions(3);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        const request = get();

        edge?.forRequest(request, versioned("version-a"), context)?.store(applyRestCache(Response.json({ code: "old" }), publicCache, request, context));
        await settled();

        expect(onlyKey(entries)).toContain("version-a");
        await expect(edge?.forRequest(get(), versioned("version-a"), context)?.lookup()).resolves.toBeDefined();
        // Same tag, new upload: the id is what separates the two.
        await expect(edge?.forRequest(get(), versioned("version-b"), context)?.lookup()).resolves.toBeUndefined();
    });

    it("keeps caching, unscoped, when the version_metadata binding is not declared", async () => {
        expect.assertions(4);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        const request = get();

        edge?.forRequest(request, { CF_VERSION_METADATA: { id: "" } }, context)?.store(applyRestCache(Response.json({}), publicCache, request, context));
        await settled();

        // Never null for a public policy: it always fences the credential and
        // data-selecting headers. It must carry no deploy segment, though.
        const scope = new URL(onlyKey(entries)).searchParams.get(KEY_SCOPE_PARAM);

        expect(scope).not.toBeNull();
        expect(scope).not.toContain(":deploy");

        // An empty id and no binding at all key alike: the second write lands on the same entry.
        edge?.forRequest(request, {}, context)?.store(applyRestCache(Response.json({}), publicCache, request, context));
        await settled();

        expect(entries.size).toBe(1);
        await expect(edge?.forRequest(get(), {}, context)?.lookup()).resolves.toBeDefined();
    });
});

describe("what never reaches a second caller", () => {
    it("strips the per-caller headers a shard response carries", async () => {
        expect.assertions(3);

        const { cache } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        const request = get();
        const answered = applyRestCache(
            Response.json({}, { headers: { "x-d1-bookmark": "bookmark-1", "x-lunora-shard-key": "shard-a" } }),
            publicCache,
            request,
            context,
        );

        // The first caller still gets them — they describe the exchange it made.
        expect(answered.headers.get("x-d1-bookmark")).toBe("bookmark-1");

        edge?.forRequest(request, {}, context)?.store(answered);
        await settled();

        const hit = await edge?.forRequest(get(), {}, context)?.lookup();

        // A later caller holding a NEWER bookmark must not be handed this stale one.
        expect(hit?.headers.get("x-d1-bookmark")).toBeNull();
        expect(hit?.headers.get("x-lunora-shard-key")).toBeNull();
    });

    it("refuses to store a response advertising a Vary the key does not fence on", async () => {
        expect.assertions(2);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        const request = get();
        // `applyRestCache` MERGES the procedure's own `Vary` into the emitted
        // header, so a shard negotiating on `Accept-Language` advertises more than
        // the key fences. Serving one variant for another is the hazard; a miss is
        // the price.
        const negotiated = applyRestCache(Response.json({}), publicCache, request, context);

        negotiated.headers.set("vary", `${negotiated.headers.get("vary") ?? ""}, Accept-Language`);
        edge?.forRequest(request, {}, context)?.store(negotiated);

        const wildcard = applyRestCache(Response.json({}), publicCache, request, context);

        wildcard.headers.set("vary", "*");
        edge?.forRequest(request, {}, context)?.store(wildcard);
        await settled();

        expect(entries.size).toBe(0);
        await expect(edge?.forRequest(request, {}, context)?.lookup()).resolves.toBeUndefined();
    });
});

describe("a cache is never allowed to fail a request", () => {
    it("treats a rejecting cache as a miss", async () => {
        expect.assertions(2);

        const { context, settled } = contextWith();
        const broken: HttpCacheLike = {
            delete: async () => false,
            match: vi.fn<() => Promise<Response | undefined>>(async () => {
                throw new Error("cache unavailable");
            }),
            put: vi.fn<() => Promise<void>>(async () => {
                throw new Error("cache unavailable");
            }),
        };
        const edge = restEdgeCacheFor(publicCache, broken);
        const response = Response.json({});

        await expect(edge?.forRequest(get(), {}, context)?.lookup()).resolves.toBeUndefined();
        expect(edge?.forRequest(get(), {}, context)?.store(response)).toBe(response);

        await settled();
    });

    it("survives a host whose put throws synchronously rather than rejecting", () => {
        expect.assertions(1);

        const { context } = contextWith();
        const throwing: HttpCacheLike = {
            delete: async () => false,
            match: async () => undefined,
            put: () => {
                throw new Error("cache unavailable");
            },
        };
        const edge = restEdgeCacheFor(publicCache, throwing);
        const response = Response.json({});

        // A served response must not become a 500 because the write failed.
        expect(edge?.forRequest(get(), {}, context)?.store(response)).toBe(response);
    });

    it("degrades to a miss when the policy's vary is malformed, instead of throwing", async () => {
        expect.assertions(3);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        // A space instead of a comma: `Headers.get("accept language")` throws a
        // `TypeError` on an invalid header name. Before this was guarded, every
        // request to the endpoint became a 500.
        const policy: RestCachePolicy = { maxAge: 60, scope: "public", vary: "Accept Language" };
        const edge = restEdgeCacheFor(policy, cache);

        expect(edge).toBeDefined();
        // The key cannot be built, so the request gets no exchange with the cache.
        expect(() => edge?.forRequest(get(), {}, context)).not.toThrow();

        await settled();

        expect(entries.size).toBe(0);
    });
});
