import { afterEach, describe, expect, it } from "vitest";

import { ORIGIN_PAYWALL_APPLIED, ORIGIN_PAYWALL_HEADER } from "../../../shared/origin-paywall";
import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

interface ShardSpy {
    forwarded: Request[];
    namespace: ShardNamespaceLike;
    response: () => Response;
}

const createShardSpy = (response: () => Response = () => Response.json({ result: null })): ShardSpy => {
    const forwarded: Request[] = [];

    const spy: ShardSpy = {
        forwarded,
        namespace: {
            get: () => {
                return {
                    fetch: async (request: Request) => {
                        forwarded.push(request);

                        return spy.response();
                    },
                };
            },
            idFromName: (name: string) => {
                return { __name: name };
            },
        },
        response,
    };

    return spy;
};

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const rpc = (functionPath: string, headers: Record<string, string> = {}): Request =>
    new Request("https://app.test/_lunora/rpc", { body: JSON.stringify({ args: {}, functionPath }), headers, method: "POST" });

describe("origin → shard forwarded headers — the x402 paywall marker", () => {
    it("stamps the paywall marker when the worker carries a function registry", async () => {
        expect.assertions(2);

        const shard = createShardSpy();
        const worker = createWorker({
            allowUnauthenticatedShardAccess: true,
            functions: { "reports:latest": { kind: "query" } },
            shardDO: shard.namespace,
        });

        const response = await worker.fetch(rpc("reports:latest"), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(shard.forwarded[0]!.headers.get(ORIGIN_PAYWALL_HEADER)).toBe(ORIGIN_PAYWALL_APPLIED);
    });

    it("omits the marker when the worker was built with no registry, so the shard can refuse a paid call", async () => {
        expect.assertions(2);

        const shard = createShardSpy();
        // The `createLunoraHandler()` / hand-rolled `createWorker({ shardDO })`
        // shape: no `functions`, so the origin cannot read a `.x402` tag and never
        // makes a paywall decision at all.
        const worker = createWorker({ allowUnauthenticatedShardAccess: true, shardDO: shard.namespace });

        const response = await worker.fetch(rpc("billing:premiumReport"), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(shard.forwarded[0]!.headers.get(ORIGIN_PAYWALL_HEADER)).toBeNull();
    });

    it("never lets a caller forge the marker onto a registry-less worker", async () => {
        expect.assertions(1);

        const shard = createShardSpy();
        const worker = createWorker({ allowUnauthenticatedShardAccess: true, shardDO: shard.namespace });

        await worker.fetch(rpc("billing:premiumReport", { [ORIGIN_PAYWALL_HEADER]: ORIGIN_PAYWALL_APPLIED }), {}, fakeContext);

        expect(shard.forwarded[0]!.headers.get(ORIGIN_PAYWALL_HEADER)).toBeNull();
    });

    it("stamps the marker on a batch dispatch too", async () => {
        expect.assertions(1);

        const shard = createShardSpy(() => Response.json({ results: [] }));
        const worker = createWorker({
            allowUnauthenticatedShardAccess: true,
            functions: { "reports:latest": { kind: "query" } },
            shardDO: shard.namespace,
        });

        await worker.fetch(
            new Request("https://app.test/_lunora/rpc-batch", {
                body: JSON.stringify({ calls: [{ args: {}, functionPath: "reports:latest", id: 0 }] }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(shard.forwarded[0]!.headers.get(ORIGIN_PAYWALL_HEADER)).toBe(ORIGIN_PAYWALL_APPLIED);
    });
});

describe("origin → shard forwarded headers — the resolved client IP on a WebSocket upgrade", () => {
    afterEach(() => {
        Reflect.deleteProperty(globalThis, "navigator");
    });

    /** Pretend to be workerd, where `cf-connecting-ip` is stamped by the edge and cannot be typed by the caller. */
    const onCloudflareEdge = (): void => {
        Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Cloudflare-Workers" } });
    };

    it("carries the server-resolved client IP through the upgrade", async () => {
        expect.assertions(2);

        onCloudflareEdge();

        const shard = createShardSpy(() => new Response(null, { status: 101 }));
        const worker = createWorker({ allowUnauthenticatedShardAccess: true, shardDO: shard.namespace });

        await worker.fetch(
            new Request("https://app.test/_lunora/ws", { headers: { "cf-connecting-ip": "203.0.113.9", upgrade: "websocket" } }),
            {},
            fakeContext,
        );

        // `ctx.ip` is what a subscription's `rateLimit(…, { key: (ctx) => ctx.ip })`
        // buckets on; dropping it here pools every socket into one bucket while the
        // same query over `/_lunora/rpc` stays per-IP.
        expect(shard.forwarded).toHaveLength(1);
        expect(shard.forwarded[0]!.headers.get("x-lunora-client-ip")).toBe("203.0.113.9");
    });

    it("still strips a client-forged client IP from the upgrade", async () => {
        expect.assertions(1);

        const shard = createShardSpy(() => new Response(null, { status: 101 }));
        const worker = createWorker({ allowUnauthenticatedShardAccess: true, shardDO: shard.namespace });

        // Off the edge nothing overwrites the header, so the server resolves no IP
        // and the caller's own value must not survive.
        await worker.fetch(
            new Request("https://app.test/_lunora/ws", { headers: { upgrade: "websocket", "x-lunora-client-ip": "203.0.113.4" } }),
            {},
            fakeContext,
        );

        expect(shard.forwarded[0]!.headers.get("x-lunora-client-ip")).toBeNull();
    });
});
