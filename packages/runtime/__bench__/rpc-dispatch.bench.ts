import { bench, describe } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker.js";
import { createWorker } from "../src/create-worker.js";
import type { ShardNamespaceLike } from "../src/resolve-shard.js";

/**
 * `POST /_cirrus/rpc` is the hot path for every dispatched query/mutation.
 * The bench measures the worker.fetch chain from envelope parse →
 * resolveForwardContext → forwardToShard against an in-process shard stub
 * that returns instantly. What we're isolating is the orchestration cost
 * (header build, RPC re-emit, shard lookup, response stitch) — not the
 * handler runtime, which is the DO's domain.
 *
 *  - **no auth** — bare envelope, no `resolveIdentity`. The dispatch floor.
 *  - **+ resolveIdentity (userId only)** — adds the auth claim resolution
 *    pass that builds `x-cirrus-userid`. One extra await + header set.
 *  - **+ resolveIdentity (userId + claims)** — same path but with richer
 *    claims that JSON-encode into `x-cirrus-identity`.
 *  - **with shardKey** — envelope picks a specific shard rather than
 *    the default `__root__`. Same path; different shard lookup.
 */

const fakeCtx: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const makeShard = (): ShardNamespaceLike => {
    const stub = {
        fetch: async (_request: Request): Promise<Response> => Response.json({ result: { ok: true } }, { status: 200 }),
    };

    return {
        get: () => stub,
        getByName: () => stub,
        idFromName: (name) => ({ __name: name }),
    };
};

const buildRequest = (body: Record<string, unknown>): Request =>
    new Request("https://app.example/_cirrus/rpc", {
        body: JSON.stringify(body),
        method: "POST",
    });

const noAuthWorker = createWorker({ shardDO: makeShard() });
const useridWorker = createWorker({
    resolveIdentity: () => ({ userId: "user_42" }),
    shardDO: makeShard(),
});
const claimsWorker = createWorker({
    resolveIdentity: () => ({ email: "u@example.com", roles: ["admin"], userId: "user_42" }),
    shardDO: makeShard(),
});

const bareEnvelope = { args: { limit: 5 }, functionPath: "messages:list" };
const shardEnvelope = { args: { limit: 5 }, functionPath: "messages:list", shardKey: "channel-7" };

describe("worker.fetch — RPC dispatch through forwardToShard", () => {
    bench("no auth: bare envelope to __root__", async () => {
        await noAuthWorker.fetch(buildRequest(bareEnvelope), {}, fakeCtx);
    });

    bench("+ resolveIdentity (userId only)", async () => {
        await useridWorker.fetch(buildRequest(bareEnvelope), {}, fakeCtx);
    });

    bench("+ resolveIdentity (userId + claims → x-cirrus-identity)", async () => {
        await claimsWorker.fetch(buildRequest(bareEnvelope), {}, fakeCtx);
    });

    bench("with shardKey: explicit shard selection", async () => {
        await noAuthWorker.fetch(buildRequest(shardEnvelope), {}, fakeCtx);
    });
});
