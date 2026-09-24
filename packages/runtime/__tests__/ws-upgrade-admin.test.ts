import { describe, expect, it } from "vitest";

import { mintWsAdminToken } from "../../../shared/ws-admin-token";
import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const ADMIN_TOKEN = "admin-bear";
const WS_URL = "https://app.example/_lunora/ws";

/**
 * A shard namespace whose stub records what it is forwarded, so a test can tell
 * "forwarded" from "refused at the worker". The real DO answers an upgrade with
 * `101`, which `undici`'s `Response` constructor refuses to build — the stub
 * stands in with `200`, and it is the recorded forward, not the status, that
 * proves the request crossed the gate.
 */
const recordingShard = (): { calls: string[]; namespace: ShardNamespaceLike } => {
    const calls: string[] = [];

    const stub = {
        fetch: async (request: Request): Promise<Response> => {
            calls.push(new URL(request.url).pathname);

            return new Response("upgraded", { status: 200 });
        },
    };

    return {
        calls,
        namespace: {
            get: () => stub,
            idFromName: (name) => {
                return { __name: name };
            },
        },
    };
};

/**
 * `authorizeShard` is documented as a gate on END USERS that the reserved admin
 * surface is exempt from — so the gate the docs recommend
 * (`({ identity }) => identity?.userId !== undefined`) must not shut the
 * studio's live admin panels, which upgrade with an admin credential and
 * therefore resolve to a `null` identity.
 */
