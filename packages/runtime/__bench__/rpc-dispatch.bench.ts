import { bench, describe } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

/**
 * `POST /_lunora/rpc` is the hot path for every dispatched query/mutation.
 * The bench measures the worker.fetch chain from envelope parse →
 * resolveForwardContext → forwardToShard against an in-process shard stub
 * that returns instantly. What we're isolating is the orchestration cost
 * (header build, RPC re-emit, shard lookup, response stitch) — not the
 * handler runtime, which is the DO's domain.
 *
 * - **no auth** — bare envelope, no `resolveIdentity`. The dispatch floor.
 * - **+ resolveIdentity (userId only)** — adds the auth claim resolution
 * pass that builds `x-lunora-userid`. One extra await + header set.
 * - **+ resolveIdentity (userId + claims)** — same path but with richer
 * claims that JSON-encode into `x-lunora-identity`.
 * - **with shardKey** — envelope picks a specific shard rather than
 * the default `__root__`. Same path; different shard lookup.
 */

const fakeContext: ExecutionContextLike = {
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
        idFromName: (name) => {
            return { __name: name };
        },
    };
};

const buildRequest = (body: Record<string, unknown>): Request =>
    new Request("https://app.example/_lunora/rpc", {
        body: JSON.stringify(body),
        method: "POST",
    });

const noAuthWorker = createWorker({ shardDO: makeShard() });
const useridWorker = createWorker({
    resolveIdentity: () => {
        return { userId: "user_42" };
    },
    shardDO: makeShard(),
});
const claimsWorker = createWorker({
    resolveIdentity: () => {
        return { email: "u@example.com", roles: ["admin"], userId: "user_42" };
    },
    shardDO: makeShard(),
});

const bareEnvelope = { args: { limit: 5 }, functionPath: "messages:list" };
const shardEnvelope = { args: { limit: 5 }, functionPath: "messages:list", shardKey: "channel-7" };

describe("worker.fetch — RPC dispatch through forwardToShard", () => {
    bench("no auth: bare envelope to __root__", async () => {
        await noAuthWorker.fetch(buildRequest(bareEnvelope), {}, fakeContext);
    });

    bench("+ resolveIdentity (userId only)", async () => {
        await useridWorker.fetch(buildRequest(bareEnvelope), {}, fakeContext);
    });

    bench("+ resolveIdentity (userId + claims → x-lunora-identity)", async () => {
        await claimsWorker.fetch(buildRequest(bareEnvelope), {}, fakeContext);
    });

    bench("with shardKey: explicit shard selection", async () => {
        await noAuthWorker.fetch(buildRequest(shardEnvelope), {}, fakeContext);
    });
});
