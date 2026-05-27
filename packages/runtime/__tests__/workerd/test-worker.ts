/**
 * Test entry-point Worker for `@cirrus/runtime` integration tests.
 *
 * Boots a real worker built from the production `createWorker(...)` factory,
 * pointed at a tiny in-process `TestShardDO` that echoes the forwarded
 * envelope and selected headers back as JSON. This lets the workerd-based
 * suite verify the routing, header propagation, and error sanitization
 * paths end-to-end through a genuine Cloudflare runtime — not just through
 * a hand-rolled `ShardNamespaceLike` double.
 */
import { DurableObject } from "cloudflare:workers";

import { createWorker } from "../../src/create-worker.js";
import { CirrusError } from "../../src/errors.js";
import type { Route } from "../../src/create-worker.js";

export interface Env {
    SHARD: DurableObjectNamespace<TestShardDO>;
}

/**
 * Echo-style Durable Object: returns a JSON document describing exactly
 * what `createWorker` forwarded. Tests assert against this payload.
 */
export class TestShardDO extends DurableObject<Env> {
    public override async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        // Surface the inbound headers the runtime is supposed to propagate
        // so tests can verify the forwarding contract.
        const forwarded = {
            method: request.method,
            pathname: url.pathname,
            authorization: request.headers.get("authorization"),
            cookie: request.headers.get("cookie"),
            bookmark: request.headers.get("x-d1-bookmark"),
            body: request.method === "POST" ? await request.json().catch(() => null) : null,
        };

        // Allow the test to ask the DO to set an `x-d1-bookmark` response
        // header by encoding `?reply-bookmark=<value>` on the request URL.
        const replyBookmark = url.searchParams.get("reply-bookmark");
        const headers = new Headers({ "content-type": "application/json" });

        if (replyBookmark) {
            headers.set("x-d1-bookmark", replyBookmark);
        }

        return new Response(JSON.stringify(forwarded), { status: 200, headers });
    }
}

// Custom routes exercised by the workerd suite.
const healthzRoute: Route = () => new Response("ok", { status: 200 });
const echoMethodRoute: Route = (request) =>
    new Response(JSON.stringify({ method: request.method, path: new URL(request.url).pathname }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
const throwsCirrusRoute: Route = () => {
    throw new CirrusError("nope", { code: "FORBIDDEN", status: 403 });
};
const throwsGenericRoute: Route = () => {
    throw new Error("internal-detail-that-must-not-leak");
};

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const worker = createWorker({
            shardDO: {
                idFromName: (name) => env.SHARD.idFromName(name),
                get: (id) => env.SHARD.get(id as DurableObjectId),
            },
            routes: {
                "GET /healthz": healthzRoute,
                // Same path, different method — exercise the "METHOD path" key form.
                "POST /echo-method": echoMethodRoute,
                "/boom-cirrus": throwsCirrusRoute,
                "/boom-generic": throwsGenericRoute,
            },
        });

        return worker.fetch(request, env, ctx);
    },
};
