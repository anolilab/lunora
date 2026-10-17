import { installDeliveryFence } from "@lunora/do";
import { env, evictDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { DeliveryAuthorizationTestDO } from "./delivery-authorization-worker";
import { DELIVERY_TEST_SECRET } from "./delivery-authorization-worker";

type Stub = DurableObjectStub<DeliveryAuthorizationTestDO>;
interface Frame {
    data?: unknown;
    error?: { code: string };
    id?: string;
    type: string;
}

const rpc = async (stub: Stub, mutationId: string, fail = false, functionPath = "fixture:write") => {
    const response = await stub.fetch("https://shard.internal/rpc", {
        method: "POST",
        headers: { "x-lunora-userid": "alice", "x-lunora-mutation-id": mutationId },
        body: JSON.stringify({ functionPath, args: { fail } }),
    });
    // Eviction waits for pending response bodies, so consume every response before returning.
    return { status: response.status, body: await response.json() };
};

const install = (stub: Stub, shardKey: string, epoch: number) =>
    installDeliveryFence(stub, {
        env: { LUNORA_RELAY_SECRET: DELIVERY_TEST_SECRET },
        shardKey,
        fence: { scope: "fixture-scope", epoch },
    });

const requireSocket = (socket: WebSocket | null): WebSocket => {
    if (!socket) {
        throw new Error("Missing upgraded socket");
    }
    return socket;
};

const nextFrame = (socket: WebSocket, type: string): Promise<Frame> =>
    new Promise((resolve, reject) => {
        const listener = (event: MessageEvent) => {
            const frame = JSON.parse(String(event.data)) as Frame;
            if (frame.type === type) {
                socket.removeEventListener("message", listener);
                resolve(frame);
            } else if (frame.type === "error") {
                socket.removeEventListener("message", listener);
                reject(new Error(`Unexpected socket error: ${frame.error?.code ?? "unknown"}`));
            }
        };
        socket.addEventListener("message", listener);
    });

describe("delivery authorization on native workerd", () => {
    it("fences unmarked ungated result bytes after authority persistence fails", async () => {
        expect.hasAssertions();

        const name = "delivery-action-marker-failure";
        const stub = env.AUTHORIZED.get(env.AUTHORIZED.idFromName(name));
        await install(stub, name, 0);
        await stub.rejectEpochZeroMarker();

        await expect(rpc(stub, "action", false, "fixture:action")).resolves.toMatchObject({ status: 500 });
        await expect(stub.snapshot()).resolves.toMatchObject({ attempts: 1, permits: [] });

        const failed = await stub.snapshot();

        expect(failed.receipts).toHaveLength(1);

        await stub.setPolicy(1);

        await expect(rpc(stub, "action", false, "fixture:action")).resolves.toMatchObject({
            status: 409,
            body: { error: { code: "DELIVERY_RECEIPT_FENCED" } },
        });

        const recovered = await stub.snapshot();

        expect(recovered.attempts).toBe(1);
        expect(recovered.receipts).toHaveLength(1);
        expect(recovered.permits).toEqual([]);
    });

    it.each(["old-marker", "new-row"] as const)("never certifies old bytes when %s fails before the other ungated run completes", async (failure) => {
        expect.hasAssertions();

        const name = `delivery-${failure}-fails-before-other-completion`;
        const stub = env.AUTHORIZED.get(env.AUTHORIZED.idFromName(name));
        await install(stub, name, 0);
        await (failure === "old-marker" ? stub.rejectEpochZeroMarker() : stub.rejectEpochOneRow());
        await stub.parkActions();
        let now = Date.now();
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        try {
            const oldRun = rpc(stub, "overlap", false, "fixture:action");
            await stub.waitForAction(0);
            // Advance beyond the fifteen-minute dispatch claim without sleeping.
            now += 15 * 60 * 1000 + 1;
            await stub.setPolicy(1);
            const newRun = rpc(stub, "overlap", false, "fixture:action");
            await stub.waitForAction(1);
            const failingEpoch = failure === "old-marker" ? 0 : 1;
            await stub.releaseAction(failingEpoch);

            await expect(failingEpoch === 0 ? oldRun : newRun).resolves.toMatchObject({ status: 500 });

            await stub.releaseAction(1 - failingEpoch);

            await expect(failingEpoch === 0 ? newRun : oldRun).resolves.toMatchObject({ status: 200 });
            await expect(rpc(stub, "overlap", false, "fixture:action")).resolves.toMatchObject({
                status: 409,
                body: { error: { code: "DELIVERY_RECEIPT_FENCED" } },
            });
            await expect(stub.snapshot()).resolves.toMatchObject({
                attempts: 2,
                receipts: [expect.objectContaining({ result_json: '{"epoch":0}' })],
                permits: failure === "old-marker" ? [] : [{ epoch: 0, scope: "fixture-scope" }],
            });
        } finally {
            await stub.releaseAction(0);
            await stub.releaseAction(1);
            clock.mockRestore();
        }
    });

    it("atomically commits receipt authority and rejects its replay after an epoch change and eviction", async () => {
        expect.hasAssertions();

        const name = "delivery-atomic-receipt";
        const stub = env.AUTHORIZED.get(env.AUTHORIZED.idFromName(name));

        await expect(rpc(stub, "rollback", true)).resolves.toMatchObject({ status: 500 });
        await expect(stub.snapshot()).resolves.toMatchObject({ attempts: 1, runs: 0, receipts: [], permits: [] });
        await expect(rpc(stub, "success")).resolves.toMatchObject({ status: 200, body: { result: { runs: 1 } } });
        await expect(rpc(stub, "success")).resolves.toMatchObject({ status: 200, body: { result: { runs: 1 } } });

        const committed = await stub.snapshot();

        expect(committed.attempts).toBe(2);
        expect(committed.receipts).toHaveLength(1);
        expect(committed.permits).toEqual([expect.objectContaining({ scope: "fixture-scope", epoch: 0 })]);

        await install(stub, name, 1);
        await install(stub, name, 0);
        await stub.setPolicy(1);

        await expect(rpc(stub, "success")).resolves.toMatchObject({ status: 409, body: { error: { code: "DELIVERY_RECEIPT_FENCED" } } });
        await expect(stub.snapshot()).resolves.toMatchObject({ attempts: 2 });

        await evictDurableObject(stub);
        const woke = await stub.snapshot();

        expect(woke.boot).not.toBe(committed.boot);
        expect(woke).toMatchObject({
            attempts: 0,
            runs: 1,
            receipts: committed.receipts,
            permits: committed.permits,
            fences: [{ scope: "fixture-scope", epoch: 1 }],
        });
        await expect(rpc(stub, "success")).resolves.toMatchObject({ status: 403 });

        await stub.setPolicy(1);

        await expect(rpc(stub, "success")).resolves.toMatchObject({ status: 409, body: { error: { code: "DELIVERY_RECEIPT_FENCED" } } });
        await expect(stub.snapshot()).resolves.toMatchObject({ attempts: 0, runs: 1 });
    });

    it("uses the hibernated socket marker to revoke delivery when a signed fence wakes the host", async () => {
        expect.hasAssertions();

        const name = "delivery-hibernated-socket";
        const stub = env.AUTHORIZED.get(env.AUTHORIZED.idFromName(name));
        const upgrade = await stub.fetch("https://shard.internal/ws", { headers: { Upgrade: "websocket", "x-lunora-userid": "alice" } });
        const socket = requireSocket(upgrade.webSocket);

        expect(upgrade.status).toBe(101);

        socket.accept();
        try {
            const seeded = nextFrame(socket, "data");
            socket.send(JSON.stringify({ type: "subscribe", id: "view", query: { functionPath: "fixture:read", args: {} } }));

            await expect(seeded).resolves.toEqual({ type: "data", id: "view", data: { value: "private" } });

            const before = await stub.snapshot();

            expect(before.attachments[0]?.deliveryPermits.view).toEqual({ scope: "fixture-scope", epoch: 0 });

            const unsigned = await stub.fetch("https://shard.internal/_lunora/delivery-fence", {
                method: "POST",
                body: JSON.stringify({ type: "delivery-fence", shardKey: name, fence: { scope: "fixture-scope", epoch: 1 } }),
            });

            expect(unsigned.status).toBe(403);

            await unsigned.text();
            await evictDurableObject(stub, { webSockets: "hibernate" });
            const revoked = nextFrame(socket, "error");
            await install(stub, name, 1);

            await expect(revoked).resolves.toMatchObject({ id: "view", error: { code: "FORBIDDEN" } });

            const after = await stub.snapshot();

            expect(after.boot).not.toBe(before.boot);
            expect(after.attachments[0]?.subscriptionIds).toEqual([]);
            expect(after.fences).toEqual([{ scope: "fixture-scope", epoch: 1 }]);
        } finally {
            socket.close();
        }
    });
});
