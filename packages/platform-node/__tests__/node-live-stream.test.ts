import { ShardDO } from "@lunora/do";
import { createWorker } from "@lunora/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { LIVE_CONNECT_PATH, LIVE_CONTROL_PATH } from "../../../shared/live-stream";
import { createNodeHttpServer } from "../src/node-http-server";
import { createNodeShardNamespace } from "../src/node-shard-namespace";
import type { NodeShard } from "../src/node-shard-registry";
import { createNodeShardRegistry } from "../src/node-shard-registry";
import { createNodeShardState } from "../src/node-shard-state";

/**
 * A node app serving a live topic stream end to end, through the same HTTP
 * context path `defineLiveStream` takes: `ctx.fetchShard` reaches the real
 * `ShardDO` through the node shard registry, `ctx.live.publish` publishes into
 * it, and the SSE response is streamed back over a real HTTP listener.
 *
 * `@lunora/server` is not a dependency of this package, so the app's routes are
 * written against the injected `__lunoraCtx` directly. That is the object
 * `defineLiveStream`'s `connect` and `control` handlers call into.
 */

/** The `ShardDO` subclass codegen would emit; only the dispatch table is stubbed. */
class LiveTestShardDO extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- a dispatch stub has no instance state to reach for
    public handleRpc(functionPath: string): Promise<unknown> {
        return Promise.resolve({ functionPath });
    }
}

/** The slice of the injected HTTP context these routes use. */
interface LiveHttpContext {
    fetchShard: (shardKey: string | undefined, path: string, init?: { body?: string; method?: string }) => Promise<Response>;
    live: { publish: (topic: { __lunoraLive: string; topic: string }, payload: unknown) => Promise<void> };
}

const ctx = { passThroughOnException: () => undefined, waitUntil: () => undefined };

const startApp = async () => {
    // One ShardDO per shard, kept for the life of the process: a ShardDO built per
    // request would lose its `liveSubscribers` between connect and publish.
    const shardDos = new WeakMap<NodeShard, LiveTestShardDO>();
    const shardDoFor = (shard: NodeShard): LiveTestShardDO => {
        const existing = shardDos.get(shard);

        if (existing !== undefined) {
            return existing;
        }

        const created = new LiveTestShardDO(createNodeShardState(shard) as never, {});

        shardDos.set(shard, created);

        return created;
    };

    const registry = createNodeShardRegistry({ onFetch: (request, shard) => shardDoFor(shard).fetch(request) });
    const worker = createWorker({
        httpRouter: {
            fetch: async (request: Request, env: { __lunoraCtx: LiveHttpContext }): Promise<Response> => {
                const lunora = env.__lunoraCtx;
                const { pathname } = new URL(request.url);

                if (pathname === "/live/feed/connect" && request.method === "GET") {
                    return lunora.fetchShard(undefined, LIVE_CONNECT_PATH, { method: "GET" });
                }

                if (pathname === "/live/feed/control" && request.method === "POST") {
                    const body: Record<string, unknown> = await request.json();

                    return lunora.fetchShard(undefined, LIVE_CONTROL_PATH, { body: JSON.stringify({ ...body, stream: "feed" }), method: "POST" });
                }

                if (pathname === "/news/publish" && request.method === "POST") {
                    const body: { data: unknown; topic: string } = await request.json();

                    await lunora.live.publish({ __lunoraLive: "feed", topic: body.topic }, body.data);

                    return Response.json({ published: true });
                }

                return new Response("not found", { status: 404 });
            },
        },
        shardDO: createNodeShardNamespace(registry.directory),
    });

    const server = await createNodeHttpServer({
        fetch: (request) => worker.fetch(request, {}, ctx),
    });

    return { close: () => server.close(), origin: server.origin, registry };
};

describe("live topic streams on the node host", () => {
    let app: Awaited<ReturnType<typeof startApp>> | undefined;

    afterEach(async () => {
        await app?.close();
        app?.registry.close();
        app = undefined;
    });

    it("streams a published frame to the subscriber over SSE", async () => {
        expect.assertions(6);

        app = await startApp();

        const connect = await fetch(`${app.origin}/live/feed/connect`);

        expect(connect.status).toBe(200);
        expect(connect.headers.get("content-type")).toContain("text/event-stream");

        const connectionId = connect.headers.get("x-lunora-live-connection");

        expect(connectionId).toMatch(/^[0-9a-f-]{36}$/u);

        const reader = connect.body!.getReader();
        const decoder = new TextDecoder();
        let received = "";

        const subscribe = await fetch(`${app.origin}/live/feed/control`, {
            body: JSON.stringify({ action: "subscribe", connectionId, subscriptionId: "s1", topic: "news" }),
            headers: { "content-type": "application/json" },
            method: "POST",
        });

        expect(subscribe.status).toBe(200);

        const published = await fetch(`${app.origin}/news/publish`, {
            body: JSON.stringify({ data: { headline: "hi" }, topic: "news" }),
            headers: { "content-type": "application/json" },
            method: "POST",
        });

        expect(published.status).toBe(200);

        while (!received.includes("headline")) {
            // eslint-disable-next-line no-await-in-loop -- each frame is read before the next is awaited
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            received += decoder.decode(value, { stream: true });
        }

        expect(received).toContain('event: live\ndata: {"topic":"news","data":{"headline":"hi"}}');

        await reader.cancel();
    });
});
