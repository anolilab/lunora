import type { ShardNamespaceLike } from "@lunora/runtime";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { lunora, mountLunora, withLunora } from "../src/index";

/**
 * A stub shard Durable Object namespace. The runtime resolves a shard via
 * `idFromName` → `get` and forwards the request to the stub's `fetch`, so a
 * single spy on `fetch` proves the request reached Lunora's realtime plane.
 * `respondWith` lets a test see what the worker returns to the client.
 */
const createShardStub = (respondWith: () => Response) => {
    const fetch = vi.fn(async () => respondWith());

    const namespace: ShardNamespaceLike = {
        get: () => {
            return { fetch };
        },
        idFromName: (name) => {
            return { name };
        },
    };

    return { fetch, namespace };
};

/** A minimal RPC envelope POST. No `cookie` header, so the CSRF/origin guard is exempt. */
const rpcRequest = (body?: Record<string, unknown>): Request =>
    new Request("https://app.example/_lunora/rpc", {
        body: JSON.stringify(body ?? { args: {}, functionPath: "messages:list" }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

describe(mountLunora, () => {
    it("returns the same Hono app it was given", () => {
        const app = new Hono();

        expect(mountLunora(app)).toBe(app);
    });

    it("forwards /_lunora/rpc to the shard from the default env.SHARD binding", async () => {
        const shard = createShardStub(() => Response.json({ result: ["a", "b"] }));
        const app = mountLunora(new Hono());

        const response = await app.fetch(rpcRequest(), { SHARD: shard.namespace });

        expect(shard.fetch).toHaveBeenCalledTimes(1);
        await expect(response.json()).resolves.toEqual({ result: ["a", "b"] });
    });

    it("lets non-/_lunora routes fall through to the Hono app", async () => {
        const shard = createShardStub(() => Response.json({ result: null }));
        const app = mountLunora(new Hono());

        app.get("/hello", (c) => c.text("hello from hono"));

        const response = await app.fetch(new Request("https://app.example/hello"), { SHARD: shard.namespace });

        expect(shard.fetch).not.toHaveBeenCalled();
        await expect(response.text()).resolves.toBe("hello from hono");
    });

    it("routes the /_lunora/ws upgrade to Lunora, not to the Hono fallthrough", async () => {
        const shard = createShardStub(() => new Response("ws", { status: 200 }));
        const app = mountLunora(new Hono());

        // A catch-all Hono route would answer everything NOT claimed by the mount.
        app.all("*", (c) => c.text("fallthrough", 418));

        const response = await app.fetch(new Request("https://app.example/_lunora/ws", { headers: { upgrade: "websocket" } }), {
            SHARD: shard.namespace,
        });

        expect(response.status).not.toBe(418);
    });

    it("uses an explicit shardDO option over env.SHARD", async () => {
        const envShard = createShardStub(() => Response.json({ from: "env" }));
        const optionShard = createShardStub(() => Response.json({ from: "option" }));
        const app = mountLunora(new Hono(), { shardDO: optionShard.namespace });

        await app.fetch(rpcRequest(), { SHARD: envShard.namespace });

        expect(optionShard.fetch).toHaveBeenCalledTimes(1);
        expect(envShard.fetch).not.toHaveBeenCalled();
    });

    it("accepts an (env) => options factory for per-request bindings", async () => {
        const shard = createShardStub(() => Response.json({ ok: true }));
        const app = mountLunora(new Hono(), (env) => {
            return { shardDO: (env as { CUSTOM: ShardNamespaceLike }).CUSTOM };
        });

        await app.fetch(rpcRequest(), { CUSTOM: shard.namespace });

        expect(shard.fetch).toHaveBeenCalledTimes(1);
    });

    it("surfaces a clear error when no shard namespace can be resolved", async () => {
        const app = mountLunora(new Hono());

        app.onError((error, c) => c.text(error.message, 500));

        const response = await app.fetch(rpcRequest(), {});

        expect(response.status).toBe(500);
        await expect(response.text()).resolves.toContain("no shard Durable Object namespace");
    });
});

describe("lunora middleware", () => {
    it("can be mounted by hand at a custom path", async () => {
        const shard = createShardStub(() => Response.json({ result: 1 }));
        const app = new Hono();

        app.use(
            "/_lunora/*",
            lunora((env) => {
                return { shardDO: (env as { SHARD: ShardNamespaceLike }).SHARD };
            }),
        );

        const response = await app.fetch(rpcRequest(), { SHARD: shard.namespace });

        expect(shard.fetch).toHaveBeenCalledTimes(1);
        await expect(response.json()).resolves.toEqual({ result: 1 });
    });
});

describe(withLunora, () => {
    it("re-exports the shared framework composer (Lunora owns the entry)", async () => {
        const shard = createShardStub(() => Response.json({ result: "via-compose" }));
        const honoApp = new Hono();

        honoApp.get("/page", (c) => c.text("ssr page"));

        const worker = withLunora(honoApp, () => {
            return { shardDO: shard.namespace };
        });

        // Reserved realtime path → Lunora.
        const rpc = await worker.fetch(rpcRequest(), { SHARD: shard.namespace }, { passThroughOnException: () => {}, waitUntil: () => {} });

        expect(shard.fetch).toHaveBeenCalledTimes(1);
        await expect(rpc.json()).resolves.toEqual({ result: "via-compose" });

        // Everything else → the Hono host.
        const page = await worker.fetch(
            new Request("https://app.example/page"),
            { SHARD: shard.namespace },
            { passThroughOnException: () => {}, waitUntil: () => {} },
        );

        await expect(page.text()).resolves.toBe("ssr page");
    });
});
