import { encodeWire } from "@lunora/wire";
import { afterEach, describe, expect, it } from "vitest";

import { installDeliveryFence } from "../src/delivery-authorization";
import { ROOT_SHARD_NAME } from "../src/shard-do";
import { cleanupDatabases, gate, permit, secret, setup, TestShard } from "./_helpers/delivery-authorization";

const batch = (paths: string[]) =>
    new Request("https://shard.internal/rpc-batch", {
        method: "POST",
        headers: { "x-lunora-userid": "alice" },
        body: JSON.stringify({
            calls: paths.map((functionPath, id) => {
                return { id, functionPath, args: {}, mutationId: `operation-${String(id)}` };
            }),
        }),
    });

describe("delivery-authorized transports", () => {
    afterEach(cleanupDatabases);

    it("dispatches and fences each batch slot without rejecting the whole batch", async () => {
        expect.hasAssertions();

        const test = setup();

        test.authority.mockImplementation(async ({ functionPath }) => (functionPath === "messages:denied" ? undefined : permit(0)));

        const response = await test.shard.fetch(batch(["messages:write", "messages:denied"]));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            results: [
                { id: 0, status: 200, body: { result: { result: "receipt-payload" } } },
                { id: 1, status: 403, body: { error: { code: "FORBIDDEN" } } },
            ],
        });
        expect(test.shard.rpcRuns).toBe(1);
        expect(test.authority).toHaveBeenCalledTimes(2);
    });

    it("rechecks an earlier batch slot after a later entry awaits", async () => {
        expect.hasAssertions();

        const test = setup();
        const release = gate();

        test.shard.rpcGate = release.promise;

        test.authority.mockImplementation(async ({ functionPath }) => (functionPath === "messages:slow" ? { scope: "other", epoch: 0 } : permit(0)));

        const pending = test.shard.fetch(batch(["messages:write", "messages:slow"]));

        await test.shard.rpcStarted.promise;

        await test.fence();

        release.resolve();
        const response = await pending;

        await expect(response.json()).resolves.toMatchObject({
            results: [
                { id: 0, status: 409, body: { error: { code: "DELIVERY_FENCED" } } },
                { id: 1, status: 200, body: { result: { result: "receipt-payload" } } },
            ],
        });
    });

    it("passes decoded wire arguments to both subscription and RPC authorization", async () => {
        expect.hasAssertions();

        const test = setup();
        const args = { count: 9n, bytes: new Uint8Array([1, 2]).buffer };
        const encoded = encodeWire(args);

        await test.shard.fetch(
            new Request("https://shard.internal/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "messages:list", args: encoded }),
            }),
        );

        await test.shard.webSocketMessage(
            test.socket as unknown as WebSocket,
            JSON.stringify({
                type: "subscribe",
                id: "wire",
                query: { functionPath: "messages:list", args: encoded },
            }),
        );

        expect(test.authority.mock.calls.map(([request]) => request.args)).toEqual([args, args]);
    });

    it("keeps the private fence route absent when authorization is disabled", async () => {
        expect.hasAssertions();

        const test = setup();
        const unguarded = new TestShard(test.state, {});
        const response = await unguarded.fetch(
            new Request("https://shard.internal/_lunora/delivery-fence", {
                method: "POST",
                body: "{}",
                headers: { "x-lunora-shard-binding": "LEGACY_SHARD" },
            }),
        );

        expect(response.status).toBe(404);
        expect(unguarded).toMatchObject({ shardBinding: "LEGACY_SHARD" });
    });

    it("reports an authority outage as retryable instead of access denial", async () => {
        expect.hasAssertions();

        const test = setup();

        test.authority.mockRejectedValue(new Error("authority unavailable"));

        const response = await test.write();

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({ error: { code: "SHARD_UNAVAILABLE", message: "delivery authority unavailable" } });
        expect(test.shard.rpcRuns).toBe(0);
    });

    it.each([ROOT_SHARD_NAME, "tenant:folder-1"])("binds named shard %s control requests to the exact host name", async (name) => {
        expect.hasAssertions();

        const test = setup(name);

        await test.send();

        expect(test.authority.mock.calls[0]?.[0].shardKey).toBe(name);
        await expect(
            installDeliveryFence(
                { fetch: (url, init) => test.shard.fetch(new Request(url, init)) },
                {
                    env: { LUNORA_RELAY_SECRET: secret },
                    shardKey: `${name}:other`,
                    fence: permit(1),
                },
            ),
        ).rejects.toThrow("400");

        const fenceResponse = await test.fence();

        expect(fenceResponse.status).toBe(204);
        expect(test.socket.attachment.subs).toEqual({});
    });
});
