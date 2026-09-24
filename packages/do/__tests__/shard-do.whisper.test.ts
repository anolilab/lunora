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

/** One `onWhisper` dispatch, as recorded by {@link AuthorizedShard}. */
interface AuthorizeCall {
    event: Record<string, unknown>;
    functionPath: string;
}

/**
 * A shard with `onWhisper` authorizers wired in — the generated subclass's
 * `lifecycleHookPaths("whisper")` manifest plus the `handleRpc` that resolves
 * each path to a verdict, both faked here so the base class's gate is what the
 * assertions exercise.
 */
class AuthorizedShard extends ShardDO {
    public readonly calls: AuthorizeCall[] = [];

    public constructor(
        state: ShardDOState,
        private readonly paths: string[],
        private readonly verdicts: Record<string, (event: Record<string, unknown>) => unknown>,
    ) {
        super(state, {});
    }

    public override handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        this.calls.push({ event: args, functionPath });

        return Promise.resolve(this.verdicts[functionPath]?.(args));
    }

    protected override lifecycleHookPaths(event: string): ReadonlyArray<string> {
        return event === "whisper" ? this.paths : [];
    }
}

const makeAuthorizedShard = (
    sockets: FakeSocket[],
    paths: string[],
    verdicts: Record<string, (event: Record<string, unknown>) => unknown>,
): AuthorizedShard => {
    const state = {
        acceptWebSocket() {},
        getWebSockets: () => sockets,
        storage: { sql: {} },
    } as unknown as ShardDOState;

    return new AuthorizedShard(state, paths, verdicts);
};

const sendTo = async (shard: AuthorizedShard, ws: FakeSocket, envelope: Record<string, unknown>): Promise<void> => {
    await shard.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
};

