import type { HttpCacheLike } from "@lunora/platform";
import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike } from "../../../shared/execution-context";
import type { RestCachePolicy } from "../../../shared/rest-surface";
import { applyRestCache } from "../src/rest-cache";
import { EDGE_CACHE_HEADER, isEdgeCacheable, lookupRestEdgeCache, restCacheKey, storeRestEdgeCache, VARY_KEY_PARAM } from "../src/rest-edge-cache";

const publicCache: RestCachePolicy = { maxAge: 60, scope: "public" };

const get = (init: { headers?: Record<string, string>; method?: string; url?: string } = {}): Request =>
    new Request(init.url ?? "https://api.example.com/_lunora/rest/messages/list", { headers: init.headers, method: init.method ?? "GET" });

/** An in-memory `HttpCacheLike` keyed by the cache-key request's URL. */
const fakeCache = () => {
    const entries = new Map<string, Response>();
    const cache: HttpCacheLike = {
        delete: async (request) => entries.delete(typeof request === "string" ? request : request.url),
        match: async (request) => {
            const stored = entries.get(typeof request === "string" ? request : request.url);

            return stored?.clone();
        },
        put: async (request, response) => {
            entries.set(typeof request === "string" ? request : request.url, response);
        },
    };

    return { cache, entries };
};

/** A context whose `waitUntil` collects promises so a test can await the deferred `put`. */
const contextWith = (overrides: Partial<ExecutionContextLike> = {}) => {
    const pending: Promise<unknown>[] = [];

    return {
        context: { waitUntil: (promise: Promise<unknown>) => pending.push(promise), ...overrides } as ExecutionContextLike,
        settled: async () => {
            await Promise.all(pending);
        },
    };
};

describe("isEdgeCacheable", () => {
    it("accepts an anonymous GET under a public policy with a real max-age", () => {
        expect.assertions(1);

        expect(isEdgeCacheable(publicCache, get())).toBe(true);
    });

    it("refuses a declared-private policy — the browser may keep it, a shared cache must not", () => {
        expect.assertions(1);

        expect(isEdgeCacheable({ maxAge: 60, scope: "private" }, get())).toBe(false);
    });

    it("refuses a credentialed caller even under a public policy", () => {
        expect.assertions(3);

        expect(isEdgeCacheable(publicCache, get({ headers: { authorization: "Bearer t" } }))).toBe(false); // secret-scanner:allow -- fake test fixture, not a real credential
        expect(isEdgeCacheable(publicCache, get({ headers: { cookie: "session=abc" } }))).toBe(false);
        expect(isEdgeCacheable(publicCache, get({ headers: { "cf-access-jwt-assertion": "jwt" } }))).toBe(false);
    });

    it("refuses a caller Cloudflare Access authenticated out-of-band on the execution context", () => {
        expect.assertions(1);

        const context = { access: { email: "a@b.c" }, waitUntil: () => {} } as unknown as ExecutionContextLike;

        expect(isEdgeCacheable(publicCache, get(), context)).toBe(false);
    });

    it("refuses an app-declared credential header", () => {
        expect.assertions(1);

        const policy: RestCachePolicy = { credentialHeaders: ["x-api-key"], maxAge: 60, scope: "public" };

        expect(isEdgeCacheable(policy, get({ headers: { "x-api-key": "k" } }))).toBe(false);
    });

    it("refuses a zero (or non-finite) max-age — no window in which a stored copy is fresh", () => {
        expect.assertions(2);

        expect(isEdgeCacheable({ maxAge: 0, scope: "public" }, get())).toBe(false);
        expect(isEdgeCacheable({ maxAge: Number.NaN, scope: "public" }, get())).toBe(false);
    });

    it("refuses a non-GET", () => {
        expect.assertions(1);

        expect(isEdgeCacheable(publicCache, get({ method: "POST" }))).toBe(false);
    });
});

describe("restCacheKey", () => {
    it("folds the varying header values into the key rather than trusting Vary", () => {
        expect.assertions(2);

        const withShard = restCacheKey(publicCache, get({ headers: { "x-lunora-shard-key": "tenant-a" } }));
        const withOther = restCacheKey(publicCache, get({ headers: { "x-lunora-shard-key": "tenant-b" } }));

        expect(withShard.url).not.toBe(withOther.url);
        expect(new URL(withShard.url).searchParams.get(VARY_KEY_PARAM)).toContain("x-lunora-shard-key=tenant-a");
    });

    it("keys two requests that differ only in an absent vs empty varying header alike only when they truly match", () => {
        expect.assertions(2);

        const absent = restCacheKey(publicCache, get());
        const empty = restCacheKey(publicCache, get({ headers: { "x-lunora-shard-key": "" } }));
        const present = restCacheKey(publicCache, get({ headers: { "x-lunora-shard-key": "a" } }));

        // An absent header and an empty one select the same data, so they may share a key.
        expect(absent.url).toBe(empty.url);
        expect(absent.url).not.toBe(present.url);
    });

    it("separates values that would otherwise concatenate into the same key", () => {
        expect.assertions(1);

        const policy: RestCachePolicy = { maxAge: 60, scope: "public", vary: "x-a, x-b" };
        const first = restCacheKey(policy, get({ headers: { "x-a": "1", "x-b": "23" } }));
        const second = restCacheKey(policy, get({ headers: { "x-a": "12", "x-b": "3" } }));

        expect(first.url).not.toBe(second.url);
    });

    it("keeps the original request's own query string", () => {
        expect.assertions(1);

        const key = restCacheKey(publicCache, get({ url: "https://api.example.com/_lunora/rest/messages/list?limit=10" }));

        expect(new URL(key.url).searchParams.get("limit")).toBe("10");
    });
});

