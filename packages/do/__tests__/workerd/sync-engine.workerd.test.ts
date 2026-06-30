/**
 * Real-workerd e2e for the local-first sync engine: the poke diff protocol and
 * custom-mutator watermark exercised end-to-end against a live `ShardDO`
 * ({@link TestSyncDO}) inside a Miniflare-driven `workerd` process.
 *
 * The mock-state suites (`shard-do.shape-poke.test.ts`,
 * `shard-do.client-watermark.test.ts`) drive the same surface against
 * hand-rolled sockets + `node:sqlite`. The value here is the parts only the real
 * runtime models: the Hibernation WebSocket API delivering pokes off the
 * `flushChangedTables` `waitUntil` path, SQLite-in-DO storage, and the real
 * dispatch/response lifecycle for a watermarked custom-mutator push.
 *
 * The full pipeline under test, end to end:
 *
 * A `shape_subscribe` to a `channelId`-scoped shape seed-pokes the current
 * membership, then acks last (the ack follows a successful seed). A custom-mutator push (`x-lunora-client-id` +
 * `x-lunora-client-seq`) writes authoritatively, echoes the applied
 * `lastMutationId`, and the write flush pokes the live subscriber with the
 * membership diff. Watermark ordering: a replay acks without re-running and a
 * gap halts with 409. RLS/args isolation: a `c2` subscriber never sees a `c1`
 * write.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { TestSyncDO } from "./test-worker";

// `env` is typed via the `Cloudflare.Env` augmentation in `./env.d.ts`.

const newStub = (name: string): DurableObjectStub<TestSyncDO> => env.SYNC.get(env.SYNC.idFromName(name));

const waitFor = async (predicate: () => boolean, { intervalMs = 10, timeoutMs = 2000 }: { intervalMs?: number; timeoutMs?: number } = {}): Promise<void> => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (predicate()) {
            return;
        }

        // eslint-disable-next-line no-await-in-loop -- polling loop must wait between predicate checks
        await new Promise((resolve) => {
            setTimeout(resolve, intervalMs);
        });
    }

    throw new Error(`waitFor: predicate never became true within ${String(timeoutMs)}ms`);
};

interface OpenedSocket {
    client: WebSocket;
    received: string[];
}

const openSocket = async (stub: DurableObjectStub<TestSyncDO>): Promise<OpenedSocket> => {
    const upgrade = await stub.fetch("https://sync.internal/_ws", { headers: { Upgrade: "websocket" } });

    if (!upgrade.webSocket) {
        throw new Error(`expected websocket upgrade, got status ${String(upgrade.status)}`);
    }

    const client = upgrade.webSocket;
    const received: string[] = [];

    client.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
            received.push(event.data);
        }
    });

    client.accept();

    return { client, received };
};

const subscribeShape = async (socket: OpenedSocket, channelId: string): Promise<void> => {
    socket.client.send(JSON.stringify({ id: "s1", shape: { args: { channelId }, name: "messagesByChannel" }, type: "shape_subscribe" }));

    // The seed emits pokeStart → pokePart → pokeEnd → ack (ack last, after seed).
    await waitFor(() => socket.received.some((m) => m.includes('"type":"pokeEnd"')));
};

interface PushHeaders {
    "content-type": string;
    "x-lunora-client-id"?: string;
    "x-lunora-client-seq"?: string;
}

const rpc = (
    stub: DurableObjectStub<TestSyncDO>,
    functionPath: string,
    args: Record<string, unknown>,
    watermark?: { clientId: string; seq: number },
): Promise<Response> => {
    const headers: PushHeaders = { "content-type": "application/json" };

    if (watermark) {
        headers["x-lunora-client-id"] = watermark.clientId;
        headers["x-lunora-client-seq"] = String(watermark.seq);
    }

    return stub.fetch("https://sync.internal/rpc", {
        body: JSON.stringify({ args, functionPath }),
        headers: headers as unknown as Record<string, string>,
        method: "POST",
    });
};

/** Collect the row-ops across every `pokePart` frame the socket received. */
const pokeOps = (socket: OpenedSocket): { key: string; op: string; value?: Record<string, unknown> }[] =>
    socket.received
        .map((raw) => JSON.parse(raw) as { rowsPatch?: { key: string; op: string; value?: Record<string, unknown> }[]; type: string })
        .filter((frame) => frame.type === "pokePart")
        .flatMap((frame) => frame.rowsPatch ?? []);

