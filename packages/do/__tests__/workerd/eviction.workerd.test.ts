/**
 * Real-workerd eviction-lifecycle tests for the sync engine on `ShardDO`.
 *
 * Every other workerd suite keeps the Durable Object warm for the whole test, so
 * it only ever exercises the Hibernation *API surface* (`serializeAttachment`,
 * `acceptWebSocket`) — never the production transition that the engine is built
 * around: an idle DO is evicted from memory and woken on next access, rebuilding
 * all in-memory state from SQLite + the hibernated WebSocket's attachment.
 *
 * `@cloudflare/vitest-pool-workers@0.16.20`'s `evictDurableObject` /
 * `evictAllDurableObjects` (exported from `cloudflare:test`) let us drive exactly
 * that. Eviction tears down the instance — resetting in-memory state (the
 * `subMemos` WeakMap, the per-instance subscriber bookkeeping, the migration
 * latch) while preserving durable storage — so what survives is only what was
 * persisted. With `webSockets: "hibernate"` (the default) the hibernatable
 * socket is reattached on wake; with `webSockets: "close"` it is torn down and
 * the client observes a clean close.
 *
 * What these tests pin that the warm suites cannot:
 *
 * - Persistence: SQLite rows + migrations survive a cold restart, so a post-eviction subscribe re-seeds from persisted membership.
 * - Resumption: a write that wakes the DO still pokes a previously-hibernated socket, proving the subscription was rebuilt from its attachment, not the wiped in-memory registry.
 * - Watermark durability: the custom-mutator `__client_watermark` survives eviction — a replay still acks-without-rerunning and the next sequence advances.
 * - Close path: `webSockets: "close"` evicts and severs the socket; a fresh reconnect re-seeds from the current (persisted) membership.
 *
 * Harness note: `evictDurableObject` waits for in-flight requests to drain, and an unread `Response` body counts as in-flight forever — so every RPC body is drained (asserted on, or via `sendDrained`) before the eviction that follows.
 */
import { env, evictAllDurableObjects, evictDurableObject } from "cloudflare:test";
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
    closes: { code: number; reason: string }[];
    received: string[];
}

const openSocket = async (stub: DurableObjectStub<TestSyncDO>): Promise<OpenedSocket> => {
    const upgrade = await stub.fetch("https://sync.internal/_ws", { headers: { Upgrade: "websocket" } });

    if (!upgrade.webSocket) {
        throw new Error(`expected websocket upgrade, got status ${String(upgrade.status)}`);
    }

    const client = upgrade.webSocket;
    const received: string[] = [];
    const closes: { code: number; reason: string }[] = [];

    client.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
            received.push(event.data);
        }
    });

    client.addEventListener("close", (event) => {
        closes.push({ code: event.code, reason: event.reason });
    });

    client.accept();

    return { client, closes, received };
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

/**
 * Fire an RPC and *drain its response body* before returning.
 *
 * `evictDurableObject` waits for in-flight requests to drain before tearing the
 * instance down. A `Response` whose body is never read counts as an in-flight
 * request forever, so an eviction that follows an undrained RPC hangs. Tests
 * that assert on a response (`.json()`) drain it implicitly; the seed/setup
 * writes here do not care about the result, so they must drain explicitly before
 * the eviction that follows.
 */
const sendDrained = async (stub: DurableObjectStub<TestSyncDO>, args: Record<string, unknown>): Promise<void> => {
    const response = await rpc(stub, "messages:send", args);

    await response.text();
};

/** Collect the row-ops across every `pokePart` frame the socket received. */
const pokeOps = (socket: OpenedSocket): { key: string; op: string; value?: Record<string, unknown> }[] =>
    socket.received
        .map((raw) => JSON.parse(raw) as { rowsPatch?: { key: string; op: string; value?: Record<string, unknown> }[]; type: string })
        .filter((frame) => frame.type === "pokePart")
        .flatMap((frame) => frame.rowsPatch ?? []);

