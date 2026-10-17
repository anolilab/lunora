import { ShardDO } from "@lunora/do";
import { createWorker } from "@lunora/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { createNodeHttpServer } from "../src/node-http-server";
import { createNodeShardNamespace } from "../src/node-shard-namespace";
import type { NodeShard } from "../src/node-shard-registry";
import { createNodeShardRegistry } from "../src/node-shard-registry";
import { createNodeShardState } from "../src/node-shard-state";

/**
 * A node app serving a live topic stream end to end: the worker's routes reach
 * the real `ShardDO` through the node shard registry, and the SSE response is
 * streamed back over a real HTTP listener.
 *
 * The app's `defineLiveStream` is stood in for by two routes that do what its
 * `connect` and `control` handlers do (forward to `/_lunora/live/*` on the
 * root shard), because `@lunora/server` is not a dependency of this package.
 */

/** The `ShardDO` subclass codegen would emit; only the dispatch table is stubbed. */
class LiveTestShardDO extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- a dispatch stub has no instance state to reach for
    public handleRpc(functionPath: string): Promise<unknown> {
        return Promise.resolve({ functionPath });
    }
}

const ctx = { passThroughOnException: () => undefined, waitUntil: () => undefined };

const startApp = async () => {
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
    const namespace = createNodeShardNamespace(registry.directory);
    const rootShard = (request: Request, path: string, init: RequestInit = {}): Promise<Response> =>
        registry.directory.getByName("__root__").fetch(new Request(new URL(path, request.url), init));

    const worker = createWorker({
        routes: {
            "GET /live/feed/connect": (request) => rootShard(request, "/_lunora/live/connect", { method: "GET" }),
            "POST /live/feed/control": (request) =>
                request.json().then((body: Record<string, unknown>) =>
                    rootShard(request, "/_lunora/live/control", {
                        body: JSON.stringify({ ...body, stream: "feed" }),
                        headers: { "content-type": "application/json" },
                        method: "POST",
                    }),
                ),
            "POST /live/feed/publish": (request) =>
                request.json().then((body: Record<string, unknown>) =>
                    rootShard(request, "/_lunora/live/publish", {
                        body: JSON.stringify({ ...body, stream: "feed" }),
                        headers: { "content-type": "application/json" },
                        method: "POST",
                    }),
                ),
        },
        shardDO: namespace,
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
        expect.assertions(5);

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

        await fetch(`${app.origin}/live/feed/publish`, {
            body: JSON.stringify({ data: { headline: "hi" }, topic: "news" }),
            headers: { "content-type": "application/json" },
            method: "POST",
        });

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
