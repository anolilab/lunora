import { installDeliveryFence } from "@lunora/do";
import { env, evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { DeliveryAuthorizationTestDO } from "./delivery-authorization-worker";
import { DELIVERY_TEST_SECRET } from "./delivery-authorization-worker";

type Stub = DurableObjectStub<DeliveryAuthorizationTestDO>;
interface Frame {
    cursor?: number;
    data?: unknown;
    error?: { code: string };
    id?: string;
    topic?: string;
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

const nextFrame = (socket: WebSocket, type: string, ignoreErrors = false): Promise<Frame> =>
    new Promise((resolve, reject) => {
        const listener = (event: MessageEvent) => {
            const frame = JSON.parse(String(event.data)) as Frame;
            if (frame.type === type) {
                socket.removeEventListener("message", listener);
                resolve(frame);
            } else if (frame.type === "error" && !ignoreErrors) {
                socket.removeEventListener("message", listener);
                reject(new Error(`Unexpected socket error: ${frame.error?.code ?? "unknown"}`));
            }
        };
        socket.addEventListener("message", listener);
    });

const refreshRetainedShapes = async (stub: Stub): Promise<void> => {
    await expect(rpc(stub, "shape-refresh")).resolves.toMatchObject({ status: 200 });
};
const pollRetainedShapes = async (stub: Stub): Promise<void> => {
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
};

const connectBarrier = async (socket: WebSocket): Promise<void> => {
    const connected = nextFrame(socket, "identity", true);
    socket.send(JSON.stringify({ type: "connect" }));
    await connected;
};
const leaveRoom = async (socket: WebSocket): Promise<void> => {
    socket.send(JSON.stringify({ type: "whisper_unsubscribe", topic: "room:fixture" }));
    // An ordinary subscription does not itself retire rooms, so this barrier cannot hide missed cleanup.
    const subscribed = nextFrame(socket, "data", true);
    socket.send(JSON.stringify({ type: "subscribe", id: "leave-barrier", query: { functionPath: "fixture:read", args: {} } }));
    await subscribed;
};
const closeRoom = async (socket: WebSocket): Promise<void> => {
    const closed = new Promise<void>((resolve) => {
        socket.addEventListener(
            "close",
            () => {
                resolve();
            },
            { once: true },
        );
    });
    socket.close(1000, "test close");
    await closed;
};

describe("delivery authorization on native workerd", () => {
    it("settles an unrelated CDC write on the actual socket without rerunning its query", async () => {
        expect.hasAssertions();

        const stub = env.AUTHORIZED.get(env.AUTHORIZED.idFromName("unrelated-native-settlement"));
        await stub.enableSettlementFixture();
        const upgrade = await stub.fetch("https://shard.internal/ws", { headers: { Upgrade: "websocket", "x-lunora-userid": "alice" } });
        const socket = requireSocket(upgrade.webSocket);
        socket.accept();
        try {
            const seeded = nextFrame(socket, "data");
            socket.send(JSON.stringify({ type: "subscribe", id: "view", query: { functionPath: "fixture:read", args: {} } }));

            await expect(seeded).resolves.toMatchObject({ id: "view", cursor: 0 });

            const frames: Frame[] = [];
            socket.addEventListener("message", (event: MessageEvent) => frames.push(JSON.parse(String(event.data)) as Frame));
            const result = await rpc(stub, "unrelated", false, "fixture:unrelated");
            const after = await stub.settlementSnapshot();

            expect(result.status).toBe(200);
            expect(result.body).toMatchObject({ commitCursor: 1 });
            expect(after).toEqual({ cursor: 1, queryCalls: 1, rows: 1 });

            // A later control reply is a wire-order barrier, independent of whether settlement was sent.
            await connectBarrier(socket);

            expect(frames.filter((frame) => frame.type === "settled")).toEqual([expect.objectContaining({ id: "view", cursor: after.cursor })]);
            expect(frames.filter((frame) => frame.type === "data" || frame.type === "delta")).toEqual([]);
        } finally {
            socket.close();
        }
    });

    it.each([
        { path: "unsubscribe", leave: leaveRoom },
        { path: "close", leave: closeRoom },
    ])("retires retained room memberships through $path after native hibernation", async ({ path, leave }) => {
        expect.hasAssertions();

        const stub = env.AUTHORIZED.get(env.AUTHORIZED.idFromName(`retained-rooms-${path}`));
        const upgrade = await stub.fetch("https://shard.internal/ws", { headers: { Upgrade: "websocket", "x-lunora-userid": "alice" } });
        const peerUpgrade = await stub.fetch("https://shard.internal/ws", { headers: { Upgrade: "websocket", "x-lunora-userid": "alice" } });
        const socket = requireSocket(upgrade.webSocket);
        const peer = requireSocket(peerUpgrade.webSocket);
        socket.accept();
        peer.accept();
        try {
            const seeded = nextFrame(peer, "data");
            const subscribe = JSON.stringify({ type: "subscribe", id: "view", query: { functionPath: "fixture:read", args: {} } });
            peer.send(subscribe);
            await seeded;
            await stub.retainRooms();

            await expect(stub.roomSnapshot()).resolves.toMatchObject({
                memberships: [
                    ["room:fixture", "presence"],
                    ["room:fixture", "presence"],
                ],
                events: [],
            });

            const before = await stub.snapshot();
            const frames: Frame[] = [];
            peer.addEventListener("message", (event: MessageEvent) => frames.push(JSON.parse(String(event.data)) as Frame));
            await evictDurableObject(stub, { webSockets: "hibernate" });
            await leave(socket);
            const room = await stub.roomSnapshot();

            expect(room.events).toEqual([]);
            expect(room.memberships.flat()).toEqual([]);

            const after = await stub.snapshot();

            expect(after.boot).not.toBe(before.boot);
            expect(after.attachments.some((attachment) => attachment.subscriptionIds.includes("view"))).toBe(true);

            await connectBarrier(peer);

            expect(frames.filter((frame) => frame.type === "error")).toEqual([
                expect.objectContaining({ topic: "room:fixture", error: { code: "NOT_IMPLEMENTED", message: expect.any(String) } }),
                expect.objectContaining({ topic: "presence", error: { code: "NOT_IMPLEMENTED", message: expect.any(String) } }),
            ]);
            expect(frames.filter((frame) => frame.type === "whisper")).toEqual([]);

            const reseeded = nextFrame(peer, "data");
            peer.send(subscribe);

            await expect(reseeded).resolves.toMatchObject({ id: "view", data: { value: "private" } });
        } finally {
            socket.close();
            peer.close();
        }
    });

    it.each([
        { path: "refresh", run: refreshRetainedShapes },
        { path: "alarm", run: pollRetainedShapes },
    ])("removes retained shapes through $path after native socket hibernation", async ({ path, run }) => {
        expect.hasAssertions();

        const stub = env.AUTHORIZED.get(env.AUTHORIZED.idFromName(`retained-shapes-${path}`));
        const upgrade = await stub.fetch("https://shard.internal/ws", { headers: { Upgrade: "websocket", "x-lunora-userid": "alice" } });
        const socket = requireSocket(upgrade.webSocket);
        socket.accept();
        try {
            const seeded = nextFrame(socket, "data");
            const subscribe = JSON.stringify({ type: "subscribe", id: "view", query: { functionPath: "fixture:read", args: {} } });
            socket.send(subscribe);

            await expect(seeded).resolves.toMatchObject({ id: "view", data: { value: "private" } });

            await stub.retainShapes();

            await expect(stub.shapeSnapshot()).resolves.toMatchObject({
                shapeIds: ["local", "global"],
                cursors: [{ sub_id: "local" }],
                snapshots: [{ sub_id: "global" }],
            });

            const before = await stub.snapshot();
            const received: Frame[] = [];
            const rejected = Promise.withResolvers<undefined>();
            socket.addEventListener("message", (event: MessageEvent) => {
                received.push(JSON.parse(String(event.data)) as Frame);
                if (received.filter((frame) => frame.type === "error").length === 2) {
                    rejected.resolve(undefined);
                }
            });
            await evictDurableObject(stub, { webSockets: "hibernate" });
            await run(stub);

            await expect(stub.shapeSnapshot()).resolves.toMatchObject({ shapeIds: [], cursors: [], snapshots: [], shapeReads: 0 });

            await rejected.promise;

            expect(received.filter((frame) => frame.type === "error")).toEqual([
                expect.objectContaining({ id: "local", error: { code: "NOT_IMPLEMENTED", message: expect.any(String) } }),
                expect.objectContaining({ id: "global", error: { code: "NOT_IMPLEMENTED", message: expect.any(String) } }),
            ]);

            const after = await stub.snapshot();

            expect(after.boot).not.toBe(before.boot);
            expect(after.attachments[0]?.subscriptionIds).toEqual(["view"]);

            // Consume a pre-existing alarm on the refresh path; cleanup must not re-arm it.
            await runDurableObjectAlarm(stub);
            const cleaned = await stub.shapeSnapshot();

            expect(cleaned.alarm).toBeNull();

            const reseeded = nextFrame(socket, "data");
            socket.send(subscribe);

            await expect(reseeded).resolves.toMatchObject({ id: "view", data: { value: "private" } });
            expect(received.some((frame) => frame.type.startsWith("poke"))).toBe(false);
        } finally {
            socket.close();
        }
    });

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