describe("createWorker — the app WS upgrade exempts admin from authorizeShard", () => {
    const denyEveryUser = { authorizeShard: (): boolean => false };

    it("forwards an ephemeral-token upgrade through a deny-all authorizeShard", async () => {
        expect.assertions(2);

        const { calls, namespace } = recordingShard();
        const worker = createWorker({ ...denyEveryUser, adminToken: ADMIN_TOKEN, shardDO: namespace });
        const minted = await mintWsAdminToken(ADMIN_TOKEN);

        const response = await worker.fetch(
            new Request(`${WS_URL}?token=${encodeURIComponent(minted.token)}`, { headers: { Upgrade: "websocket" } }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        expect(calls).toStrictEqual(["/_lunora/ws"]);
    });

    it("forwards a master-bearer upgrade through a deny-all authorizeShard", async () => {
        expect.assertions(1);

        const { namespace } = recordingShard();
        const worker = createWorker({ ...denyEveryUser, adminToken: ADMIN_TOKEN, shardDO: namespace });

        const response = await worker.fetch(
            new Request(WS_URL, { headers: { authorization: `Bearer ${ADMIN_TOKEN}`, Upgrade: "websocket" } }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
    });

    it("forwards an admin upgrade naming a non-default shard when no authorizeShard is configured", async () => {
        expect.assertions(1);

        const { namespace } = recordingShard();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: namespace });
        const minted = await mintWsAdminToken(ADMIN_TOKEN);

        const response = await worker.fetch(
            new Request(`${WS_URL}?shard=tenant-7&token=${encodeURIComponent(minted.token)}`, { headers: { Upgrade: "websocket" } }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
    });

    it("still refuses an upgrade carrying no admin credential under the same gate (403)", async () => {
        expect.assertions(2);

        const { calls, namespace } = recordingShard();
        const worker = createWorker({ ...denyEveryUser, adminToken: ADMIN_TOKEN, shardDO: namespace });

        const response = await worker.fetch(new Request(WS_URL, { headers: { Upgrade: "websocket" } }), {}, fakeContext);

        expect(response.status).toBe(403);
        expect(calls).toStrictEqual([]);
    });

    it("still refuses a reserved relay/replica shard name to an admin upgrade (403)", async () => {
        expect.assertions(2);

        const { calls, namespace } = recordingShard();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: namespace });
        const minted = await mintWsAdminToken(ADMIN_TOKEN);

        const response = await worker.fetch(
            new Request(`${WS_URL}?shard=tenant-7::relay::0&token=${encodeURIComponent(minted.token)}`, { headers: { Upgrade: "websocket" } }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(403);
        expect(calls).toStrictEqual([]);
    });

    it("still refuses a raw master token in ?token= while ephemeral enforcement is on (403)", async () => {
        expect.assertions(1);

        const { namespace } = recordingShard();
        const worker = createWorker({ ...denyEveryUser, adminToken: ADMIN_TOKEN, shardDO: namespace });

        const response = await worker.fetch(
            new Request(`${WS_URL}?token=${encodeURIComponent(ADMIN_TOKEN)}`, { headers: { Upgrade: "websocket" } }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(403);
    });
});

/**
 * The ORDINARY socket — no admin credential anywhere — must reach the shard on
 * exactly the terms it did before the admin exemption existed. The exemption is
 * an early return threaded through `assertShardAuthorized`, so the risk it
 * introduces is not that admin gets in: it is that the guard order moved and a
 * normal socket now meets a branch it never used to.
 *
 * These pin the three shapes an app can be in — no gate, a gate that allows, a
 * gate that denies — against the playground's own configuration: a worker with
 * `LUNORA_ADMIN_TOKEN` set (so the admin predicate actually runs rather than
 * short-circuiting on an absent token) and a browser upgrade that carries no
 * `Authorization` header, which is the only thing a real WS handshake can do.
 */
describe("createWorker — the app WS upgrade leaves the non-admin path untouched", () => {
    it("forwards an ordinary upgrade when no authorizeShard is configured", async () => {
        expect.assertions(2);

        const { calls, namespace } = recordingShard();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: namespace });

        const response = await worker.fetch(new Request(WS_URL, { headers: { Upgrade: "websocket" } }), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(calls).toStrictEqual(["/_lunora/ws"]);
    });

    it("forwards an ordinary upgrade carrying a session token in ?token= (not an admin sub-token)", async () => {
        expect.assertions(2);

        const { calls, namespace } = recordingShard();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: namespace });

        // The client puts its auth token in `?token=` — the same slot the admin
        // sub-token uses. An end user's token must not read as an admin
        // credential, and must not be refused for failing to be one either.
        const response = await worker.fetch(
            new Request(`${WS_URL}?token=${encodeURIComponent("a-users-session-token")}`, { headers: { Upgrade: "websocket" } }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        expect(calls).toStrictEqual(["/_lunora/ws"]);
    });

    it("consults authorizeShard for an ordinary upgrade, with the caller's identity and shard", async () => {
        expect.assertions(3);

        const seen: { identity: unknown; shardKey: string }[] = [];
        const { calls, namespace } = recordingShard();
        const worker = createWorker({
            authorizeShard: ({ identity, shardKey }) => {
                seen.push({ identity, shardKey });

                return true;
            },
            adminToken: ADMIN_TOKEN,
            shardDO: namespace,
        });

        const response = await worker.fetch(new Request(WS_URL, { headers: { Upgrade: "websocket" } }), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(calls).toStrictEqual(["/_lunora/ws"]);
        // Consulted exactly once, for the default shard — the gate is neither
        // skipped nor run twice for a caller with no admin credential.
        expect(seen).toStrictEqual([{ identity: null, shardKey: "__root__" }]);
    });

    it("default-denies an ordinary upgrade naming a non-default shard with no authorizeShard (403)", async () => {
        expect.assertions(2);

        const { calls, namespace } = recordingShard();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: namespace });

        const response = await worker.fetch(new Request(`${WS_URL}?shard=tenant-7`, { headers: { Upgrade: "websocket" } }), {}, fakeContext);

        expect(response.status).toBe(403);
        expect(calls).toStrictEqual([]);
    });

    it("forwards an ordinary non-default shard once allowUnauthenticatedShardAccess is opted into", async () => {
        expect.assertions(1);

        const { namespace } = recordingShard();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, allowUnauthenticatedShardAccess: true, shardDO: namespace });

        const response = await worker.fetch(new Request(`${WS_URL}?shard=tenant-7`, { headers: { Upgrade: "websocket" } }), {}, fakeContext);

        expect(response.status).toBe(200);
    });
});
