import { describe, expect, it } from "vitest";

import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

/**
 * Whispering (AnyCable-style ephemeral peer messages) + token-expiry over the
 * real `webSocketMessage` dispatch path. Whispers fan out to a topic's other
 * subscribers on the shard with NO SQLite/CDC write; an expired socket is
 * dropped with a `TOKEN_EXPIRED` frame + close code 4001 before its frame runs.
 */

interface Frame {
    code?: string;
    data?: unknown;
    from?: string;
    topic?: string;
    type: string;
}

/** Round-trips the hibernation attachment and records sent frames + close calls. */
class FakeSocket {
    public readonly closes: { code?: number; reason?: string }[] = [];

    public readonly frames: Frame[] = [];

    private attachment: unknown;

    public constructor(initial?: unknown) {
        this.attachment = initial;
    }

    public close(code?: number, reason?: string): void {
        this.closes.push({ code, reason });
    }

    public deserializeAttachment(): unknown {
        return this.attachment;
    }

    public send(data: string): void {
        this.frames.push(JSON.parse(data) as Frame);
    }

    public serializeAttachment(value: unknown): void {
        this.attachment = value;
    }
}

class WhisperShard extends ShardDO {
    public sockets: FakeSocket[] = [];

    // eslint-disable-next-line class-methods-use-this -- abstract stub; whisper/expiry paths never dispatch an RPC
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve({});
    }
}

const makeShard = (sockets: FakeSocket[]): WhisperShard => {
    const state = {
        acceptWebSocket() {},
        getWebSockets: () => sockets,
        storage: { sql: {} },
    } as unknown as ShardDOState;

    return new WhisperShard(state, {});
};

const send = async (shard: WhisperShard, ws: FakeSocket, envelope: Record<string, unknown>): Promise<void> => {
    await shard.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
};

describe("shardDO whispering", () => {
    it("fans a whisper out to other topic members but not the sender", async () => {
        expect.assertions(4);

        // `a` carries a verified userId so receivers see `from`.
        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const b = new FakeSocket({ subs: {} });
        const c = new FakeSocket({ subs: {} });
        const sockets = [a, b, c];
        const shard = makeShard(sockets);

        await send(shard, a, { topic: "cursors", type: "whisper_subscribe" });
        await send(shard, b, { topic: "cursors", type: "whisper_subscribe" });
        // `c` joins a different topic and must not receive the whisper.
        await send(shard, c, { topic: "other", type: "whisper_subscribe" });

        await send(shard, a, { data: { x: 1 }, topic: "cursors", type: "whisper" });

        // Sender never receives its own whisper.
        expect(a.frames).toHaveLength(0);
        // `b` (same topic) receives it, attributed to the sender.
        expect(b.frames).toEqual([{ data: { x: 1 }, from: "user-a", topic: "cursors", type: "whisper" }]);
        // `c` (different topic) receives nothing.
        expect(c.frames).toHaveLength(0);

        // No `from` leaks when the sender is anonymous.
        await send(shard, b, { data: { y: 2 }, topic: "cursors", type: "whisper" });

        expect(a.frames[0]).toEqual({ data: { y: 2 }, topic: "cursors", type: "whisper" });
    });

    it("relays a wire-encoded whisper payload verbatim so bigint/bytes round-trip", async () => {
        expect.assertions(3);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const b = new FakeSocket({ subs: {} });
        const shard = makeShard([a, b]);

        await send(shard, a, { topic: "cursors", type: "whisper_subscribe" });
        await send(shard, b, { topic: "cursors", type: "whisper_subscribe" });

        // The client wire-encodes before sending; the shard must relay that tagged
        // form verbatim (a second `encodeWire` here would double-tag it) so the
        // receiving client can `decodeWire` back to the real bigint/bytes values.
        const payload = { count: 9_007_199_254_740_993n, raw: new Uint8Array([1, 2, 3, 255]) };

        await send(shard, a, { data: encodeWire(payload), topic: "cursors", type: "whisper" });

        const relayed = b.frames[0]?.data;

        // Relayed byte-for-byte as the client encoded it (no re-encode on the hop).
        expect(relayed).toEqual(encodeWire(payload));

        // ...and it decodes back to the original values on the receiver.
        const decoded = decodeWire(relayed) as { count: bigint; raw: Uint8Array };

        expect(decoded.count).toBe(9_007_199_254_740_993n);
        expect([...decoded.raw]).toEqual([1, 2, 3, 255]);
    });

    it("stops delivering after a whisper_unsubscribe", async () => {
        expect.assertions(1);

        const a = new FakeSocket({ subs: {} });
        const b = new FakeSocket({ subs: {} });
        const shard = makeShard([a, b]);

        await send(shard, a, { topic: "t", type: "whisper_subscribe" });
        await send(shard, b, { topic: "t", type: "whisper_subscribe" });
        await send(shard, b, { topic: "t", type: "whisper_unsubscribe" });

        await send(shard, a, { data: 1, topic: "t", type: "whisper" });

        expect(b.frames).toHaveLength(0);
    });

    it("rate-limits a sender that floods whispers", async () => {
        expect.assertions(2);

        const a = new FakeSocket({ subs: {} });
        const b = new FakeSocket({ subs: {} });
        const shard = makeShard([a, b]);

        await send(shard, a, { topic: "t", type: "whisper_subscribe" });
        await send(shard, b, { topic: "t", type: "whisper_subscribe" });

        // Burst far past the per-socket budget in the same instant (no refill).
        for (let index = 0; index < 200; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential sends model one client's flood
            await send(shard, a, { data: index, topic: "t", type: "whisper" });
        }

        // Receiver got at most the burst budget (WHISPER_RATE_BURST = 50), not
        // all 200 — the rest were dropped by the token bucket.
        expect(b.frames.length).toBeLessThanOrEqual(50);
        expect(b.frames.length).toBeGreaterThan(0);
    });

    it("drops an over-limit whisper payload", async () => {
        expect.assertions(1);

        const a = new FakeSocket({ subs: {} });
        const b = new FakeSocket({ subs: {} });
        const shard = makeShard([a, b]);

        await send(shard, a, { topic: "t", type: "whisper_subscribe" });
        await send(shard, b, { topic: "t", type: "whisper_subscribe" });

        await send(shard, a, { data: { blob: "x".repeat(5000) }, topic: "t", type: "whisper" });

        expect(b.frames).toHaveLength(0);
    });
});

