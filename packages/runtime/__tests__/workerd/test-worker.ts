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

import type { Route } from "../../src/create-worker.js";
import { createWorker } from "../../src/create-worker.js";
import { CirrusError } from "../../src/errors.js";

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
            authorization: request.headers.get("authorization"),
            body: request.method === "POST" ? await request.json().catch(() => null) : null,
            bookmark: request.headers.get("x-d1-bookmark"),
            cookie: request.headers.get("cookie"),
            method: request.method,
            pathname: url.pathname,
        };

        // Allow the test to ask the DO to set an `x-d1-bookmark` response
        // header by encoding `?reply-bookmark=<value>` on the request URL.
        const replyBookmark = url.searchParams.get("reply-bookmark");
        const headers = new Headers({ "content-type": "application/json" });

        if (replyBookmark) {
            headers.set("x-d1-bookmark", replyBookmark);
        }

        return Response.json(forwarded, { headers, status: 200 });
    }
}

// Custom routes exercised by the workerd suite.
const healthzRoute: Route = () => new Response("ok", { status: 200 });
const echoMethodRoute: Route = (request) =>
    Response.json(
        { method: request.method, path: new URL(request.url).pathname },
        {
            headers: { "content-type": "application/json" },
            status: 200,
        },
    );
const throwsCirrusRoute: Route = () => {
    throw new CirrusError("nope", { code: "FORBIDDEN", status: 403 });
};
const throwsGenericRoute: Route = () => {
    throw new Error("internal-detail-that-must-not-leak");
};

export default {
    async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
        const worker = createWorker({
            routes: {
                "/boom-cirrus": throwsCirrusRoute,
                "/boom-generic": throwsGenericRoute,
                "GET /healthz": healthzRoute,
                // Same path, different method — exercise the "METHOD path" key form.
                "POST /echo-method": echoMethodRoute,
            },
            shardDO: {
                get: (id) => env.SHARD.get(id as DurableObjectId),
                idFromName: (name) => env.SHARD.idFromName(name),
            },
        });

        return worker.fetch(request, env, context);
    },
};
