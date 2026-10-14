import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AstroWorkerHandler } from "../src/with-lunora";
import { withLunora } from "../src/with-lunora";

/**
 * Minimal structural fakes mirroring `packages/runtime/__tests__/create-worker.test.ts`.
 * `withLunora` is thin sugar over `composeWorker`, so the contract under test is
 * the *composition*: `/_lunora/*` routes into Lunora (forwarded to the shard),
 * non-reserved paths delegate to the wrapped Astro handler, and a throwing
 * Astro render is isolated as a 500 without taking down the realtime plane.
 */

interface ExecutionContextLike {
    passThroughOnException: () => void;
    waitUntil: (promise: Promise<unknown>) => void;
}

interface ShardSpy {
    calls: { request: Request; shardKey: string }[];
    namespace: never;
    response: Response;
}

/** Fake `ShardDO` namespace recording every forward; mirrors the runtime test. */
const createShardSpy = (response = new Response("ok", { status: 200 })): ShardSpy => {
    const calls: { request: Request; shardKey: string }[] = [];

    const spy = { calls, response } as unknown as ShardSpy;

    // The runtime resolves a stub via `idFromName(name)` → `get(id)` → `.fetch`.
    (spy as { namespace: unknown }).namespace = {
        get: (id: { shardName: string }) => {
            return {
                fetch: async (request: Request) => {
                    calls.push({ request, shardKey: id.shardName });

                    return spy.response;
                },
            };
        },
        idFromName: (name: string) => {
            return { shardName: name };
        },
    };

    return spy;
};

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

describe("withLunora — Astro class-B single-worker composition (PLAN4 §3)", () => {
    let shard: ShardSpy;

    beforeEach(() => {
        shard = createShardSpy();
    });

    it("routes /_lunora/rpc into Lunora rather than the Astro handler", async () => {
        expect.assertions(3);

        const astro = vi.fn<() => Response>(() => new Response("astro ssr"));

        const worker = withLunora({ fetch: astro }, { shardDO: shard.namespace });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(200);
        expect(astro).not.toHaveBeenCalled();
        expect(shard.calls).toHaveLength(1);
    });

    it("delegates a non-reserved path to the wrapped Astro SSR handler (object form)", async () => {
        expect.assertions(3);

        const worker = withLunora({ fetch: () => new Response("rendered", { status: 200 }) }, { shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/about"), {}, fakeContext);

        expect(res.status).toBe(200);
        await expect(res.text()).resolves.toBe("rendered");
        expect(shard.calls).toHaveLength(0);
    });

    it("accepts a bare fetch-function Astro handler and delegates to it", async () => {
        expect.assertions(2);

        const astro: AstroWorkerHandler = (request: Request) => new Response(`hit ${new URL(request.url).pathname}`, { status: 200 });

        const worker = withLunora(astro, { shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/blog/post"), {}, fakeContext);

        expect(res.status).toBe(200);
        await expect(res.text()).resolves.toBe("hit /blog/post");
    });

    it("forwards the realtime path to the shard with the envelope's shardKey", async () => {
        expect.assertions(2);

        // A client-named non-default shard is default-denied unless shard auth is
        // configured; opt in explicitly so the realtime path forwards (mirrors the
        // runtime create-worker suite).
        const worker = withLunora({ fetch: () => new Response("astro") }, { allowUnauthenticatedShardAccess: true, shardDO: shard.namespace });

        await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list", shardKey: "channel:demo" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(shard.calls).toHaveLength(1);
        expect(shard.calls[0]!.shardKey).toBe("channel:demo");
    });

    it("isolates a throwing Astro render as a 500 while /_lunora/* stays serviceable", async () => {
        expect.assertions(4);

        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        const worker = withLunora(
            {
                fetch: () => {
                    throw new Error("Astro render exploded");
                },
            },
            { shardDO: shard.namespace },
        );

        const ssrRes = await worker.fetch(new Request("https://app.example/boom"), {}, fakeContext);

        expect(ssrRes.status).toBe(500);
        await expect(ssrRes.text()).resolves.not.toContain("Astro render exploded");

        // The SAME worker still services realtime after the SSR throw.
        const rpcRes = await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(rpcRes.status).toBe(200);
        expect(shard.calls).toHaveLength(1);

        errorSpy.mockRestore();
    });
});
