import type { HttpCacheLike } from "@lunora/platform";
import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike } from "../../../shared/execution-context";
import type { RestCachePolicy } from "../../../shared/rest-surface";
import { applyRestCache } from "../src/rest-cache";
import { EDGE_CACHE_HEADER, restEdgeCacheFor, VARY_KEY_PARAM } from "../src/rest-edge-cache";
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

        edge?.store(applyRestCache(Response.json({ items: [1, 2] }), publicCache, request, context), request, context);
        await settled();

        expect(entries.size).toBe(1);

        const hit = await edge?.lookup(get(), context);

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
        const served = edge?.store(applyRestCache(Response.json({ items: [1, 2] }), publicCache, request, context), request, context);

        await settled();

        await expect(served?.json()).resolves.toStrictEqual({ items: [1, 2] });
    });

    it("refuses a non-GET", async () => {
        expect.assertions(1);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        const request = get({ method: "POST" });

        edge?.store(Response.json({}), request, context);
        await settled();

        expect(entries.size).toBe(0);
    });

    it("never stores a credentialed exchange, and never serves one from the shared cache", async () => {
        expect.assertions(5);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        const anonymous = get();

        edge?.store(applyRestCache(Response.json({ secret: false }), publicCache, anonymous, context), anonymous, context);
        await settled();

        expect(entries.size).toBe(1);

        // Each credential form must be refused the stored anonymous body.
        // secret-scanner:allow -- fake test fixture, not a real credential
        await expect(edge?.lookup(get({ headers: { authorization: "Bearer t" } }), context)).resolves.toBeUndefined();
        await expect(edge?.lookup(get({ headers: { cookie: "session=abc" } }), context)).resolves.toBeUndefined();
        await expect(edge?.lookup(get({ headers: { "cf-access-jwt-assertion": "jwt" } }), context)).resolves.toBeUndefined();

        // Cloudflare Access authenticates out-of-band, so the credential is on the
        // execution context with no header to see.
        const accessContext = { access: { email: "a@b.c" }, waitUntil: () => {} } as unknown as ExecutionContextLike;

        await expect(edge?.lookup(get(), accessContext)).resolves.toBeUndefined();
    });

    it("refuses an app-declared credential header", async () => {
        expect.assertions(1);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const policy: RestCachePolicy = { credentialHeaders: ["x-api-key"], maxAge: 60, scope: "public" };
        const edge = restEdgeCacheFor(policy, cache);
        const request = get({ headers: { "x-api-key": "k" } });

        edge?.store(applyRestCache(Response.json({}), policy, request, context), request, context);
        await settled();

        expect(entries.size).toBe(0);
    });

    it("treats an x402 payment as the credential it is, so a paid response is never shared", async () => {
        expect.assertions(3);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        // A payer's request: the charge gate runs INSIDE the dispatch, so a stored
        // response would be replayed to callers who never paid.
        const paid = get({ headers: { "x-payment": "signed-payload" } });
        const answered = applyRestCache(Response.json({ premium: true }), publicCache, paid, context);

        // The header path agrees: a paid exchange is caller-specific.
        expect(answered.headers.get("cache-control")).toContain("private");

        edge?.store(answered, paid, context);
        await settled();

        expect(entries.size).toBe(0);
        // And an unpaid caller finds nothing to be served.
        await expect(edge?.lookup(get(), context)).resolves.toBeUndefined();
    });

    it("does not store a settlement receipt even if one reaches it", async () => {
        expect.assertions(1);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        const request = get();

        edge?.store(Response.json({ premium: true }, { headers: { "x-payment-response": "settled" } }), request, context);
        await settled();

        expect(entries.size).toBe(0);
    });

    it("does not store a non-200 or a Set-Cookie-bearing response", async () => {
        expect.assertions(2);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        const request = get();

        edge?.store(Response.json({ error: "nope" }, { status: 403 }), request, context);
        edge?.store(Response.json({}, { headers: { "set-cookie": "a=1" } }), request, context);
        await settled();

        expect(entries.size).toBe(0);
        await expect(edge?.lookup(request, context)).resolves.toBeUndefined();
    });

    it("still stores when the host gives no waitUntil", async () => {
        expect.assertions(1);

        const { cache, entries } = fakeCache();
        const edge = restEdgeCacheFor(publicCache, cache);
        const request = get();

        edge?.store(applyRestCache(Response.json({}), publicCache, request), request);
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

        edge?.store(applyRestCache(Response.json({ tenant: "a" }), publicCache, tenantA, context), tenantA, context);
        await settled();

        expect(onlyKey(entries)).toContain("x-lunora-shard-key%3Da");
        await expect(edge?.lookup(get({ headers: { "x-lunora-shard-key": "a" } }), context)).resolves.toBeDefined();
        // A different shard is a different body, so it must miss rather than hit.
        await expect(edge?.lookup(get({ headers: { "x-lunora-shard-key": "b" } }), context)).resolves.toBeUndefined();
    });

    it("treats an absent and an empty varying header alike, and neither like a present one", async () => {
        expect.assertions(2);

        const { cache } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        const absent = get();

        edge?.store(applyRestCache(Response.json({}), publicCache, absent, context), absent, context);
        await settled();

        // An absent header and an empty one select the same data, so they share a key.
        await expect(edge?.lookup(get({ headers: { "x-lunora-shard-key": "" } }), context)).resolves.toBeDefined();
        await expect(edge?.lookup(get({ headers: { "x-lunora-shard-key": "a" } }), context)).resolves.toBeUndefined();
    });

    it("separates values that would otherwise concatenate into the same key", async () => {
        expect.assertions(1);

        const { cache } = fakeCache();
        const { context, settled } = contextWith();
        const policy: RestCachePolicy = { maxAge: 60, scope: "public", vary: "x-a, x-b" };
        const edge = restEdgeCacheFor(policy, cache);
        const first = get({ headers: { "x-a": "1", "x-b": "23" } });

        edge?.store(applyRestCache(Response.json({}), policy, first, context), first, context);
        await settled();

        await expect(edge?.lookup(get({ headers: { "x-a": "12", "x-b": "3" } }), context)).resolves.toBeUndefined();
    });

    it("keeps the original request's own query string", async () => {
        expect.assertions(2);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        const request = get({ url: "https://api.example.com/_lunora/rest/messages/list?limit=10" });

        edge?.store(applyRestCache(Response.json({}), publicCache, request, context), request, context);
        await settled();

        expect(new URL(onlyKey(entries)).searchParams.get("limit")).toBe("10");
        await expect(edge?.lookup(get({ url: "https://api.example.com/_lunora/rest/messages/list?limit=20" }), context)).resolves.toBeUndefined();
    });

    it("ignores a caller-supplied copy of the reserved parameter rather than keying on it", async () => {
        expect.assertions(2);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const edge = restEdgeCacheFor(publicCache, cache);
        // Two forged copies: `set` alone replaces only the first occurrence, so a
        // second would otherwise ride into the key.
        const forged = get({ url: `https://api.example.com/_lunora/rest/messages/list?${VARY_KEY_PARAM}=evil&${VARY_KEY_PARAM}=eviler` });

        edge?.store(applyRestCache(Response.json({}), publicCache, forged, context), forged, context);
        await settled();

        expect(onlyKey(entries)).not.toContain("evil");
        // Which means the forged request keyed exactly where the clean one does —
        // it bought the attacker no partition of its own.
        await expect(edge?.lookup(get(), context)).resolves.toBeDefined();
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

        edge?.store(answered, request, context);
        await settled();

        const hit = await edge?.lookup(get(), context);

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
        edge?.store(negotiated, request, context);

        const wildcard = applyRestCache(Response.json({}), publicCache, request, context);

        wildcard.headers.set("vary", "*");
        edge?.store(wildcard, request, context);
        await settled();

        expect(entries.size).toBe(0);
        await expect(edge?.lookup(request, context)).resolves.toBeUndefined();
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

        await expect(edge?.lookup(get(), context)).resolves.toBeUndefined();
        expect(edge?.store(response, get(), context)).toBe(response);

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
        expect(edge?.store(response, get(), context)).toBe(response);
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
        const request = get();
        const response = Response.json({});

        expect(edge?.store(response, request, context)).toBe(response);

        await settled();

        await expect(edge?.lookup(request, context)).resolves.toBeUndefined();

        expect(entries.size).toBe(0);
    });
});