describe("storeRestEdgeCache + lookupRestEdgeCache", () => {
    it("stores a public GET and serves the next identical request from the cache", async () => {
        expect.assertions(4);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const request = get();
        const answered = applyRestCache(Response.json({ items: [1, 2] }), publicCache, request, context);

        storeRestEdgeCache(cache, answered, publicCache, request, context);
        await settled();

        expect(entries.size).toBe(1);

        const hit = await lookupRestEdgeCache(cache, publicCache, get(), context);

        expect(hit?.status).toBe(200);
        expect(hit?.headers.get(EDGE_CACHE_HEADER)).toBe("hit");
        // The stored copy carries the headers the first caller received.
        expect(hit?.headers.get("cache-control")).toBe("public, max-age=60");
    });

    it("leaves the served response's body readable after the cache takes its copy", async () => {
        expect.assertions(1);

        const { cache } = fakeCache();
        const { context, settled } = contextWith();
        const request = get();
        const answered = applyRestCache(Response.json({ items: [1, 2] }), publicCache, request, context);
        const served = storeRestEdgeCache(cache, answered, publicCache, request, context);

        await settled();

        await expect(served.json()).resolves.toStrictEqual({ items: [1, 2] });
    });

    it("never stores a credentialed exchange, and never serves one from the shared cache", async () => {
        expect.assertions(2);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();

        // Seed the cache from an anonymous request.
        const anonymous = get();

        storeRestEdgeCache(cache, applyRestCache(Response.json({ secret: false }), publicCache, anonymous, context), publicCache, anonymous, context);
        await settled();

        expect(entries.size).toBe(1);

        // A credentialed caller must not be handed the stored anonymous body.
        const credentialed = get({ headers: { cookie: "session=abc" } });

        await expect(lookupRestEdgeCache(cache, publicCache, credentialed, context)).resolves.toBeUndefined();
    });

    it("does not store a declared-private policy", async () => {
        expect.assertions(1);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const request = get();
        const policy: RestCachePolicy = { maxAge: 60, scope: "private" };

        storeRestEdgeCache(cache, applyRestCache(Response.json({}), policy, request, context), policy, request, context);
        await settled();

        expect(entries.size).toBe(0);
    });

    it("does not store a non-200 or a Set-Cookie-bearing response", async () => {
        expect.assertions(2);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const request = get();

        storeRestEdgeCache(cache, Response.json({ error: "nope" }, { status: 403 }), publicCache, request, context);
        storeRestEdgeCache(cache, Response.json({}, { headers: { "set-cookie": "a=1" } }), publicCache, request, context);
        await settled();

        expect(entries.size).toBe(0);
        await expect(lookupRestEdgeCache(cache, publicCache, request, context)).resolves.toBeUndefined();
    });

    it("does not serve a stored entry to a request with a different varying header", async () => {
        expect.assertions(2);

        const { cache } = fakeCache();
        const { context, settled } = contextWith();
        const tenantA = get({ headers: { "x-lunora-shard-key": "a" } });

        storeRestEdgeCache(cache, applyRestCache(Response.json({ tenant: "a" }), publicCache, tenantA, context), publicCache, tenantA, context);
        await settled();

        await expect(lookupRestEdgeCache(cache, publicCache, get({ headers: { "x-lunora-shard-key": "a" } }), context)).resolves.toBeDefined();
        await expect(lookupRestEdgeCache(cache, publicCache, get({ headers: { "x-lunora-shard-key": "b" } }), context)).resolves.toBeUndefined();
    });

    it("is a no-op with no policy, and on a host with no cache", async () => {
        expect.assertions(3);

        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const request = get();
        const response = Response.json({});

        expect(storeRestEdgeCache(cache, response, undefined, request, context)).toBe(response);
        expect(storeRestEdgeCache(undefined, response, publicCache, request, context)).toBe(response);

        await settled();

        expect(entries.size).toBe(0);
    });

    it("treats a rejecting cache as a miss rather than failing the request", async () => {
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
        const request = get();
        const response = Response.json({});

        await expect(lookupRestEdgeCache(broken, publicCache, request, context)).resolves.toBeUndefined();
        expect(storeRestEdgeCache(broken, response, publicCache, request, context)).toBe(response);

        await settled();
    });

    it("still stores when the host gives no waitUntil", async () => {
        expect.assertions(1);

        const { cache, entries } = fakeCache();
        const request = get();

        storeRestEdgeCache(cache, applyRestCache(Response.json({}), publicCache, request), publicCache, request);
        // The unawaited `put` settles on the microtask queue.
        await Promise.resolve();

        expect(entries.size).toBe(1);
    });
});
