import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike, WorkerOptions } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";
import { createRestRateLimit } from "../src/rest-routes";

/**
 * Who is allowed to say what the caller's IP is.
 *
 * `cf-connecting-ip` is a header a client cannot write only ON Cloudflare, where
 * the edge stamps it over anything the client sent. On any other host — the
 * `target: "node"` deployments `@lunora/platform-node` now supports, a container,
 * a bare process — nothing overwrites it, so it is just a header the client
 * typed. Trusting it there hands an attacker a fresh rate-limit bucket per
 * request (rotate `Cf-Connecting-IP: <a fresh address per request>` and the REST limit never binds)
 * and lets them forge `ctx.ip` for any procedure that keys on it.
 *
 * `@lunora/auth` already gates its own reads of that header on the runtime; these
 * pin the same gate on the two runtime reads. BOTH directions matter: a fix that
 * simply stopped reading the header would silently break the Cloudflare path,
 * which is the one deployment where it is trustworthy.
 *
 * The runtime suite runs under `environment: "node"`, so OFF-Cloudflare is the
 * ambient default and the on-edge cases stub `navigator` explicitly.
 */
const CLOUDFLARE_NAVIGATOR = { userAgent: "Cloudflare-Workers" };

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const functions: WorkerOptions["functions"] = {
    "messages:list": { expose: { rest: true }, kind: "query" },
};

