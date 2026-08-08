import type { ExecutionContextLike } from "@lunora/runtime";
import { describe, expect, it, vi } from "vitest";

import { withLunora } from "../src/worker";

/**
 * A minimal fake of the parts of a `ShardDO` namespace `composeWorker` touches
 * when forwarding an RPC: `idFromName` mints an id carrying the shard key, and
 * `get(id).fetch` records the call and returns a canned `{ result }` response.
 *
 * This mirrors `packages/runtime/__tests__/create-worker.test.ts`'s `ShardSpy`,
 * pared down to what the SvelteKit composition test needs.
 */
const createShardSpy = () => {
    const calls: { shardKey: string }[] = [];

    const namespace = {
        get: (id: unknown) => {
            const shardKey = (id as { name: string }).name;

            return {
                fetch: async () => {
                    calls.push({ shardKey });

                    return Response.json({ result: { ok: true } });
                },
            };
        },
        idFromName: (name: string) => {
            return { name };
        },
    };

    // `composeWorker`/`createWorker` only call the two methods above; cast to the
    // structural `shardDO` shape so we needn't reconstruct the full DO namespace.
    return { calls, namespace: namespace as never };
};

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

/** Build an RPC request — the canonical reserved `/_lunora/*` realtime entry. */
const rpcRequest = (): Request =>
    new Request("https://app.example/_lunora/rpc", {
        body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
        method: "POST",
    });

describe("withLunora — SvelteKit single-worker composition (PLAN4 §3, class-B)", () => {
    it("delegates a non-reserved path to the wrapped SvelteKit handler", async () => {
        const shard = createShardSpy();
        const svelteKit = { fetch: vi.fn<() => Response>(() => new Response("rendered page", { status: 200 })) };

        const worker = withLunora(svelteKit, { shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/about"), {}, fakeContext);

        expect(res.status).toBe(200);
        await expect(res.text()).resolves.toBe("rendered page");
        // SvelteKit handled it; Lunora never forwarded to a shard.
        expect(svelteKit.fetch).toHaveBeenCalledTimes(1);
        expect(shard.calls).toHaveLength(0);
    });

    it("routes /_lunora/rpc into Lunora rather than the SvelteKit handler", async () => {
        const shard = createShardSpy();
        const svelteKit = { fetch: vi.fn<() => Response>(() => new Response("rendered page")) };

        const worker = withLunora(svelteKit, { shardDO: shard.namespace });

        const res = await worker.fetch(rpcRequest(), {}, fakeContext);

        expect(res.status).toBe(200);
        // The realtime endpoint hit the shard and never touched SvelteKit.
        expect(svelteKit.fetch).not.toHaveBeenCalled();
        expect(shard.calls).toHaveLength(1);
        expect(shard.calls[0]?.shardKey).toBe("__root__");
    });

    it("isolates a throwing SvelteKit handler so /_lunora/* stays serviceable", async () => {
        // Swallow the expected server-side error log from the deliberate throw.
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const shard = createShardSpy();
        const svelteKit = {
            fetch: vi.fn<() => Response>(() => {
                throw new Error("SvelteKit render exploded");
            }),
        };

        const worker = withLunora(svelteKit, { shardDO: shard.namespace });

        // A throwing SvelteKit render is contained at the seam: a plain 500 that
        // never echoes the raw message to the client.
        const pageRes = await worker.fetch(new Request("https://app.example/boom"), {}, fakeContext);

        expect(pageRes.status).toBe(500);
        await expect(pageRes.text()).resolves.not.toContain("SvelteKit render exploded");

        // The SAME worker still services realtime: a subsequent RPC succeeds.
        const rpcRes = await worker.fetch(rpcRequest(), {}, fakeContext);

        expect(rpcRes.status).toBe(200);
        expect(shard.calls).toHaveLength(1);

        errorSpy.mockRestore();
    });

    it("accepts a factory that derives Lunora options from the per-request env", async () => {
        const shard = createShardSpy();
        const svelteKit = { fetch: vi.fn<() => Response>(() => new Response("page")) };
        const optionsFactory = vi.fn<(env: unknown) => { shardDO: never }>((env) => {
            return { shardDO: (env as { SHARD: unknown }).SHARD as never };
        });

        const worker = withLunora(svelteKit, optionsFactory);

        const res = await worker.fetch(rpcRequest(), { SHARD: shard.namespace }, fakeContext);

        expect(res.status).toBe(200);
        // The factory was consulted with the request env and its SHARD binding
        // was the namespace the RPC forwarded to.
        expect(optionsFactory).toHaveBeenCalledWith({ SHARD: shard.namespace });
        expect(shard.calls).toHaveLength(1);
    });
});
