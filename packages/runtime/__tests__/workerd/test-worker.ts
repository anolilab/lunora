/// <reference types="@cloudflare/workers-types" />
// This file drives a REAL worker in workerd, so it needs Cloudflare's ambient
// globals. The reference lives here rather than in the package's tsconfig
// `types` array because `src/` is platform-neutral (plan 114 §5.1 rates this
// package none/light) — making the whole package ambient-Cloudflare would let a
// `DurableObjectNamespace` reference slip into shipped code and still compile.

/**
 * Test entry-point Worker for `@lunora/runtime` integration tests.
 *
 * Boots a real worker built from the production `createWorker(...)` factory,
 * pointed at a tiny in-process `TestShardDO` that echoes the forwarded
 * envelope and selected headers back as JSON. This lets the workerd-based
 * suite verify the routing, header propagation, and error sanitization
 * paths end-to-end through a genuine Cloudflare runtime — not just through
 * a hand-rolled `ShardNamespaceLike` double.
 */
import { DurableObject } from "cloudflare:workers";

import type { Route, ScheduledControllerLike } from "../../src/create-worker";
import { createWorker } from "../../src/create-worker";
import { LunoraError } from "../../src/errors";
import type { QueryCoordinator } from "../../src/query-coordinator";

interface Env {
    BACKUPS: R2Bucket;
    SHARD: DurableObjectNamespace<TestShardDO>;
}

/** The cron the test worker's built-in backup is wired to (mirrors `triggers.crons`). */
const BACKUP_CRON = "0 3 * * *";

/**
 * Coordinator stub whose `orchestrateExport` returns two canned rows so the
 * scheduled backup has something to stream into R2. The rest of the surface is
 * unused by the backup path.
 */
const backupCoordinator = {
    orchestrateExport: async () => {
        return {
            failed: 0,
            ok: 1,
            shards: [
                {
                    rows: [
                        { doc: { _id: "u1", email: "a@b.com" }, table: "users" },
                        { doc: { _id: "u2", email: "c@d.com" }, table: "users" },
                    ],
                    shardKey: "__root__",
                },
            ],
        };
    },
} as unknown as QueryCoordinator;

/**
 * Echo-style Durable Object: returns a JSON document describing exactly
 * what `createWorker` forwarded. Tests assert against this payload.
 */
class TestShardDO extends DurableObject<Env> {
    // eslint-disable-next-line class-methods-use-this -- echo DO override; the handler reads only the inbound request, not instance state
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
const throwsLunoraRoute: Route = () => {
    throw new LunoraError("nope", { code: "FORBIDDEN", status: 403 });
};
const throwsGenericRoute: Route = () => {
    throw new Error("internal-detail-that-must-not-leak");
};

const buildTestWorker = (env: Env): ReturnType<typeof createWorker> =>
    createWorker({
        // Authenticates the per-shard export gate the scheduled backup fans out to.
        adminToken: "test-admin",
        // Built-in backup → real R2 binding, exercised by the `scheduled()` test.
        backupCron: BACKUP_CRON,
        backupStore: env.BACKUPS,
        queryCoordinator: backupCoordinator,
        routes: {
            "/boom-lunora": throwsLunoraRoute,
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

const handler = {
    async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
        return buildTestWorker(env).fetch(request, env, context);
    },
    async scheduled(controller: ScheduledControllerLike, env: Env, context: ExecutionContext): Promise<void> {
        await buildTestWorker(env).scheduled(controller, env, context);
    },
};

export type { Env };
export { TestShardDO };
export default handler;
