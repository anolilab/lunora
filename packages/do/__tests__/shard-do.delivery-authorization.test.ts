import { afterEach, describe, expect, it, vi } from "vitest";

import { installDeliveryFence } from "../src/delivery-authorization";
import type { ShardDOState } from "../src/shard-do";
import { cleanupDatabases, dataFrames, drain, gate, permit, secret, setup, TestShard } from "./_helpers/delivery-authorization";

describe("delivery authorization", () => {
    afterEach(cleanupDatabases);

    it("fences a seed paused inside its query without advancing its memo", async () => {
        expect.hasAssertions();

        const test = setup();
        const blocked = gate();

        test.shard.queryGate = blocked.promise;

        const seed = test.send();

        await test.shard.queryStarted.promise;

        test.revoke();

        const fenceResponse = await test.fence();

        expect(fenceResponse.status).toBe(204);

        blocked.resolve();
        await seed;

        expect(dataFrames(test.socket)).toEqual([]);
        expect(test.shard.observedIdentity).toMatchObject({ userId: "alice", identity: { subject: "alice" } });

        test.regrant();

        await test.send();

        expect(dataFrames(test.socket).map((frame) => frame.type)).toEqual(["data"]);
    });

    it("checks the fence after backpressure drains and keeps the last delivered baseline", async () => {
        expect.hasAssertions();

        const test = setup();

        await test.send();

        const entered = gate();
        const release = gate();
        drain.run = async () => {
            entered.resolve();
            await release.promise;
        };

        test.shard.rows = ["after"];

        const refresh = test.write();
        await entered.promise;

        test.revoke();

        await test.fence();

        release.resolve();
        const response = await refresh;

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "DELIVERY_FENCED" } });
        expect(dataFrames(test.socket).map((frame) => frame.data)).toEqual([["before"]]);

        test.regrant();

        await test.send();

        expect(dataFrames(test.socket).map((frame) => frame.type)).toEqual(["data", "data"]);
        expect(dataFrames(test.socket).at(-1)?.data).toEqual(["after"]);
    });

    it("reauthorizes old-cursor reconnect before query or cached resume, including a fresh instance", async () => {
        expect.hasAssertions();

        const test = setup();

        await test.send();

        test.revoke();

        await test.fence();

        test.socket.frames.length = 0;

        const woke = test.makeShard();

        await test.send(woke, 0);

        expect(woke.queryCalls).toBe(0);
        expect(dataFrames(test.socket)).toEqual([]);
        expect(test.socket.frames.at(-1)).toMatchObject({ type: "error", error: { code: "FORBIDDEN", message: "AccessDenied" } });
    });

    it("notifies an idle hibernated subscription immediately, retaining only its opaque marker", async () => {
        expect.hasAssertions();

        const test = setup();

        await test.send();

        expect(test.socket.attachment.deliveryPermits).toEqual({ view: permit(0) });

        test.socket.frames.length = 0;

        const woke = test.makeShard();

        await test.fence(woke);

        expect(test.socket.frames).toEqual([{ type: "error", id: "view", code: "FORBIDDEN", error: { code: "FORBIDDEN", message: "AccessDenied" } }]);
        expect(test.socket.attachment.subs).toEqual({});

        await woke.webSocketMessage(test.socket as unknown as WebSocket, JSON.stringify({ type: "unsubscribe", id: "view" }));

        expect(test.socket.attachment.deliveryPermits).toEqual({});
    });

    it("leaves unrelated scopes subscribed and rejects malformed fence epochs", async () => {
        expect.hasAssertions();

        const test = setup();

        test.authority.mockResolvedValue({ scope: "unrelated", epoch: 0 });

        await test.send();

        test.socket.frames.length = 0;

        await test.fence();

        expect(test.socket.frames).toEqual([]);

        const negativeEpochResponse = await test.fence(test.shard, -1);
        const fractionalEpochResponse = await test.fence(test.shard, 1.5);
        const unsafeEpochResponse = await test.fence(test.shard, Number.MAX_SAFE_INTEGER + 1);

        expect(negativeEpochResponse.status).toBe(400);
        expect(fractionalEpochResponse.status).toBe(400);
        expect(unsafeEpochResponse.status).toBe(400);
    });

    it("replaces an old-cursor cached value with a fresh authorized snapshot", async () => {
        expect.hasAssertions();

        const test = setup();

        await test.send();

        test.socket.frames.length = 0;

        test.regrant();

        const woke = test.makeShard();
        woke.rows = ["new-policy-visible"];

        await test.send(woke, 0);

        expect(dataFrames(test.socket).map((frame) => frame.type)).toEqual(["data"]);
        expect(dataFrames(test.socket).at(-1)?.data).toEqual(["new-policy-visible"]);
        expect(test.authority).toHaveBeenCalledTimes(2);
    });

    it("persists monotonic fences across construction and rejects stale authority permits", async () => {
        expect.hasAssertions();

        const test = setup();

        await test.fence(test.shard, 2);

        await test.fence(test.shard, 1);

        const woke = test.makeShard();

        await test.send(woke);

        expect(woke.queryCalls).toBe(0);
        expect(dataFrames(test.socket)).toEqual([]);
        expect(test.database.raw("SELECT epoch FROM __lunora_delivery_fence")).toEqual([{ epoch: 2 }]);
    });

    it("installs through the server-only signed binding helper and propagates rejection", async () => {
        expect.hasAssertions();

        const test = setup();
        await installDeliveryFence(
            { fetch: (url, init) => test.shard.fetch(new Request(url, init)) },
            {
                env: { LUNORA_RELAY_SECRET: secret },
                shardKey: undefined,
                fence: permit(4),
            },
        );

        expect(test.database.raw("SELECT epoch FROM __lunora_delivery_fence")).toEqual([{ epoch: 4 }]);
        await expect(
            installDeliveryFence(
                { fetch: async () => new Response(undefined, { status: 503 }) },
                {
                    env: { LUNORA_RELAY_SECRET: secret },
                    shardKey: undefined,
                    fence: permit(5),
                },
            ),
        ).rejects.toThrow("not acknowledged");
    });

    it("requires authenticated control requests and never installs an anonymous fence", async () => {
        expect.hasAssertions();

        const test = setup();

        const unsignedResponse = await test.fence(test.shard, 1, false);

        expect(unsignedResponse.status).toBe(403);

        await test.send();

        expect(dataFrames(test.socket)).toHaveLength(1);

        const noSecret = new TestShard(
            { acceptWebSocket() {}, getWebSockets: () => [], storage: { sql: test.database.sql as unknown as ShardDOState["storage"]["sql"] } },
            {},
            { deliveryAuthorization: test.authority },
        );

        const missingSecretResponse = await test.fence(noSecret);

        expect(missingSecretResponse.status).toBe(403);
    });

    it.each(["stream", "shape_subscribe", "whisper", "whisper_subscribe"])("refuses unsupported %s without invoking a query", async (type) => {
        expect.hasAssertions();

        const test = setup();

        await test.shard.webSocketMessage(test.socket as unknown as WebSocket, JSON.stringify({ type, id: "unsupported", functionPath: "messages:list" }));

        expect(test.shard.queryCalls).toBe(0);
        expect(test.socket.frames).toEqual([expect.objectContaining({ type: "error", code: "NOT_IMPLEMENTED" })]);
    });

    it("reauthorizes repeated RPC reads before any handler or receipt response", async () => {
        expect.hasAssertions();

        const test = setup();
        const rpc = vi.spyOn(test.shard, "handleRpc");

        const first = await test.write("same-operation");
        const replay = await test.write("same-operation");

        expect(first.status).toBe(200);
        expect(replay.status).toBe(200);

        test.revoke();

        const denied = await test.write("same-operation");

        expect(denied.status).toBe(403);
        expect(rpc).toHaveBeenCalledTimes(1);

        test.regrant();

        const recovered = await test.write("same-operation");

        expect(recovered.status).toBe(409);
        await expect(recovered.json()).resolves.toMatchObject({ error: { code: "DELIVERY_RECEIPT_FENCED" } });
        expect(rpc).toHaveBeenCalledTimes(1);
    });
});
