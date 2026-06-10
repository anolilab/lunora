import type { ShardNamespaceLike } from "@cirrus/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike, NitroCloudflareHandler, ScheduledControllerLike } from "../src/worker";
import { withCirrus } from "../src/worker";

/** The `scheduled` hook shape a Nitro host may carry (the object arm of the handler union). */
type NitroScheduled = (controller: ScheduledControllerLike, env: unknown, context: ExecutionContextLike) => Promise<void> | void;

/**
 * Records every shard forward and lets a test override the stub response — the
 * minimal `ShardNamespaceLike` the runtime's RPC path needs, with no Durable
 * Object behind it. Mirrors the `createShardSpy` helper in
 * `packages/runtime/__tests__/create-worker.test.ts`.
 */
interface ShardSpy {
    calls: { request: Request; shardKey: string }[];
    namespace: ShardNamespaceLike;
}

const createShardSpy = (response = new Response("ok", { status: 200 })): ShardSpy => {
    const calls: { request: Request; shardKey: string }[] = [];

    const namespace: ShardNamespaceLike = {
        get: (id) => {
            // Bracket access — this package's eslint config has no underscore
            // allow-list, and `__name` is the synthetic id marker the fake stamps.
            const shardKey = (id as Record<"__name", string>)["__name"];

            return {
                fetch: async (request: Request) => {
                    calls.push({ request, shardKey });

                    return response;
                },
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };

    return { calls, namespace };
};

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

/**
 * A stand-in for Nitro's emitted Cloudflare handler: a `{ fetch }` whose render
 * is a vi.fn so tests can assert it was (or was not) reached, plus an optional
 * `scheduled`. No Nitro, no network — pure in-memory.
 */
const createNitroHandler = (
    fetchImpl: (request: Request) => Response | Promise<Response>,
    scheduled?: NitroScheduled,
): { handler: NitroCloudflareHandler; spy: ReturnType<typeof vi.fn> } => {
    const spy = vi.fn<(request: Request) => Response | Promise<Response>>(fetchImpl);

    return { handler: { fetch: spy, scheduled }, spy };
};

describe("withCirrus — Nuxt single-worker composition (PLAN4 §3, M4)", () => {
    let shard: ShardSpy;

    beforeEach(() => {
        shard = createShardSpy();
    });

    it("routes /_cirrus/rpc into Cirrus rather than the Nitro handler", async () => {
        expect.assertions(3);

        const nitro = createNitroHandler(() => new Response("ssr"));

        const worker = withCirrus(nitro.handler, { shardDO: shard.namespace });

        const res = await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", { body: JSON.stringify({ args: {}, functionPath: "x:y" }), method: "POST" }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(200);
        expect(nitro.spy).not.toHaveBeenCalled();
        expect(shard.calls).toHaveLength(1);
    });

    it("delegates a non-reserved path to the wrapped Nitro handler", async () => {
        expect.assertions(3);

        const nitro = createNitroHandler(() => new Response("rendered", { status: 200 }));

        const worker = withCirrus(nitro.handler, { shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/about"), {}, fakeContext);

        expect(res.status).toBe(200);
        await expect(res.text()).resolves.toBe("rendered");
        expect(shard.calls).toHaveLength(0);
    });

    it("isolates a throwing Nitro handler so /_cirrus/* stays serviceable", async () => {
        expect.assertions(4);

        // Swallow the expected server-side log from the deliberate throw.
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        const nitro = createNitroHandler(() => {
            throw new Error("Nitro SSR exploded");
        });

        const worker = withCirrus(nitro.handler, { shardDO: shard.namespace });

        // A throwing Nitro render is contained at the seam and surfaced as a 500 —
        // never echoing the raw message.
        const ssrRes = await worker.fetch(new Request("https://app.example/boom"), {}, fakeContext);

        expect(ssrRes.status).toBe(500);
        await expect(ssrRes.text()).resolves.not.toContain("Nitro SSR exploded");

        // The SAME worker still services realtime: a /_cirrus/rpc request forwards
        // to the shard and succeeds.
        const rpcRes = await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", { body: JSON.stringify({ args: {}, functionPath: "x:y" }), method: "POST" }),
            {},
            fakeContext,
        );

        expect(rpcRes.status).toBe(200);
        expect(shard.calls).toHaveLength(1);

        errorSpy.mockRestore();
    });

    it("forwards cron triggers to Cirrus when crons are configured", async () => {
        expect.assertions(2);

        const cron = vi.fn<() => void>();
        const nitroScheduled = vi.fn<() => void>();
        const nitro = createNitroHandler(() => new Response("ssr"), nitroScheduled);

        const worker = withCirrus(nitro.handler, {
            crons: { "0 * * * *": cron },
            shardDO: shard.namespace,
        });

        await worker.scheduled({ cron: "0 * * * *", scheduledTime: 0 }, {}, fakeContext);

        expect(cron).toHaveBeenCalledTimes(1);
        // Cirrus crons win — Nitro's own scheduled is not invoked.
        expect(nitroScheduled).not.toHaveBeenCalled();
    });

    it("preserves Nitro's scheduled when no Cirrus crons are wired", async () => {
        expect.assertions(1);

        const nitroScheduled = vi.fn<() => void>();
        const nitro = createNitroHandler(() => new Response("ssr"), nitroScheduled);

        const worker = withCirrus(nitro.handler, { shardDO: shard.namespace });

        await worker.scheduled({ cron: "0 * * * *", scheduledTime: 0 }, {}, fakeContext);

        expect(nitroScheduled).toHaveBeenCalledTimes(1);
    });
});