describe("sync engine eviction lifecycle (workerd e2e)", () => {
    it("re-seeds from persisted SQLite + re-runs migrations after the DO is evicted from memory", async () => {
        expect.assertions(3);

        const stub = newStub("evict-seed");

        // Persist two rows, then tear the instance down. Storage survives; the
        // in-memory migration latch + writer cache do not. (Distinct `text` per
        // row — the fixture's `by_text` index is UNIQUE. Bodies drained so the
        // eviction below isn't blocked on an in-flight request.)
        await sendDrained(stub, { _id: "m1", channelId: "c1", text: "seed-m1" });
        await sendDrained(stub, { _id: "m2", channelId: "c2", text: "seed-m2" });

        await evictDurableObject(stub);

        // A fresh subscribe wakes the DO cold: `ensureMigrated` must re-run
        // idempotently and the seed must reflect the persisted membership.
        const socket = await openSocket(stub);

        await subscribeShape(socket, "c1");

        const types = socket.received.map((raw) => (JSON.parse(raw) as { type: string }).type);

        expect(types).toStrictEqual(["pokeStart", "pokePart", "pokeEnd", "ack"]);

        const ops = pokeOps(socket);

        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ key: "m1", op: "insert" });

        socket.client.close(1000, "done");
    });

    it("resumes a hibernated subscriber across eviction — a waking write still pokes it from the rebuilt attachment", async () => {
        expect.assertions(2);

        const stub = newStub("evict-resume");
        const socket = await openSocket(stub);

        await subscribeShape(socket, "c1");
        socket.received.length = 0;

        // Default `webSockets: "hibernate"`: the client stays connected, the
        // server socket hibernates, and the in-memory `subMemos`/registry are
        // wiped. The subscription survives only as the socket's attachment.
        await evictDurableObject(stub);

        // This push wakes the DO. On wake the subscriber set is reconstructed
        // from `getWebSockets()` + the attachment, so the flush must still poke
        // our previously-hibernated socket.
        const response = await rpc(stub, "messages:sendMutator", { _id: "after-evict", channelId: "c1", text: "woke" }, { clientId: "cli-1", seq: 1 });

        await expect(response.json()).resolves.toEqual({ lastMutationId: 1, result: { id: "after-evict", ok: true } });

        await waitFor(() => socket.received.some((m) => m.includes('"type":"pokePart"')));

        expect(pokeOps(socket).some((op) => op.key === "after-evict" && op.op === "insert")).toBe(true);

        socket.client.close(1000, "done");
    });

    it("keeps the custom-mutator watermark durable across eviction — replay still acks-without-rerunning, next sequence advances", async () => {
        expect.assertions(5);

        const stub = newStub("evict-watermark");

        const first = await rpc(stub, "messages:sendMutator", { _id: "w1", channelId: "c1", text: "wm-w1" }, { clientId: "cli-1", seq: 1 });

        await expect(first.json()).resolves.toEqual({ lastMutationId: 1, result: { id: "w1", ok: true } });

        // Tear the instance down: `__client_watermark` lives in SQLite, so the
        // cold-restarted DO must still recognise seq 1 as already applied.
        await evictDurableObject(stub);

        // Replay re-sends the SAME row (`_id`/`text` unchanged): the watermark
        // must short-circuit it BEFORE the write, so it acks without colliding
        // on the UNIQUE `by_text` index.
        const replay = await rpc(stub, "messages:sendMutator", { _id: "w1", channelId: "c1", text: "wm-w1" }, { clientId: "cli-1", seq: 1 });

        await expect(replay.json()).resolves.toEqual({ lastMutationId: 1, result: null });

        // And the next sequence advances normally off the persisted watermark.
        const next = await rpc(stub, "messages:sendMutator", { _id: "w2", channelId: "c1", text: "wm-w2" }, { clientId: "cli-1", seq: 2 });

        await expect(next.json()).resolves.toEqual({ lastMutationId: 2, result: { id: "w2", ok: true } });

        // A gap relative to the now-advanced watermark still halts. Drain the
        // body (assert on it) so this response isn't left in-flight for the
        // `evictAllDurableObjects` sweep in a later test.
        const gap = await rpc(stub, "messages:sendMutator", { _id: "w4", channelId: "c1", text: "wm-w4" }, { clientId: "cli-1", seq: 4 });

        expect(gap.status).toBe(409);
        await expect(gap.json()).resolves.toMatchObject({ error: { code: "OUT_OF_ORDER", expectedMutationId: 3 } });
    });

    it('closes hibernatable sockets on `webSockets: "close"` eviction; a fresh reconnect re-seeds from persisted membership', async () => {
        expect.assertions(3);

        const stub = newStub("evict-close");

        await sendDrained(stub, { _id: "pre", channelId: "c1", text: "close-pre" });

        const socket = await openSocket(stub);

        await subscribeShape(socket, "c1");

        // Tearing down with `webSockets: "close"` severs the hibernatable socket
        // rather than hibernating it — the client observes a close event.
        await evictDurableObject(stub, { webSockets: "close" });

        await waitFor(() => socket.closes.length > 0);

        expect(socket.closes).toHaveLength(1);

        // Reconnecting wakes the DO cold and re-seeds from the persisted row.
        const reconnect = await openSocket(stub);

        await subscribeShape(reconnect, "c1");

        const ops = pokeOps(reconnect);

        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ key: "pre", op: "insert" });

        reconnect.client.close(1000, "done");
    });

    it("evictAllDurableObjects preserves storage — a swept DO re-seeds its membership on next access", async () => {
        expect.assertions(2);

        const stub = newStub("evict-all");

        await sendDrained(stub, { _id: "kept", channelId: "c1", text: "all-kept" });

        // Sweep every running instance (graceful: storage preserved). The next
        // access cold-starts and must still see the persisted row.
        await evictAllDurableObjects();

        const socket = await openSocket(stub);

        await subscribeShape(socket, "c1");

        const ops = pokeOps(socket);

        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ key: "kept", op: "insert" });

        socket.client.close(1000, "done");
    });
});

