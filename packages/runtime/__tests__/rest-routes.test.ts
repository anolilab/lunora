import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";
import { defaultHttpCache, VARY_KEY_PARAM } from "../src/rest-edge-cache";
import { argsFromQuery } from "../src/rest-routes";
import { fakeCache } from "./helpers/edge-cache";

/**
 * The public REST surface (`/_lunora/rest/<namespace>/<fn>`, plan 167) — RUNTIME-02
 * (advisor 226). REST skipped the `args`-shape guard `/_lunora/rpc` enforces via
 * `parseEnvelope`, and `argsFromQuery` assigned into a plain `{}` so a `__proto__`
 * query key could reparent the args object. Both are now the same
 * `assertArgsObject` check / null-proto build the RPC edge and `v.record` use.
 */

interface ShardSpy {
    calls: { request: Request; shardKey: string }[];
    namespace: ShardNamespaceLike;
    response: Response;
}

const createShardSpy = (response = new Response("ok", { status: 200 })): ShardSpy => {
    const calls: { request: Request; shardKey: string }[] = [];
    const spy = { calls, response } as ShardSpy;

    spy.namespace = {
        get: (id) => {
            const shardKey = (id as { __name: string }).__name;

            return {
                fetch: async (request: Request) => {
                    calls.push({ request, shardKey });

                    return spy.response;
                },
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };

    return spy;
};

const fakeContext = { passThroughOnException: () => undefined, waitUntil: () => undefined };

/** A registry with one REST-exposed query and one REST-exposed mutation. */
const restFunctions = {
    "messages:list": { expose: { rest: true }, kind: "query" },
    "messages:send": { expose: { rest: true }, kind: "mutation" },
} as const;

describe("createWorker — REST args-shape boundary", () => {
    it("rejects a POST body of `null` with 400, never forwarding to a shard", async () => {
        expect.assertions(2);

        const shard = createShardSpy();
        const worker = createWorker({ functions: restFunctions, shardDO: shard.namespace });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rest/messages/send", { body: "null", headers: { "content-type": "application/json" }, method: "POST" }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(400);
        expect(shard.calls).toHaveLength(0);
    });

    it("rejects a POST body that parses to an array with 400, never forwarding to a shard", async () => {
        expect.assertions(3);

        const shard = createShardSpy();
        const worker = createWorker({ functions: restFunctions, shardDO: shard.namespace });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rest/messages/send", {
                body: JSON.stringify([1, 2]),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
        expect(shard.calls).toHaveLength(0);
    });

    it("still forwards a well-formed object body", async () => {
        expect.assertions(2);

        const shard = createShardSpy();
        const worker = createWorker({ functions: restFunctions, shardDO: shard.namespace });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rest/messages/send", {
                body: JSON.stringify({ text: "hi" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(200);
        expect(shard.calls).toHaveLength(1);
    });

    it("does not let a `__proto__` query key reparent the forwarded args object", async () => {
        expect.assertions(3);

        const shard = createShardSpy();
        const worker = createWorker({ functions: restFunctions, shardDO: shard.namespace });

        const res = await worker.fetch(
            new Request(`https://app.example/_lunora/rest/messages/list?${encodeURIComponent("__proto__")}=${encodeURIComponent('{"polluted":true}')}`),
            {},
            fakeContext,
        );

        expect(res.status).toBe(200);
        expect(shard.calls).toHaveLength(1);

        const forwardedBody: { args: Record<string, unknown> } = await shard.calls[0]!.request.json();

        // With a plain `{}` accumulator, `args["__proto__"] = …` invokes the
        // inherited setter and REPARENTS `args` instead of creating a data
        // property — `Object.keys`/`JSON.stringify` then see no `__proto__` key
        // at all, and the caller's argument is silently dropped rather than
        // forwarded. With the null-proto accumulator there is no inherited
        // setter to intercept the assignment, so it lands as an ordinary own
        // property and survives the round-trip to the shard.
        expect(Object.getOwnPropertyDescriptor(forwardedBody.args, "__proto__")?.value).toEqual({ polluted: true });
    });
});

/**
 * The edge-cache WIRING, as distinct from `rest-edge-cache.test.ts`, which covers
 * the store/lookup decisions in isolation. What matters here is what the route
 * actually does with them: that a hit costs no shard dispatch, that a miss still
 * stores, that the rate-limit gate is consulted first, and that the opt-out
 * reaches `buildRestRoutes` from `createWorker`.
 */
describe("createWorker — REST edge cache", () => {
    const cachedFunctions = {
        "messages:list": { expose: { cache: { maxAge: 60, scope: "public" }, rest: true }, kind: "query" },
    } as const;

    /** `fakeContext` but collecting `waitUntil` promises, so a test can await the deferred `put`. */
    const collectingContext = () => {
        const pending: Promise<unknown>[] = [];

        return {
            context: { passThroughOnException: () => undefined, waitUntil: (promise: Promise<unknown>) => pending.push(promise) },
            settled: async () => {
                await Promise.all(pending);
            },
        };
    };

    const listRequest = () => new Request("https://app.example/_lunora/rest/messages/list");

    it("serves the second identical request from the cache, with no second shard dispatch", async () => {
        expect.assertions(4);

        const shard = createShardSpy(Response.json({ items: [] }));
        const { cache } = fakeCache();
        const { context, settled } = collectingContext();
        const worker = createWorker({ functions: cachedFunctions, restEdgeCache: cache, shardDO: shard.namespace });

        const first = await worker.fetch(listRequest(), {}, context);

        await settled();

        expect(first.headers.get("x-lunora-edge-cache")).toBeNull();
        expect(shard.calls).toHaveLength(1);

        const second = await worker.fetch(listRequest(), {}, context);

        expect(second.headers.get("x-lunora-edge-cache")).toBe("hit");
        // The whole point: the origin was not touched a second time.
        expect(shard.calls).toHaveLength(1);
    });

    it("stores nothing, and dispatches every time, when the caller presents a credential", async () => {
        expect.assertions(2);

        const shard = createShardSpy(Response.json({ items: [] }));
        const { cache, entries } = fakeCache();
        const { context, settled } = collectingContext();
        const worker = createWorker({ functions: cachedFunctions, restEdgeCache: cache, shardDO: shard.namespace });
        const credentialed = () => new Request("https://app.example/_lunora/rest/messages/list", { headers: { cookie: "session=abc" } });

        await worker.fetch(credentialed(), {}, context);
        await settled();
        await worker.fetch(credentialed(), {}, context);
        await settled();

        expect(entries.size).toBe(0);
        expect(shard.calls).toHaveLength(2);
    });

    it("consults the rate-limit gate BEFORE the cache — a hit is still the caller's request", async () => {
        expect.assertions(4);

        const shard = createShardSpy(Response.json({ items: [] }));
        const { cache } = fakeCache();
        const { context, settled } = collectingContext();
        let charged = 0;
        let limited = false;
        const worker = createWorker({
            functions: cachedFunctions,
            restEdgeCache: cache,
            restRateLimit: () => {
                charged += 1;

                return limited ? new Response("slow down", { status: 429 }) : undefined;
            },
            shardDO: shard.namespace,
        });

        await worker.fetch(listRequest(), {}, context);
        await settled();

        // Now the entry is warm. A limited caller must still get a 429 rather
        // than being handed the cached body for free.
        limited = true;

        const rejected = await worker.fetch(listRequest(), {}, context);

        expect(rejected.status).toBe(429);
        expect(rejected.headers.get("x-lunora-edge-cache")).toBeNull();
        expect(charged).toBe(2);
        expect(shard.calls).toHaveLength(1);
    });

    it("keeps the surface headers-only when the edge cache is opted out with null", async () => {
        expect.assertions(3);

        const shard = createShardSpy(Response.json({ items: [] }));
        const { context, settled } = collectingContext();
        const worker = createWorker({ functions: cachedFunctions, restEdgeCache: null, shardDO: shard.namespace });

        const first = await worker.fetch(listRequest(), {}, context);

        await settled();
        await worker.fetch(listRequest(), {}, context);
        await settled();

        // The declared policy still goes out on the wire...
        expect(first.headers.get("cache-control")).toBe("public, max-age=60");
        // ...but nothing is stored, so every request reaches the origin.
        expect(first.headers.get("x-lunora-edge-cache")).toBeNull();
        expect(shard.calls).toHaveLength(2);
    });

    it("does not cache an endpoint that declared no policy at all", async () => {
        expect.assertions(2);

        const shard = createShardSpy(Response.json({ items: [] }));
        const { cache, entries } = fakeCache();
        const { context, settled } = collectingContext();
        const worker = createWorker({ functions: restFunctions, restEdgeCache: cache, shardDO: shard.namespace });

        await worker.fetch(listRequest(), {}, context);
        await settled();
        await worker.fetch(listRequest(), {}, context);
        await settled();

        expect(entries.size).toBe(0);
        expect(shard.calls).toHaveLength(2);
    });

    it("never serves a paid response to a caller who did not pay", async () => {
        expect.assertions(4);

        const shard = createShardSpy(Response.json({ premium: true }));
        const { cache, entries } = fakeCache();
        const { context, settled } = collectingContext();
        const worker = createWorker({ functions: cachedFunctions, restEdgeCache: cache, shardDO: shard.namespace });
        // The x402 charge gate runs INSIDE the dispatch, downstream of the cache
        // lookup, so a stored paid response would be replayed for free — together
        // with the payer's settlement receipt.
        const paid = new Request("https://app.example/_lunora/rest/messages/list", { headers: { "x-payment": "signed-payload" } });

        const answered = await worker.fetch(paid, {}, context);

        await settled();

        expect(answered.headers.get("cache-control")).toContain("private");
        expect(entries.size).toBe(0);

        const unpaid = await worker.fetch(listRequest(), {}, context);

        expect(unpaid.headers.get("x-lunora-edge-cache")).toBeNull();
        expect(shard.calls).toHaveLength(2);
    });

    it("does not let the reserved cache-key parameter reach the procedure or move the key", async () => {
        expect.assertions(3);

        const shard = createShardSpy(Response.json({ items: [] }));
        const { cache } = fakeCache();
        const { context, settled } = collectingContext();
        const worker = createWorker({ functions: cachedFunctions, restEdgeCache: cache, shardDO: shard.namespace });

        await worker.fetch(new Request(`https://app.example/_lunora/rest/messages/list?${VARY_KEY_PARAM}=evil`), {}, context);
        await settled();

        const forwarded = (await shard.calls[0]?.request.clone().json()) as { args?: Record<string, unknown> };

        // It is reserved, so it is not an argument...
        expect(forwarded.args ?? {}).not.toHaveProperty(VARY_KEY_PARAM);

        // ...and it keyed where the clean request keys, so a hit answers that one.
        const clean = await worker.fetch(listRequest(), {}, context);

        expect(clean.headers.get("x-lunora-edge-cache")).toBe("hit");
        expect(shard.calls).toHaveLength(1);
    });
});

describe("defaultHttpCache", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("returns undefined on a runtime with no `caches` global", () => {
        expect.assertions(1);

        vi.stubGlobal("caches", undefined);

        expect(defaultHttpCache()).toBeUndefined();
    });

    it("returns the host's default cache when there is one", () => {
        expect.assertions(1);

        const cache = { delete: async () => false, match: async () => undefined, put: async () => {} };

        vi.stubGlobal("caches", { default: cache });

        expect(defaultHttpCache()).toBe(cache);
    });

    it("treats a throwing accessor as no cache rather than propagating", () => {
        expect.assertions(1);

        vi.stubGlobal("caches", {
            get default(): never {
                throw new Error("not available in this context");
            },
        });

        expect(defaultHttpCache()).toBeUndefined();
    });
});

describe("argsFromQuery", () => {
    it("builds a null-prototype accumulator, matching v.record", () => {
        expect.assertions(1);

        const args = argsFromQuery(new URL("https://app.example/x?a=1"));

        expect(Object.getPrototypeOf(args)).toBeNull();
    });

    it("stores a `__proto__` query key as an own property rather than reparenting the object", () => {
        expect.assertions(2);

        const args = argsFromQuery(new URL(`https://app.example/x?${encodeURIComponent("__proto__")}=${encodeURIComponent('{"x":1}')}`));

        expect(Object.getPrototypeOf(args)).toBeNull();
        expect(Object.getOwnPropertyDescriptor(args, "__proto__")?.value).toEqual({ x: 1 });
    });

    it("excludes the reserved shardKey key", () => {
        expect.assertions(1);

        const args = argsFromQuery(new URL("https://app.example/x?shardKey=team-1&limit=5"));

        expect(args).toEqual({ limit: 5 });
    });
});