describe("shardDO token-expiry", () => {
    it("drops an expired socket with a TOKEN_EXPIRED frame + close 4001", async () => {
        expect.assertions(3);

        const ws = new FakeSocket({ expiresAt: 1000, subs: {}, userId: "u" });
        const shard = makeShard([ws]);

        // Any frame on an expired socket is rejected before processing.
        await shard.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ id: "s1", query: { functionPath: "x:y" }, type: "subscribe" }));

        expect(ws.frames).toHaveLength(1);
        expect(ws.frames[0]?.code).toBe("TOKEN_EXPIRED");
        expect(ws.closes[0]).toEqual({ code: 4001, reason: "token_expired" });
    });

    it("stops DELIVERING whispers to an expired socket, not just accepting them from it", async () => {
        expect.assertions(4);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        // A passive receiver: it joined the topic while its credential was live
        // and then never sends another inbound frame. No write flush, no shape
        // poke and no global poll fire on a pure presence/cursor workload, so
        // this fan-out is the ONLY outbound path that can notice the expiry.
        const b = new FakeSocket({ subs: {} });
        const shard = makeShard([a, b]);

        await send(shard, a, { topic: "t", type: "whisper_subscribe" });
        await send(shard, b, { topic: "t", type: "whisper_subscribe" });

        b.serializeAttachment({ ...(b.deserializeAttachment() as Record<string, unknown>), expiresAt: 1000 });

        await send(shard, a, { data: { x: 1 }, topic: "t", type: "whisper" });

        expect(b.frames).toHaveLength(1);
        expect(b.frames[0]?.type).not.toBe("whisper");
        expect(b.frames[0]?.code).toBe("TOKEN_EXPIRED");
        expect(b.closes[0]).toEqual({ code: 4001, reason: "token_expired" });
    });

    it("processes a socket whose token has not yet expired", async () => {
        expect.assertions(1);

        const ws = new FakeSocket({ expiresAt: Date.now() + 60_000, subs: {} });
        const shard = makeShard([ws]);

        await send(shard, ws, { topic: "t", type: "whisper_subscribe" });

        // Not expired → no close, the whisper_subscribe was accepted (no error frame).
        expect(ws.closes).toHaveLength(0);
    });
});