describe("shardDO websocket upgrade — durable socket identity", () => {
    it("accepts through SocketHost, so the socket carries the durable id tag", async () => {
        expect.assertions(2);

        const stub = newStub("upgrade-tag");
        const socket = await openSocket(stub);

        const tags = await stub.socketTags();

        // `ShardDO`'s upgrade path must accept through `SocketHost`, not call
        // `state.acceptWebSocket` directly. The accept-time tag is what makes
        // `SocketHandle.id` survive hibernation and what lets `handleFor` resolve
        // a raw socket in O(1) after a wake instead of scanning the socket set.
        // Accepting behind the host's back still works — it just silently loses
        // both, which no other assertion here would notice.
        expect(tags).toHaveLength(1);
        expect(tags[0]?.some((tag) => tag.startsWith("lunora-socket:"))).toBe(true);

        socket.client.close();
    });

    it("keeps the same socket id across an eviction", async () => {
        expect.assertions(2);

        const stub = newStub("upgrade-tag-durable");
        const socket = await openSocket(stub);

        const tagsBefore = await stub.socketTags();
        const before = tagsBefore[0]?.find((tag) => tag.startsWith("lunora-socket:"));

        await evictDurableObject(stub);

        // The tag is durable state the runtime reattaches with the hibernated
        // socket, so the id is the SAME object after the wake. A wake-local id
        // minted per isolate would come back different, and every per-socket memo
        // keyed on it would miss.
        const tagsAfter = await stub.socketTags();
        const after = tagsAfter[0]?.find((tag) => tag.startsWith("lunora-socket:"));

        expect(before).toBeDefined();
        expect(after).toBe(before);

        socket.client.close();
    });
});