const recordingShard = (): { calls: Request[]; namespace: ShardNamespaceLike } => {
    const calls: Request[] = [];
    const namespace: ShardNamespaceLike = {
        get: () => {
            return {
                fetch: async (request: Request) => {
                    calls.push(request);

                    return Response.json({ ok: true });
                },
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };

    return { calls, namespace };
};

const rpc = (): Request =>
    new Request("https://app.example/_lunora/rpc", {
        body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
        headers: { "cf-connecting-ip": "203.0.113.7" },
        method: "POST",
    });

describe("client IP trust", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe("createRestRateLimit default key", () => {
        it("keys on cf-connecting-ip on Cloudflare", async () => {
            expect.assertions(1);

            vi.stubGlobal("navigator", CLOUDFLARE_NAVIGATOR);

            const { namespace } = recordingShard();
            const limiter = {
                limit: vi.fn<() => Promise<{ ok: boolean; retryAfter: number }>>(async () => {
                    return { ok: true, retryAfter: 0 };
                }),
            };
            const worker = createWorker({ functions, restRateLimit: createRestRateLimit(limiter, { name: "rest" }), shardDO: namespace });

            await worker.fetch(
                new Request("https://app.example/_lunora/rest/messages/list", { headers: { "cf-connecting-ip": "203.0.113.7" } }),
                {},
                fakeContext,
            );

            expect(limiter.limit).toHaveBeenCalledWith("rest", { key: "203.0.113.7" });
        });

        it("does not key on a client-supplied cf-connecting-ip off Cloudflare", async () => {
            expect.assertions(2);

            const { namespace } = recordingShard();
            const limiter = {
                limit: vi.fn<() => Promise<{ ok: boolean; retryAfter: number }>>(async () => {
                    return { ok: true, retryAfter: 0 };
                }),
            };
            const worker = createWorker({ functions, restRateLimit: createRestRateLimit(limiter, { name: "rest" }), shardDO: namespace });

            // Two attacker-chosen values must land in the SAME bucket, or the
            // limit is one header away from not existing.
            await worker.fetch(
                new Request("https://app.example/_lunora/rest/messages/list", { headers: { "cf-connecting-ip": "203.0.113.4" } }),
                {},
                fakeContext,
            );
            await worker.fetch(
                new Request("https://app.example/_lunora/rest/messages/list", { headers: { "cf-connecting-ip": "203.0.113.5" } }),
                {},
                fakeContext,
            );

            expect(limiter.limit).toHaveBeenNthCalledWith(1, "rest", { key: "no-trusted-ip" });
            expect(limiter.limit).toHaveBeenNthCalledWith(2, "rest", { key: "no-trusted-ip" });
        });

        it("still honours an explicit key callback off Cloudflare", async () => {
            expect.assertions(1);

            const { namespace } = recordingShard();
            const limiter = {
                limit: vi.fn<() => Promise<{ ok: boolean; retryAfter: number }>>(async () => {
                    return { ok: true, retryAfter: 0 };
                }),
            };
            const worker = createWorker({
                functions,
                restRateLimit: createRestRateLimit(limiter, { key: () => "api-key-9", name: "rest" }),
                shardDO: namespace,
            });

            await worker.fetch(
                new Request("https://app.example/_lunora/rest/messages/list", { headers: { "cf-connecting-ip": "203.0.113.4" } }),
                {},
                fakeContext,
            );

            expect(limiter.limit).toHaveBeenCalledWith("rest", { key: "api-key-9" });
        });
    });

    describe("a declared trustedClientIpHeader", () => {
        it("keys the REST limiter per caller off Cloudflare", async () => {
            expect.assertions(2);

            const { namespace } = recordingShard();
            const limiter = {
                limit: vi.fn<() => Promise<{ ok: boolean; retryAfter: number }>>(async () => {
                    return { ok: true, retryAfter: 0 };
                }),
            };
            const worker = createWorker({
                functions,
                restRateLimit: createRestRateLimit(limiter, { name: "rest", trustedClientIpHeader: "cf-connecting-ip" }),
                shardDO: namespace,
            });

            // The behind-Cloudflare origin the fail-closed default pools into one
            // bucket: with the header declared, two callers get two buckets again.
            await worker.fetch(
                new Request("https://app.example/_lunora/rest/messages/list", { headers: { "cf-connecting-ip": "203.0.113.4" } }),
                {},
                fakeContext,
            );
            await worker.fetch(
                new Request("https://app.example/_lunora/rest/messages/list", { headers: { "cf-connecting-ip": "203.0.113.5" } }),
                {},
                fakeContext,
            );

            expect(limiter.limit).toHaveBeenNthCalledWith(1, "rest", { key: "203.0.113.4" });
            expect(limiter.limit).toHaveBeenNthCalledWith(2, "rest", { key: "203.0.113.5" });
        });

        it("forwards ctx.ip off Cloudflare", async () => {
            expect.assertions(1);

            const shard = recordingShard();
            const worker = createWorker({ functions, shardDO: shard.namespace, trustedClientIpHeader: "cf-connecting-ip" });

            await worker.fetch(rpc(), {}, fakeContext);

            expect(shard.calls[0]?.headers.get("x-lunora-client-ip")).toBe("203.0.113.7");
        });

        it("resolves nothing from a declared header carrying a forwarded chain", async () => {
            expect.assertions(1);

            const shard = recordingShard();
            const worker = createWorker({ functions, shardDO: shard.namespace, trustedClientIpHeader: "x-forwarded-for" });

            // A chain's leftmost entry is whatever the client typed, so an
            // appending proxy cannot be read as one trusted address. The
            // declaration is for headers infrastructure REPLACES, and a comma is
            // the cheap signal that this header is not one of them.
            await worker.fetch(
                new Request("https://app.example/_lunora/rpc", {
                    body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                    headers: { "x-forwarded-for": "198.51.100.9, 203.0.113.7" },
                    method: "POST",
                }),
                {},
                fakeContext,
            );

            expect(shard.calls[0]?.headers.get("x-lunora-client-ip")).toBeNull();
        });

        it("is ignored on Cloudflare, where cf-connecting-ip still wins", async () => {
            expect.assertions(1);

            vi.stubGlobal("navigator", CLOUDFLARE_NAVIGATOR);

            const shard = recordingShard();
            const worker = createWorker({ functions, shardDO: shard.namespace, trustedClientIpHeader: "x-client-ip" });

            await worker.fetch(
                new Request("https://app.example/_lunora/rpc", {
                    body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                    headers: { "cf-connecting-ip": "203.0.113.7", "x-client-ip": "198.51.100.9" },
                    method: "POST",
                }),
                {},
                fakeContext,
            );

            expect(shard.calls[0]?.headers.get("x-lunora-client-ip")).toBe("203.0.113.7");
        });
    });

    describe("x-lunora-client-ip forwarded to the shard (ctx.ip)", () => {
        it("forwards cf-connecting-ip on Cloudflare", async () => {
            expect.assertions(1);

            vi.stubGlobal("navigator", CLOUDFLARE_NAVIGATOR);

            const shard = recordingShard();
            const worker = createWorker({ functions, shardDO: shard.namespace });

            await worker.fetch(rpc(), {}, fakeContext);

            expect(shard.calls[0]?.headers.get("x-lunora-client-ip")).toBe("203.0.113.7");
        });

        it("does not forward a client-supplied cf-connecting-ip off Cloudflare", async () => {
            expect.assertions(1);

            const shard = recordingShard();
            const worker = createWorker({ functions, shardDO: shard.namespace });

            await worker.fetch(rpc(), {}, fakeContext);

            // `ctx.ip` must read `undefined` rather than an attacker-chosen
            // string: every procedure keying a rate limit on it (the scaffolded
            // default does) would otherwise be trivially bypassed.
            expect(shard.calls[0]?.headers.get("x-lunora-client-ip")).toBeNull();
        });
    });
});