describe("shardDO whisper authorization", () => {
    it("passes the topic, action and verified identity to the authorizer", async () => {
        expect.assertions(2);

        const a = new FakeSocket({ connectionId: "conn-1", context: { roomId: "r1" }, subs: {}, userId: "user-a" });
        const shard = makeAuthorizedShard([a], ["whisper:authorize"], { "whisper:authorize": () => true });

        await sendTo(shard, a, { topic: "room:r1", type: "whisper_subscribe" });

        expect(shard.calls).toHaveLength(1);
        expect(shard.calls[0]).toEqual({
            event: { action: "subscribe", connectionId: "conn-1", context: { roomId: "r1" }, shardKey: "__root__", topic: "room:r1", userId: "user-a" },
            functionPath: "whisper:authorize",
        });
    });

    it("denies a join the authorizer refuses, so the socket receives nothing on the topic", async () => {
        expect.assertions(2);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const b = new FakeSocket({ subs: {}, userId: "outsider" });
        // `a` is a member of the room; `b` is not.
        const shard = makeAuthorizedShard([a, b], ["whisper:authorize"], {
            "whisper:authorize": (event) => event.userId === "user-a",
        });

        await sendTo(shard, a, { topic: "room:r1", type: "whisper_subscribe" });
        await sendTo(shard, b, { topic: "room:r1", type: "whisper_subscribe" });

        await sendTo(shard, a, { data: { x: 1 }, topic: "room:r1", type: "whisper" });

        expect(b.frames).toHaveLength(0);
        // Denial is silent — no error frame to probe topic existence with.
        expect(b.closes).toHaveLength(0);
    });

    it("denies a send the authorizer refuses without disturbing the joined membership", async () => {
        expect.assertions(2);

        const a = new FakeSocket({ subs: {}, userId: "muted" });
        const b = new FakeSocket({ subs: {}, userId: "user-b" });
        // Read is open to everyone; only `muted` may not broadcast.
        const shard = makeAuthorizedShard([a, b], ["whisper:authorize"], {
            "whisper:authorize": (event) => event.action === "subscribe" || event.userId !== "muted",
        });

        await sendTo(shard, a, { topic: "t", type: "whisper_subscribe" });
        await sendTo(shard, b, { topic: "t", type: "whisper_subscribe" });

        await sendTo(shard, a, { data: { x: 1 }, topic: "t", type: "whisper" });

        expect(b.frames).toHaveLength(0);

        // `a` is still joined, so `b`'s (permitted) whisper still reaches it.
        await sendTo(shard, b, { data: { y: 2 }, topic: "t", type: "whisper" });

        expect(a.frames).toEqual([{ data: { y: 2 }, from: "user-b", topic: "t", type: "whisper" }]);
    });

    it("fails closed when the authorizer throws or returns a non-true value", async () => {
        expect.assertions(3);

        const thrower = new FakeSocket({ subs: {} });
        const truthy = new FakeSocket({ subs: {} });
        const absent = new FakeSocket({ subs: {} });
        const listener = new FakeSocket({ subs: {} });
        const shard = makeAuthorizedShard([thrower, truthy, absent, listener], ["whisper:authorize"], {
            "whisper:authorize": (event) => {
                if (event.topic === "throws") {
                    throw new Error("membership lookup failed");
                }

                // A truthy non-boolean (a row object) and an undefined return are
                // both denials: only a literal `true` allows.
                return event.topic === "truthy" ? { _id: "row" } : undefined;
            },
        });

        for (const [ws, topic] of [
            [thrower, "throws"],
            [truthy, "truthy"],
            [absent, "absent"],
        ] as const) {
            // eslint-disable-next-line no-await-in-loop -- sequential frames on one shard, mirroring a real socket's ordering
            await sendTo(shard, ws, { topic, type: "whisper_subscribe" });
            // eslint-disable-next-line no-await-in-loop -- see above
            await sendTo(shard, listener, { topic, type: "whisper_subscribe" });
            // eslint-disable-next-line no-await-in-loop -- see above
            await sendTo(shard, ws, { data: 1, topic, type: "whisper" });
        }

        expect(listener.frames).toHaveLength(0);
        expect(thrower.frames).toHaveLength(0);
        expect(truthy.frames).toHaveLength(0);
    });

    it("requires every registered authorizer to allow", async () => {
        expect.assertions(1);

        const a = new FakeSocket({ subs: {} });
        const b = new FakeSocket({ subs: {} });
        const shard = makeAuthorizedShard([a, b], ["whisper:one", "whisper:two"], {
            "whisper:one": () => true,
            "whisper:two": () => false,
        });

        await sendTo(shard, a, { topic: "t", type: "whisper_subscribe" });
        await sendTo(shard, b, { topic: "t", type: "whisper_subscribe" });

        await sendTo(shard, a, { data: 1, topic: "t", type: "whisper" });

        expect(b.frames).toHaveLength(0);
    });

    it("memoises the verdict per socket, action and topic so a cursor stream costs one query", async () => {
        expect.assertions(2);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const b = new FakeSocket({ subs: {} });
        const shard = makeAuthorizedShard([a, b], ["whisper:authorize"], { "whisper:authorize": () => true });

        await sendTo(shard, a, { topic: "t", type: "whisper_subscribe" });
        await sendTo(shard, b, { topic: "t", type: "whisper_subscribe" });

        for (let index = 0; index < 20; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- a burst on one socket, in order
            await sendTo(shard, a, { data: index, topic: "t", type: "whisper" });
        }

        // Two joins + one first send. The other 19 sends reused the memoised verdict.
        expect(shard.calls).toHaveLength(3);
        expect(b.frames).toHaveLength(20);
    });

    it("never authorizes a leave, so a revoked member can still unsubscribe", async () => {
        expect.assertions(2);

        const a = new FakeSocket({ subs: {} });
        const b = new FakeSocket({ subs: {} });
        let allow = true;
        const shard = makeAuthorizedShard([a, b], ["whisper:authorize"], { "whisper:authorize": () => allow });

        await sendTo(shard, a, { topic: "t", type: "whisper_subscribe" });
        await sendTo(shard, b, { topic: "t", type: "whisper_subscribe" });

        // Access is revoked, then `b` leaves. The leave must not be gated on a
        // permission `b` no longer has, or it would be stuck subscribed.
        allow = false;
        await sendTo(shard, b, { topic: "t", type: "whisper_unsubscribe" });

        allow = true;
        await sendTo(shard, a, { data: 1, topic: "t", type: "whisper" });

        expect(b.frames).toHaveLength(0);
        // The leave itself dispatched no authorizer.
        expect(shard.calls.filter((call) => call.event.action === undefined)).toHaveLength(0);
    });
});

/**
 * The membership cap (64 topics) does not bound authorization: a join is
 * authorized BEFORE membership is recorded, and a send is authorized whether or
 * not the sender is a member. Without a cap of its own, a socket naming a fresh
 * topic per frame grows the verdict memo without bound and re-enters the
 * authorizer — a database query — once per name.
 */