describe("sync engine (workerd e2e)", () => {
    it("seeds a fresh shape subscription with the current membership over a real DO + WS", async () => {
        expect.assertions(3);

        const stub = newStub("sync-seed");

        // Two pre-existing rows: one in c1, one in c2.
        await rpc(stub, "messages:send", { _id: "m1", channelId: "c1" });
        await rpc(stub, "messages:send", { _id: "m2", channelId: "c2" });

        const socket = await openSocket(stub);

        await subscribeShape(socket, "c1");

        const types = socket.received.map((raw) => (JSON.parse(raw) as { type: string }).type);

        expect(types).toStrictEqual(["pokeStart", "pokePart", "pokeEnd", "ack"]);

        const ops = pokeOps(socket);

        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ key: "m1", op: "insert" });

        socket.client.close(1000, "done");
    });

    it("runs a custom-mutator push authoritatively, echoes lastMutationId, and pokes the live subscriber", async () => {
        expect.assertions(3);

        const stub = newStub("sync-mutator");
        const socket = await openSocket(stub);

        await subscribeShape(socket, "c1");
        socket.received.length = 0;

        // Watermarked custom-mutator push (client `cli-1`, seq 1).
        const response = await rpc(stub, "messages:sendMutator", { _id: "m3", channelId: "c1", text: "hi" }, { clientId: "cli-1", seq: 1 });

        // The authoritative response echoes the applied watermark + the impl result.
        await expect(response.json()).resolves.toEqual({ lastMutationId: 1, result: { id: "m3", ok: true } });

        // The write flush pokes the live subscriber with the membership insert.
        await waitFor(() => socket.received.some((m) => m.includes('"type":"pokePart"')));

        const ops = pokeOps(socket);

        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ key: "m3", op: "insert", value: expect.objectContaining({ _id: "m3", text: "hi" }) });

        socket.client.close(1000, "done");
    });

    it("acks a replayed sequence and halts an out-of-order push", async () => {
        expect.assertions(4);

        const stub = newStub("sync-watermark");

        const first = await rpc(stub, "messages:sendMutator", { _id: "w1", channelId: "c1" }, { clientId: "cli-1", seq: 1 });

        await expect(first.json()).resolves.toEqual({ lastMutationId: 1, result: { id: "w1", ok: true } });

        // Replay of an already-applied sequence: ack, handler not re-run, result null.
        const replay = await rpc(stub, "messages:sendMutator", { _id: "w1", channelId: "c1" }, { clientId: "cli-1", seq: 1 });

        await expect(replay.json()).resolves.toEqual({ lastMutationId: 1, result: null });

        // Gap (watermark is 1, seq 3 skips 2) → out-of-order halt.
        const gap = await rpc(stub, "messages:sendMutator", { _id: "w3", channelId: "c1" }, { clientId: "cli-1", seq: 3 });

        expect(gap.status).toBe(409);
        await expect(gap.json()).resolves.toEqual({
            error: { code: "OUT_OF_ORDER", expectedMutationId: 2, message: "out-of-order mutation; expected sequence 2" },
        });
    });

    it("isolates shapes per args — a c2 subscriber never sees a c1 write", async () => {
        expect.assertions(2);

        const stub = newStub("sync-isolation");
        const subA = await openSocket(stub);
        const subB = await openSocket(stub);

        await subscribeShape(subA, "c1");
        await subscribeShape(subB, "c2");
        subA.received.length = 0;
        subB.received.length = 0;

        await rpc(stub, "messages:sendMutator", { _id: "iso1", channelId: "c1" }, { clientId: "cli-1", seq: 1 });

        await waitFor(() => subA.received.some((m) => m.includes('"type":"pokePart"')));

        // Give B a chance to (incorrectly) receive after A already has.
        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });

        expect(pokeOps(subA)).toStrictEqual([{ key: "iso1", op: "insert", table: "messages", value: expect.objectContaining({ _id: "iso1" }) }]);
        expect(pokeOps(subB)).toStrictEqual([]);

        subA.client.close(1000, "done");
        subB.client.close(1000, "done");
    });
});
