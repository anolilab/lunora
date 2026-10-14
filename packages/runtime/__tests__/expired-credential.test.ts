/**
 * A resolved identity whose `exp` / `expiresAtMs` has already passed must be
 * refused over HTTP with `TOKEN_EXPIRED` / 401 — the same code the shard drops
 * an expired socket with — and never reach the shard. A client can only tell
 * "refresh and re-send" from "this call was refused" by that code.
 */
import { describe, expect, it } from "vitest";

import type { ExecutionContextLike, ResolvedIdentity } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import { LunoraError } from "../src/errors";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

/** A shard double that records every request it is handed. */
const createShardSpy = (): { namespace: ShardNamespaceLike; seen: Request[] } => {
    const seen: Request[] = [];

    return {
        namespace: {
            get: () => {
                return {
                    fetch: (request: Request) => {
                        seen.push(request);

                        return Promise.resolve(Response.json({ result: { ok: true } }));
                    },
                };
            },
            idFromName: (name) => name,
        },
        seen,
    };
};

const rpc = (): Request =>
    new Request("https://app.example/_lunora/rpc", {
        body: JSON.stringify({ args: {}, functionPath: "messages:send" }),
        headers: { authorization: "Bearer stale" },
        method: "POST",
    });

const workerResolving = (identity: ResolvedIdentity) => {
    const shard = createShardSpy();
    const worker = createWorker({ resolveIdentity: () => identity, shardDO: shard.namespace });

    return { seen: shard.seen, worker };
};

const PAST_SECONDS = Math.floor(Date.now() / 1000) - 60;
const FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

describe("lapsed credential over HTTP", () => {
    it("refuses an RPC whose identity `exp` has passed with 401 TOKEN_EXPIRED and never runs it", async () => {
        expect.assertions(3);

        const { seen, worker } = workerResolving({ exp: PAST_SECONDS, userId: "user_42" });
        const response = await worker.fetch(rpc(), {}, fakeContext);
        const body: { error: { code: string } } = await response.json();

        expect(response.status).toBe(401);
        expect(body.error.code).toBe("TOKEN_EXPIRED");
        expect(seen).toHaveLength(0);
    });

    it("refuses an RPC whose identity `expiresAtMs` has passed", async () => {
        expect.assertions(3);

        const { seen, worker } = workerResolving({ expiresAtMs: Date.now() - 1000, userId: "user_42" });
        const response = await worker.fetch(rpc(), {}, fakeContext);
        const body: { error: { code: string } } = await response.json();

        expect(response.status).toBe(401);
        expect(body.error.code).toBe("TOKEN_EXPIRED");
        expect(seen).toHaveLength(0);
    });

    it("runs an RPC whose identity expires in the future", async () => {
        expect.assertions(3);

        const { seen, worker } = workerResolving({ exp: FUTURE_SECONDS, userId: "user_42" });
        const response = await worker.fetch(rpc(), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.headers.get("x-lunora-userid")).toBe("user_42");
    });

    it("runs an RPC whose identity declares no expiry", async () => {
        expect.assertions(2);

        const { seen, worker } = workerResolving({ userId: "user_42" });
        const response = await worker.fetch(rpc(), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(seen).toHaveLength(1);
    });

    it("refuses a batch RPC under a lapsed identity", async () => {
        expect.assertions(3);

        const { seen, worker } = workerResolving({ exp: PAST_SECONDS, userId: "user_42" });
        const response = await worker.fetch(
            new Request("https://app.example/_lunora/rpc-batch", {
                body: JSON.stringify({ calls: [{ args: {}, functionPath: "messages:send" }] }),
                method: "POST",
            }),
            {},
            fakeContext,
        );
        const body: { error: { code: string } } = await response.json();

        expect(response.status).toBe(401);
        expect(body.error.code).toBe("TOKEN_EXPIRED");
        expect(seen).toHaveLength(0);
    });

    it("refuses `serverQuery` under a lapsed identity, as the HTTP route does", async () => {
        expect.assertions(3);

        const { seen, worker } = workerResolving({ exp: PAST_SECONDS, userId: "user_42" });
        const response = await worker.serverQuery(new Request("https://app.example/page"), {}, { __lunoraRef: "messages:list" }, {});
        const body: { error: { code: string } } = await response.json();

        expect(response.status).toBe(401);
        expect(body.error.code).toBe("TOKEN_EXPIRED");
        expect(seen).toHaveLength(0);
    });

    it("answers a resolver that throws TOKEN_EXPIRED with that code, not an anonymous run", async () => {
        expect.assertions(3);

        const shard = createShardSpy();
        const worker = createWorker({
            resolveIdentity: () => {
                throw new LunoraError("token expired", { code: "TOKEN_EXPIRED", status: 401 });
            },
            shardDO: shard.namespace,
        });
        const response = await worker.fetch(rpc(), {}, fakeContext);
        const body: { error: { code: string } } = await response.json();

        expect(response.status).toBe(401);
        expect(body.error.code).toBe("TOKEN_EXPIRED");
        expect(shard.seen).toHaveLength(0);
    });

    it("still forwards a WebSocket upgrade under a lapsed identity, for the shard to drop with 4001", async () => {
        expect.assertions(2);

        const shard = createShardSpy();
        const worker = createWorker({
            allowUnauthenticatedShardAccess: true,
            resolveIdentity: () => {
                return { exp: PAST_SECONDS, userId: "user_42" };
            },
            shardDO: shard.namespace,
        });

        await worker.fetch(new Request("https://app.example/_lunora/ws", { headers: { Upgrade: "websocket" } }), {}, fakeContext);

        expect(shard.seen).toHaveLength(1);
        expect(shard.seen[0]?.headers.get("x-lunora-identity-exp")).toBe(String(PAST_SECONDS * 1000));
    });

    it("reads a lapsed identity as anonymous in an `httpRouter` handler rather than refusing the page", async () => {
        expect.assertions(2);

        const shard = createShardSpy();
        let seenUserId: null | string | undefined;
        const worker = createWorker({
            httpRouter: {
                fetch: (_request, env) => {
                    seenUserId = (env as { __lunoraCtx: { auth: { userId: null | string } } }).__lunoraCtx.auth.userId;

                    return new Response("page");
                },
            },
            resolveIdentity: () => {
                return { exp: PAST_SECONDS, userId: "user_42" };
            },
            shardDO: shard.namespace,
        });

        const response = await worker.fetch(new Request("https://app.example/dashboard"), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(seenUserId).toBeNull();
    });
});
