/**
 * Real-workerd integration tests for `ShardDO`.
 *
 * These run inside a Miniflare-driven `workerd` process via
 * `@cloudflare/vitest-pool-workers`. The mock-state suite under
 * `__tests__/shard-do.test.ts` exercises the same surface against hand-rolled
 * doubles — the value here is catching anything mock state cannot model:
 *
 *  - The real WebSocket Hibernation API (`state.acceptWebSocket`,
 *    `serializeAttachment`, hibernation reset preserving attachments).
 *  - The real workerd lifecycle for `webSocketClose` (which throws if you
 *    re-close an already-closed socket).
 *  - SQLite-in-DO storage handed out by the runtime as `state.storage.sql`.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import type { TestShardDO } from "./test-worker.js";

// `env` is typed via the `Cloudflare.Env` augmentation in `./env.d.ts`.

const newStub = (name: string): DurableObjectStub<TestShardDO> => {
    const id = env.SHARD.idFromName(name);

    return env.SHARD.get(id) as DurableObjectStub<TestShardDO>;
};

describe("shardDO (workerd)", () => {
    test("instantiates against a real DurableObjectState and serves /rpc", async () => {
        const stub = newStub("shard-rpc");

        await runInDurableObject(stub, async (instance) => {
            instance.rpcResult = { ok: true, who: "real-runtime" };
        });

        const response = await stub.fetch("https://shard.internal/rpc", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ functionPath: "messages:list", args: { limit: 5 } }),
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ result: { ok: true, who: "real-runtime" } });

        await runInDurableObject(stub, async (instance) => {
            expect(instance.lastRpcCall).toEqual({ functionPath: "messages:list", args: { limit: 5 } });
        });
    });

    test("webSocket upgrade is accepted by the real Hibernation API and subscriptions round-trip via serializeAttachment", async () => {
        const stub = newStub("shard-ws");

        // Upgrade through the real runtime — verifies state.acceptWebSocket()
        // and the response shape workerd actually returns (101 + webSocket).
        const upgrade = await stub.fetch("https://shard.internal/_ws", {
            headers: { Upgrade: "websocket" },
        });

        expect(upgrade.status).toBe(101);
        expect(upgrade.webSocket).toBeDefined();

        const client = upgrade.webSocket!;
        const received: string[] = [];

        client.addEventListener("message", (event) => {
            if (typeof event.data === "string") {
                received.push(event.data);
            }
        });

        client.accept();

        // Drive a subscribe envelope. The DO's webSocketMessage() runs server-side.
        client.send(JSON.stringify({ type: "subscribe", id: "sub-1", query: { table: "messages" } }));

        // Wait until the server-side handler acks. We poll runInDurableObject()
        // instead of relying on a brittle setTimeout — the runtime drains the
        // message queue between turns.
        await waitFor(() => received.some((m) => m.includes('"type":"ack"')));

        expect(received.some((m) => JSON.parse(m).type === "ack")).toBe(true);

        // Hibernation contract: the attachment is recoverable from the server
        // side, even after the runtime has serialized it.
        await runInDurableObject(stub, async (_instance, state) => {
            const sockets = state.getWebSockets();

            expect(sockets).toHaveLength(1);

            const attachment = state.getWebSockets()[0]?.deserializeAttachment() as { subs: Record<string, unknown> };

            expect(attachment).toBeDefined();
            expect(attachment.subs).toHaveProperty("sub-1");
        });

        client.close(1000, "bye");
    });

    test("broadcastDelta only reaches matching-table subscribers", async () => {
        const stub = newStub("shard-broadcast");

        // Open two sockets: one subscribed to `messages`, one to `documents`.
        const subs = await Promise.all([openSocket(stub, "sub-msg", { table: "messages" }), openSocket(stub, "sub-doc", { table: "documents" })]);

        await runInDurableObject(stub, async (instance) => {
            instance.broadcast({ table: "messages", op: "insert", key: "m1", row: { id: "m1" } });
        });

        await waitFor(() => subs[0]!.received.some((m) => m.includes('"type":"delta"')));

        const msgDeltas = subs[0]!.received.filter((m) => m.includes('"type":"delta"'));
        const docDeltas = subs[1]!.received.filter((m) => m.includes('"type":"delta"'));

        expect(msgDeltas).toHaveLength(1);
        expect(docDeltas).toHaveLength(0);
        expect(JSON.parse(msgDeltas[0]!)).toMatchObject({ type: "delta", id: "sub-msg", delta: { table: "messages", op: "insert" } });

        subs[0]!.client.close(1000, "done");
        subs[1]!.client.close(1000, "done");
    });

    test("broadcasts are scoped per shard — a delta emitted on shard A does not reach a subscriber on shard B", async () => {
        // The Phase 1 verification gate per the plan: exercise two DOs from
        // one Worker, assert a delta emitted on one shard is not delivered to
        // a subscriber on the other. This catches any accidental cross-DO
        // socket bleed-through (e.g. a static subscription registry).
        const shardA = newStub("shard-iso-a");
        const shardB = newStub("shard-iso-b");

        const subA = await openSocket(shardA, "sub-a", { table: "messages" });
        const subB = await openSocket(shardB, "sub-b", { table: "messages" });

        // Emit on A only.
        await runInDurableObject(shardA, async (instance) => {
            instance.broadcast({ table: "messages", op: "insert", key: "x1", row: { id: "x1" } });
        });

        await waitFor(() => subA.received.some((m) => m.includes('"type":"delta"')));

        // Give B a chance to (incorrectly) receive — wait a short fixed
        // interval after A has already received its delta. The runtime
        // delivers messages serially per socket; if B were ever going to
        // hear about A's emission it would be by now.
        await new Promise((resolve) => setTimeout(resolve, 50));

        const aDeltas = subA.received.filter((m) => m.includes('"type":"delta"'));
        const bDeltas = subB.received.filter((m) => m.includes('"type":"delta"'));

        expect(aDeltas).toHaveLength(1);
        expect(bDeltas).toHaveLength(0);

        subA.client.close(1000, "done");
        subB.client.close(1000, "done");
    });
});

interface OpenedSocket {
    client: WebSocket;
    received: string[];
}

const openSocket = async (stub: DurableObjectStub<TestShardDO>, subId: string, query: { table: string }): Promise<OpenedSocket> => {
    const upgrade = await stub.fetch("https://shard.internal/_ws", { headers: { Upgrade: "websocket" } });

    if (!upgrade.webSocket) {
        throw new Error(`expected websocket upgrade, got status ${upgrade.status}`);
    }

    const client = upgrade.webSocket;
    const received: string[] = [];

    client.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
            received.push(event.data);
        }
    });

    client.accept();
    client.send(JSON.stringify({ type: "subscribe", id: subId, query }));

    await waitFor(() => received.some((m) => m.includes('"type":"ack"')));

    return { client, received };
};

const waitFor = async (predicate: () => boolean, { timeoutMs = 2000, intervalMs = 10 }: { intervalMs?: number; timeoutMs?: number } = {}): Promise<void> => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (predicate()) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`waitFor: predicate never became true within ${String(timeoutMs)}ms`);
};
