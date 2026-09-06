import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike, WorkerOptions } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";
import { createRestRateLimit, restSurfaceFromRegistry } from "../src/rest-routes";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

/** A shard DO that echoes the forwarded RPC body + a marker header back, so the test can assert what reached the shard. */
const echoShard = (): { namespace: ShardNamespaceLike; seen: { auth: string | null; body: string }[] } => {
    const seen: { auth: string | null; body: string }[] = [];
    const namespace: ShardNamespaceLike = {
        get: () => {
            return {
                fetch: async (request: Request) => {
                    const body = await request.text();

                    seen.push({ auth: request.headers.get("authorization"), body });

                    return Response.json({ ok: true, received: JSON.parse(body) as unknown });
                },
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };

    return { namespace, seen };
};

/** The opt-in registry: `list` + `send` are exposed; `secret` is NOT (default-closed). */
const functions: WorkerOptions["functions"] = {
    "messages:list": { expose: { rest: true }, kind: "query" },
    "messages:secret": { kind: "query" },
    "messages:send": { expose: { rest: true }, kind: "mutation" },
    "messages:stream": { expose: { rest: true }, kind: "stream" },
};

describe("createWorker — opt-in public REST surface", () => {
    it("routes an exposed query over REST GET through the procedure dispatch", async () => {
        expect.assertions(3);

        const { namespace, seen } = echoShard();
        const worker = createWorker({ functions, shardDO: namespace });

        const response = await worker.fetch(new Request("https://app.example/_lunora/rest/messages/list?limit=5"), {}, fakeContext);

        expect(response.status).toBe(200);
        // The REST call built an RPC envelope for the exact procedure...
        expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ args: { limit: 5 }, functionPath: "messages:list" });

        const body: { received: { args: unknown } } = JSON.parse(await response.text());

        expect(body.received.args).toEqual({ limit: 5 });
    });

    it("routes an exposed mutation over REST POST with a JSON body", async () => {
        expect.assertions(2);

        const { namespace, seen } = echoShard();
        const worker = createWorker({ functions, shardDO: namespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/rest/messages/send", {
                body: JSON.stringify({ text: "hi" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ args: { text: "hi" }, functionPath: "messages:send" });
    });

    it("returns 404 for a NON-exposed procedure (default-closed — never reachable over REST)", async () => {
        expect.assertions(2);

        const { namespace } = echoShard();
        const worker = createWorker({ functions, shardDO: namespace });

        const response = await worker.fetch(new Request("https://app.example/_lunora/rest/messages/secret"), {}, fakeContext);

        expect(response.status).toBe(404);

        // A stream procedure is also never exposed over REST (WebSocket-only).
        const stream = await worker.fetch(new Request("https://app.example/_lunora/rest/messages/stream"), {}, fakeContext);

        expect(stream.status).toBe(404);
    });

    it("enforces the same shard-authorization gate as RPC (auth/RLS parity)", async () => {
        expect.assertions(2);

        const { namespace } = echoShard();

        // `authorizeShard` denying → the REST call is rejected exactly as an RPC
        // envelope would be, proving REST rides the same authz path (so RLS + auth
        // enforced at the shard are never bypassed).
        const authorizeShard = vi.fn<() => Promise<boolean>>(async () => false);
        const worker = createWorker({ authorizeShard, functions, shardDO: namespace });

        const response = await worker.fetch(new Request("https://app.example/_lunora/rest/messages/list"), {}, fakeContext);

        expect(response.status).toBe(403);

        expect(authorizeShard).toHaveBeenCalledWith({ identity: null, shardKey: "__root__" });
    });

    it("forwards resolved identity to the shard (so ctx.auth / RLS apply)", async () => {
        expect.assertions(1);

        const { namespace, seen } = echoShard();
        // The worker forwards the inbound Authorization header to the shard as part
        // of `resolveForwardContext` — the same header the DO reads to build ctx.auth.
        const worker = createWorker({ functions, shardDO: namespace });

        await worker.fetch(new Request("https://app.example/_lunora/rest/messages/list", { headers: { authorization: "Bearer user-token" } }), {}, fakeContext); // secret-scanner:allow -- fake test fixture, not a real credential

        expect(seen[0]?.auth).toBe("Bearer user-token");
    });

    it("applies the injected rate-limit gate and returns its 429 verbatim", async () => {
        expect.assertions(2);

        const { namespace } = echoShard();
        const restRateLimit = vi.fn<() => Promise<Response>>(async () =>
            Response.json({ error: { code: "RATE_LIMITED" } }, { headers: { "retry-after": "30" }, status: 429 }),
        );
        const worker = createWorker({ functions, restRateLimit, shardDO: namespace });

        const response = await worker.fetch(new Request("https://app.example/_lunora/rest/messages/list"), {}, fakeContext);

        expect(response.status).toBe(429);
        expect(restRateLimit).toHaveBeenCalledWith(expect.any(Request), "messages:list");
    });

    it("405s a mutation reached with GET", async () => {
        expect.assertions(1);

        const { namespace } = echoShard();
        const worker = createWorker({ functions, shardDO: namespace });

        const response = await worker.fetch(new Request("https://app.example/_lunora/rest/messages/send"), {}, fakeContext);

        expect(response.status).toBe(405);
    });

    it("createRestRateLimit denies with a 429 + Retry-After when the limiter rejects", async () => {
        expect.assertions(4);

        const { namespace } = echoShard();
        const limiter = {
            limit: vi.fn<() => Promise<{ ok: boolean; retryAfter: number }>>(async () => {
                return { ok: false, retryAfter: 2500 };
            }),
        };
        const restRateLimit = createRestRateLimit(limiter, { key: () => "user-1", name: "rest" });
        const worker = createWorker({ functions, restRateLimit, shardDO: namespace });

        const response = await worker.fetch(new Request("https://app.example/_lunora/rest/messages/list"), {}, fakeContext);

        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("3");
        expect(limiter.limit).toHaveBeenCalledWith("rest", { key: "user-1" });

        const allow = {
            limit: vi.fn<() => Promise<{ ok: boolean; retryAfter: number }>>(async () => {
                return { ok: true, retryAfter: 0 };
            }),
        };
        const allowWorker = createWorker({ functions, restRateLimit: createRestRateLimit(allow, { key: () => "user-1", name: "rest" }), shardDO: namespace });
        const allowed = await allowWorker.fetch(new Request("https://app.example/_lunora/rest/messages/list"), {}, fakeContext);

        expect(allowed.status).toBe(200);
    });

    it("createRestRateLimit answers a deny-list hit with 403 and no Retry-After", async () => {
        expect.assertions(3);

        const { namespace } = echoShard();
        const limiter = {
            limit: vi.fn<() => Promise<{ ok: boolean; reason?: string; retryAfter: number }>>(async () => {
                // The shape `@lunora/ratelimit` returns for a deny-list hit: it
                // never clears, so there is no honest Retry-After to send —
                // `Math.ceil(Infinity / 1000)` renders the header "Infinity".
                return { ok: false, reason: "deny", retryAfter: Number.POSITIVE_INFINITY };
            }),
        };
        const worker = createWorker({
            functions,
            restRateLimit: createRestRateLimit(limiter, { key: () => "user-1", name: "rest" }),
            shardDO: namespace,
        });

        const response = await worker.fetch(new Request("https://app.example/_lunora/rest/messages/list"), {}, fakeContext);

        expect(response.status).toBe(403);
        expect(response.headers.get("retry-after")).toBeNull();
        await expect(response.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });
    });

    it("createRestRateLimit keys IP-less callers to their own shared bucket", async () => {
        expect.assertions(2);

        const { namespace } = echoShard();
        const limiter = {
            limit: vi.fn<() => Promise<{ ok: boolean; retryAfter: number }>>(async () => {
                return { ok: true, retryAfter: 0 };
            }),
        };
        const worker = createWorker({ functions, restRateLimit: createRestRateLimit(limiter, { name: "rest" }), shardDO: namespace });

        // No `cf-connecting-ip`: charging the limit with no key at all pools
        // these callers into the limit's UNKEYED bucket — the same one a
        // deliberately-global charge of "rest" uses — so one anonymous caller
        // drains the app-wide limit. They get a named bucket of their own.
        await worker.fetch(new Request("https://app.example/_lunora/rest/messages/list"), {}, fakeContext);

        expect(limiter.limit).toHaveBeenCalledWith("rest", { key: "no-trusted-ip" });

        // The header identifies a caller only ON Cloudflare, where the edge
        // stamps it over anything the client sent; this suite runs under
        // `environment: "node"`, so say so. `client-ip-trust.test.ts` pins both
        // directions of that gate.
        vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });

        await worker.fetch(new Request("https://app.example/_lunora/rest/messages/list", { headers: { "cf-connecting-ip": "203.0.113.7" } }), {}, fakeContext);

        expect(limiter.limit).toHaveBeenCalledWith("rest", { key: "203.0.113.7" });

        vi.unstubAllGlobals();
    });

    it("restSurfaceFromRegistry lists exactly the exposed, non-stream procedures", () => {
        expect.assertions(1);

        expect(
            restSurfaceFromRegistry(functions as Record<string, { expose?: { rest?: boolean }; kind: "action" | "mutation" | "query" | "stream" }>).map(
                (entry) => entry.path,
            ),
        ).toEqual(["/_lunora/rest/messages/list", "/_lunora/rest/messages/send"]);
    });

    it("orders the surface by UTF-16 code unit, not by the machine's locale", () => {
        expect.assertions(1);

        // `localeCompare` resolves against the runtime's default locale and ICU
        // version: under en-US it orders these case-INSENSITIVELY (`admin` before
        // `Zeta`), the opposite of the code-unit order. The published OpenAPI
        // document is generated on one machine and this enumeration runs on
        // another, and a contract test asserts the two agree — so the ordering may
        // not depend on which machine ran it.
        const mixedCase = {
            "Zeta:list": { expose: { rest: true }, kind: "query" },
            "admin:list": { expose: { rest: true }, kind: "query" },
        } as Record<string, { expose?: { rest?: boolean }; kind: "action" | "mutation" | "query" | "stream" }>;

        expect(restSurfaceFromRegistry(mixedCase).map((entry) => entry.path)).toEqual(["/_lunora/rest/Zeta/list", "/_lunora/rest/admin/list"]);
    });

    // Same gap as `serverQuery`: gzipped OTLP error spans are exported after the
    // response, so the public REST surface has to keep them alive too.
    it("threads the request's waitUntil into REST dispatch telemetry", async () => {
        expect.assertions(2);

        const { namespace } = echoShard();
        const kept: Promise<unknown>[] = [];
        const observability = {
            onRpc: (_event: unknown, context?: { waitUntil?: (promise: Promise<unknown>) => void }) => {
                context?.waitUntil?.(Promise.resolve("sent"));
            },
        };
        const worker = createWorker({ functions, observability, shardDO: namespace });

        await worker.fetch(
            new Request("https://app.example/_lunora/rest/messages/list?limit=5"),
            {},
            {
                passThroughOnException: () => undefined,
                waitUntil: (promise: Promise<unknown>) => kept.push(promise),
            },
        );

        expect(kept).toHaveLength(1);
        await expect(kept[0]).resolves.toBe("sent");
    });

    describe("declared response caching (.expose({ cache }))", () => {
        // `list` is cacheable and public; `send` declares a cache that must never
        // apply, because a mutation is POST-only.
        const cachingFunctions: WorkerOptions["functions"] = {
            "messages:list": { expose: { cache: { maxAge: 60, scope: "public", tag: "messages" }, rest: true }, kind: "query" },
            "messages:plain": { expose: { rest: true }, kind: "query" },
            "messages:send": { expose: { cache: { maxAge: 60, scope: "public" }, rest: true }, kind: "mutation" },
        };

        it("answers an anonymous GET with the declared shared-cache policy", async () => {
            expect.assertions(3);

            const { namespace } = echoShard();
            const worker = createWorker({ functions: cachingFunctions, shardDO: namespace });

            const response = await worker.fetch(new Request("https://app.example/_lunora/rest/messages/list"), {}, fakeContext);

            expect(response.headers.get("cache-control")).toBe("public, max-age=60");
            expect(response.headers.get("cache-tag")).toBe("messages");
            expect(response.headers.get("vary")).toBe("authorization, cf-access-jwt-assertion, cookie, x-payment, x-d1-bookmark, x-lunora-shard-key");
        });

        it("varies on the shard-key header, which selects which rows the caller sees", async () => {
            expect.assertions(1);

            const { namespace } = echoShard();
            const worker = createWorker({ functions: cachingFunctions, shardDO: namespace });

            const response = await worker.fetch(new Request("https://app.example/_lunora/rest/messages/list"), {}, fakeContext);

            // The query-string form is already in the URL; the header form is not,
            // so without this one URL would map to every shard's body.
            expect(response.headers.get("vary")).toContain("x-lunora-shard-key");
        });

        it("downgrades to private once the caller presents credentials, so a per-user body never reaches a shared cache", async () => {
            expect.assertions(1);

            const { namespace } = echoShard();
            const worker = createWorker({ functions: cachingFunctions, shardDO: namespace });

            const response = await worker.fetch(
                new Request("https://app.example/_lunora/rest/messages/list", { headers: { authorization: "Bearer user-token" } }), // secret-scanner:allow -- fake test fixture, not a real credential
                {},
                fakeContext,
            );

            expect(response.headers.get("cache-control")).toBe("private, max-age=60");
        });

        it("never caches a POST exchange, even when the procedure declares a cache", async () => {
            expect.assertions(2);

            const { namespace } = echoShard();
            const worker = createWorker({ functions: cachingFunctions, shardDO: namespace });

            const mutation = await worker.fetch(
                new Request("https://app.example/_lunora/rest/messages/send", {
                    body: JSON.stringify({ text: "hi" }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
                {},
                fakeContext,
            );

            expect(mutation.headers.get("cache-control")).toBeNull();

            // Same procedure reached as a POST-bodied query — still not cacheable.
            const query = await worker.fetch(
                new Request("https://app.example/_lunora/rest/messages/list", {
                    body: JSON.stringify({}),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
                {},
                fakeContext,
            );

            expect(query.headers.get("cache-control")).toBeNull();
        });

        it("leaves an endpoint that declares no cache completely untouched", async () => {
            expect.assertions(2);

            const { namespace } = echoShard();
            const worker = createWorker({ functions: cachingFunctions, shardDO: namespace });

            const response = await worker.fetch(new Request("https://app.example/_lunora/rest/messages/plain"), {}, fakeContext);

            expect(response.status).toBe(200);
            expect(response.headers.get("cache-control")).toBeNull();
        });

        it("does not cache a rejected request (authorization denied)", async () => {
            expect.assertions(2);

            const { namespace } = echoShard();
            const authorizeShard = vi.fn<() => Promise<boolean>>(async () => false);
            const worker = createWorker({ authorizeShard, functions: cachingFunctions, shardDO: namespace });

            const response = await worker.fetch(new Request("https://app.example/_lunora/rest/messages/list"), {}, fakeContext);

            expect(response.status).toBe(403);
            expect(response.headers.get("cache-control")).toBeNull();
        });
    });
});
