/**
 * The socket re-auth route verifies a refreshed credential with the worker's own
 * resolver and forwards only the server-minted identity to the shard — never the
 * token, and never a header the caller set.
 */
import { describe, expect, it } from "vitest";

import type { ExecutionContextLike, ResolvedIdentity } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const workerResolving = (identity: ResolvedIdentity | null) => {
    const seen: { request: Request; shard: string }[] = [];
    const namespace: ShardNamespaceLike = {
        get: (id) => {
            return {
                fetch: (request: Request) => {
                    seen.push({ request, shard: String(id) });

                    return Promise.resolve(Response.json({ ok: true }));
                },
            };
        },
        idFromName: (name) => name,
    };
    const worker = createWorker({ allowUnauthenticatedShardAccess: true, resolveIdentity: () => identity, shardDO: namespace });

    return { namespace, seen, worker };
};

const reauth = (headers: Record<string, string> = {}, query = ""): Request =>
    new Request(`https://app.example/_lunora/ws/reauth${query}`, {
        body: JSON.stringify({ connectionId: "conn-1" }),
        headers: { authorization: "Bearer fresh", "content-type": "application/json", ...headers },
        method: "POST",
    });

const FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

describe("socket re-auth route", () => {
    it("forwards the verified identity and the connection id to the named shard", async () => {
        expect.assertions(7);

        const { namespace, seen, worker } = workerResolving({ exp: FUTURE_SECONDS, role: "member", userId: "user_42" });
        const response = await worker.fetch(reauth({}, "?shard=room-1"), { SHARD: namespace }, fakeContext);
        const forwarded = seen[0]?.request;

        expect(response.status).toBe(200);
        expect(seen[0]?.shard).toBe("room-1");
        expect(new URL(forwarded?.url ?? "").pathname).toBe("/_lunora/ws/reauth");
        expect(forwarded?.headers.get("x-lunora-userid")).toBe("user_42");
        expect(forwarded?.headers.get("x-lunora-identity-exp")).toBe(String(FUTURE_SECONDS * 1000));
        // An owner woken by the call can reach the relay holding the socket.
        expect(forwarded?.headers.get("x-lunora-shard-binding")).toBe("SHARD");
        // The shard never sees the credential itself.
        expect(forwarded?.headers.get("authorization")).toBeNull();
    });

    it("drops identity headers the caller forged", async () => {
        expect.assertions(2);

        const { seen, worker } = workerResolving({ userId: "user_42" });

        await worker.fetch(
            reauth({ "x-lunora-identity": '{"role":"admin"}', "x-lunora-identity-exp": "99999999999999", "x-lunora-userid": "victim" }),
            {},
            fakeContext,
        );

        expect(seen[0]?.request.headers.get("x-lunora-userid")).toBe("user_42");
        expect(seen[0]?.request.headers.get("x-lunora-identity-exp")).toBeNull();
    });

    it("refuses an expired credential with TOKEN_EXPIRED before reaching the shard", async () => {
        expect.assertions(3);

        const { seen, worker } = workerResolving({ exp: Math.floor(Date.now() / 1000) - 60, userId: "user_42" });
        const response = await worker.fetch(reauth(), {}, fakeContext);

        expect(response.status).toBe(401);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("TOKEN_EXPIRED");
        expect(seen).toHaveLength(0);
    });

    it("refuses a credential the resolver does not accept", async () => {
        expect.assertions(2);

        const { seen, worker } = workerResolving(null);
        const response = await worker.fetch(reauth(), {}, fakeContext);

        expect(response.status).toBe(401);
        expect(seen).toHaveLength(0);
    });

    it("answers a null body with 400 and forwards nothing", async () => {
        expect.assertions(2);

        const { namespace, seen, worker } = workerResolving({ exp: FUTURE_SECONDS, userId: "user_42" });
        const response = await worker.fetch(
            new Request("https://app.example/_lunora/ws/reauth", {
                body: "null",
                headers: { authorization: "Bearer fresh", "content-type": "application/json" },
                method: "POST",
            }),
            { SHARD: namespace },
            fakeContext,
        );

        expect(response.status).toBe(400);
        expect(seen).toHaveLength(0);
    });
});