describe("shardDO whisper authorization cap", () => {
    it("stops dispatching the authorizer once a socket names more distinct topics than the cap", async () => {
        expect.assertions(3);

        const a = new FakeSocket({ subs: {}, userId: "flooder" });
        const shard = makeAuthorizedShard([a], ["whisper:authorize"], { "whisper:authorize": () => true });

        // 400 never-seen topics: each is a memo miss, so an uncapped shard would
        // run the authorizer 400 times — well past the 64-topic membership cap.
        for (let index = 0; index < 400; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential frames model one client's flood
            await sendTo(shard, a, { topic: `t${String(index)}`, type: "whisper_subscribe" });
        }

        // The dispatch count is the proof: the cap ran BEFORE the authorizer.
        expect(shard.calls).toHaveLength(256);
        expect(a.frames.filter((frame) => frame.code === "TOO_MANY_WHISPER_TOPICS")).toHaveLength(400 - 256);
        // Refused pairs are not memoised, so the memo stopped growing at the cap.
        expect(shard.calls.at(-1)?.event.topic).toBe("t255");
    });

    it("counts a send and a subscribe on the same topic separately, since each is its own verdict", async () => {
        expect.assertions(3);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const shard = makeAuthorizedShard([a], ["whisper:authorize"], { "whisper:authorize": () => true });

        // 128 topics joined AND broadcast on = 256 pairs: exactly the cap, all allowed.
        for (let index = 0; index < 128; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential frames on one socket, in order
            await sendTo(shard, a, { topic: `t${String(index)}`, type: "whisper_subscribe" });
            // eslint-disable-next-line no-await-in-loop -- see above
            await sendTo(shard, a, { data: index, topic: `t${String(index)}`, type: "whisper" });
        }

        expect(shard.calls).toHaveLength(256);
        expect(a.frames).toHaveLength(0);

        // The 257th pair is refused, and costs no dispatch.
        await sendTo(shard, a, { topic: "one-too-many", type: "whisper_subscribe" });

        expect(shard.calls).toHaveLength(256);
    });

    it("refuses a repeated over-cap topic every time, because a refusal is never memoised", async () => {
        expect.assertions(3);

        const a = new FakeSocket({ subs: {}, userId: "flooder" });
        const shard = makeAuthorizedShard([a], ["whisper:authorize"], { "whisper:authorize": () => true });

        for (let index = 0; index < 256; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential frames fill the memo to exactly the cap
            await sendTo(shard, a, { topic: `t${String(index)}`, type: "whisper_subscribe" });
        }

        expect(a.frames).toHaveLength(0);

        // The same over-cap topic, five times. Memoising the refusal would bound
        // the dispatches but NOT the memo — and it would show up here, because
        // the second and later frames would read the cached `false` and return
        // silently instead of refusing.
        for (let index = 0; index < 5; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- see above
            await sendTo(shard, a, { topic: "over-cap", type: "whisper_subscribe" });
        }

        expect(a.frames.filter((frame) => frame.code === "TOO_MANY_WHISPER_TOPICS")).toHaveLength(5);
        // And no refusal cost a dispatch.
        expect(shard.calls).toHaveLength(256);
    });

    it("refuses with a message that names only the socket's own ceiling", async () => {
        expect.assertions(3);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        // Every topic would be DENIED if the authorizer ran, so a refusal that
        // leaked the verdict would read differently from one on an allowed topic.
        // It does not: the frame carries the cap and nothing else.
        const shard = makeAuthorizedShard([a], ["whisper:authorize"], { "whisper:authorize": () => false });

        for (let index = 0; index < 257; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential frames on one socket, in order
            await sendTo(shard, a, { topic: `secret-${String(index)}`, type: "whisper_subscribe" });
        }

        const refusals = a.frames.filter((frame) => frame.type === "error");

        expect(refusals).toHaveLength(1);
        expect(shard.calls).toHaveLength(256);
        expect(JSON.stringify(refusals[0])).not.toMatch(/secret-|allow|den|exist/iu);
    });

    /**
     * Every test above feeds the socket one frame at a time, and a cap that
     * merely READS the memo size passes all of them. The authorizer is awaited
     * between the check and the write, and a Durable Object keeps delivering
     * socket frames across a non-storage yield — so frames that arrive in one
     * batch all see the pre-dispatch size. These two drive the frames WITHOUT
     * awaiting between them, which is what the reservation exists for.
     */
    it("bounds a burst of concurrent frames, not just a sequential flood", async () => {
        expect.assertions(2);

        const a = new FakeSocket({ subs: {}, userId: "flooder" });
        const shard = makeAuthorizedShard([a], ["whisper:authorize"], { "whisper:authorize": () => true });

        // 400 distinct topics delivered as one batch: not one of them is awaited
        // before the next starts, so each reaches the cap check while the earlier
        // dispatches are still in flight.
        await Promise.all(
            Array.from({ length: 400 }, async (_, index) => {
                await sendTo(shard, a, { topic: `t${String(index)}`, type: "whisper_subscribe" });
            }),
        );

        expect(shard.calls).toHaveLength(256);
        expect(a.frames.filter((frame) => frame.code === "TOO_MANY_WHISPER_TOPICS")).toHaveLength(400 - 256);
    });

    it("collapses a burst naming one pair onto a single authorizer run", async () => {
        expect.assertions(2);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const shard = makeAuthorizedShard([a], ["whisper:authorize"], { "whisper:authorize": () => true });

        // The memo cannot answer a pair whose verdict has not settled yet, so
        // without the in-flight reservation these are ten separate queries for
        // one question.
        await Promise.all(
            Array.from({ length: 10 }, async () => {
                await sendTo(shard, a, { topic: "same", type: "whisper_subscribe" });
            }),
        );

        expect(shard.calls).toHaveLength(1);
        expect(a.frames).toHaveLength(0);
    });
});
