import { encodeWire } from "@lunora/wire";
import { describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

/**
 * `defineRoom` over the real `webSocketMessage` dispatch path. A room is a typed
 * layer over the whisper channel: joining/leaving a room topic and sending to it
 * dispatch the room's server handler (join/leave/message), which then fans a
 * typed payload out to the room through `socket.broadcast`. No new DO, no new
 * upgrade route — the same channels the whisper tests exercise.
 */

interface Frame {
    code?: string;
    data?: unknown;
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

interface RoomCall {
    args: Record<string, unknown>;
    functionPath: string;
}

/**
 * A shard with the room map + whisper authorizer manifest wired in — the
 * generated subclass's overrides faked here so the base class's dispatch is what
 * the assertions exercise. A room `message` dispatch is answered by echoing the
 * message back through the socket handle, the way an app's `onMessage` would.
 */
class RoomShard extends ShardDO {
    public readonly calls: RoomCall[] = [];

    public constructor(
        state: ShardDOState,
        private readonly rooms: Record<string, string>,
        private readonly whisperPaths: string[] = [],
        private readonly verdicts: Record<string, (event: Record<string, unknown>) => unknown> = {},
    ) {
        super(state, {});
    }

    public override handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        this.calls.push({ args, functionPath });

        const verdict = this.verdicts[functionPath];

        if (verdict) {
            return Promise.resolve(verdict(args));
        }

        if (args["kind"] === "message") {
            (args["socket"] as { broadcast: (message: unknown) => void }).broadcast({ echo: args["message"] });
        }

        return Promise.resolve(undefined);
    }

    protected override lifecycleHookPaths(event: "connect" | "disconnect" | "init" | "reactor" | "whisper"): ReadonlyArray<string> {
        return event === "whisper" ? this.whisperPaths : [];
    }

    protected override roomHandlerPath(topic: string): string | undefined {
        return this.rooms[topic];
    }
}

const makeShard = (
    sockets: FakeSocket[],
    rooms: Record<string, string>,
    whisperPaths: string[] = [],
    verdicts: Record<string, (event: Record<string, unknown>) => unknown> = {},
): RoomShard => {
    const state = {
        acceptWebSocket() {},
        getWebSockets: () => sockets,
        storage: { sql: {} },
    } as unknown as ShardDOState;

    return new RoomShard(state, rooms, whisperPaths, verdicts);
};

const send = async (shard: RoomShard, ws: FakeSocket, envelope: Record<string, unknown>): Promise<void> => {
    await shard.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
};

const roomCalls = (shard: RoomShard): RoomCall[] => shard.calls.filter((call) => call.functionPath === "rooms:chat");

describe("shardDO room authorisation and teardown", () => {
    it("refuses a room message once its sender is revoked, even after an earlier message was allowed", async () => {
        expect.assertions(2);

        let allowed = true;
        const a = new FakeSocket({ subs: {}, userId: "member" });
        const shard = makeShard([a], { "room:chat": "rooms:chat" }, ["whisper:authorize"], { "whisper:authorize": () => allowed });

        await send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });
        await send(shard, a, { data: encodeWire({ text: "first" }), topic: "room:chat", type: "whisper" });

        // Revoked between messages: the earlier allowed verdict must not carry over.
        allowed = false;
        await send(shard, a, { data: encodeWire({ text: "after revoke" }), topic: "room:chat", type: "whisper" });

        const messages = roomCalls(shard).filter((call) => call.args["kind"] === "message");

        expect(messages).toHaveLength(1);
        expect(messages[0]?.args["message"]).toStrictEqual({ text: "first" });
    });

    it("gives every room leave of a closing socket the identity it had at close, even when the leave runs after cleanup", async () => {
        expect.assertions(3);

        let releaseFirst: () => void = () => undefined;
        const firstGate = new Promise<unknown>((resolve) => {
            releaseFirst = () => {
                resolve(undefined);
            };
        });
        const a = new FakeSocket({ connectionId: "conn-1", subs: {}, userId: "member", whispers: ["room:chat", "room:two"] });
        const shard = makeShard([a], { "room:chat": "rooms:chat", "room:two": "rooms:two" }, [], {
            "rooms:chat": (event) => (event["kind"] === "leave" ? firstGate : undefined),
        });

        const closed = shard.webSocketClose(a as unknown as WebSocket, 1000, "", true);

        // Cleanup clears the attachment while the first leave is still held.
        await closed;
        releaseFirst();
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 10);
        });

        const leaves = shard.calls.filter((call) => call.args["kind"] === "leave").map((call) => call.args["socket"] as Record<string, unknown>);

        expect(leaves).toHaveLength(2);
        expect(leaves.map((socket) => socket["userId"])).toStrictEqual(["member", "member"]);
        expect(leaves.map((socket) => socket["connectionId"])).toStrictEqual(["conn-1", "conn-1"]);
    });

    it("does not hold a socket's close behind a slow onLeave", async () => {
        expect.assertions(3);

        let releaseLeave: () => void = () => undefined;
        const leaveGate = new Promise<unknown>((resolve) => {
            releaseLeave = () => {
                resolve(undefined);
            };
        });
        const a = new FakeSocket({ subs: {}, userId: "member", whispers: ["room:chat"] });
        const shard = makeShard([a], { "room:chat": "rooms:chat" }, [], {
            "rooms:chat": (event) => (event["kind"] === "leave" ? leaveGate : undefined),
        });

        const closed = shard.webSocketClose(a as unknown as WebSocket, 1000, "", true).then(() => "closed");
        const outcome = await Promise.race([
            closed,
            new Promise<string>((resolve) => {
                setTimeout(resolve, 50, "blocked");
            }),
        ]);

        // Teardown finished while onLeave is still pending.
        expect(outcome).toBe("closed");

        releaseLeave();
        await closed;

        // The leave still ran, behind the close.
        expect(roomCalls(shard).some((call) => call.args["kind"] === "leave")).toBe(true);
        expect(roomCalls(shard)).toHaveLength(1);
    });
});

describe("shardDO rooms", () => {
    it("dispatches onJoin when a socket joins the room topic", async () => {
        expect.assertions(4);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const shard = makeShard([a], { "room:chat": "rooms:chat" });

        await send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });

        const calls = roomCalls(shard);

        expect(calls).toHaveLength(1);
        expect(calls[0]?.args["kind"]).toBe("join");
        expect((calls[0]?.args["socket"] as { userId: string }).userId).toBe("user-a");
        // Membership is recorded, so a later broadcast can reach it.
        expect((a.deserializeAttachment() as { whispers?: string[] }).whispers).toEqual(["room:chat"]);
    });

    it("does NOT dispatch a room join (or record membership) when the authorizer denies", async () => {
        expect.assertions(3);

        const a = new FakeSocket({ subs: {}, userId: "member" });
        const b = new FakeSocket({ subs: {}, userId: "outsider" });
        const shard = makeShard([a, b], { "room:chat": "rooms:chat" }, ["whisper:authorize"], {
            "whisper:authorize": (event) => event["userId"] === "member",
        });

        await send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });
        await send(shard, b, { topic: "room:chat", type: "whisper_subscribe" });

        // Only the allowed member's join was dispatched.
        expect(roomCalls(shard)).toHaveLength(1);
        expect((roomCalls(shard)[0]?.args["socket"] as { userId: string }).userId).toBe("member");
        // The outsider never became a member.
        expect((b.deserializeAttachment() as { whispers?: string[] }).whispers).toBeUndefined();
    });

    it("dispatches onMessage and fans the handler's broadcast to every member (sender included)", async () => {
        expect.assertions(3);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const b = new FakeSocket({ subs: {} });
        const shard = makeShard([a, b], { "room:chat": "rooms:chat" });

        await send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });
        await send(shard, b, { topic: "room:chat", type: "whisper_subscribe" });

        await send(shard, a, { data: encodeWire({ text: "hi" }), topic: "room:chat", type: "whisper" });

        const messageCall = roomCalls(shard).find((call) => call.args["kind"] === "message");

        // The client's wire-encoded message was decoded before dispatch.
        expect(messageCall?.args["message"]).toEqual({ text: "hi" });

        // Both members received the handler's broadcast — including the sender,
        // because the server handler (not the raw client send) is authoritative.
        expect(a.frames.filter((frame) => frame.type === "whisper")).toEqual([{ data: { echo: { text: "hi" } }, topic: "room:chat", type: "whisper" }]);
        expect(b.frames.filter((frame) => frame.type === "whisper")).toEqual([{ data: { echo: { text: "hi" } }, topic: "room:chat", type: "whisper" }]);
    });

    it("dispatches onLeave when a socket unsubscribes, even if access was revoked", async () => {
        expect.assertions(2);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        let allow = true;
        const shard = makeShard([a], { "room:chat": "rooms:chat" }, ["whisper:authorize"], { "whisper:authorize": () => allow });

        await send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });

        // Revoke, then leave. A leave is never authorization-gated, so the member
        // is not stranded in a room they can no longer join.
        allow = false;
        await send(shard, a, { topic: "room:chat", type: "whisper_unsubscribe" });

        const kinds = roomCalls(shard).map((call) => call.args["kind"]);

        expect(kinds).toEqual(["join", "leave"]);
        expect((a.deserializeAttachment() as { whispers?: string[] }).whispers).toBeUndefined();
    });

    it("dispatches onLeave when a member's socket closes, not only on an explicit unsubscribe", async () => {
        expect.assertions(1);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const shard = makeShard([a], { "room:chat": "rooms:chat" });

        await send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });
        await shard.webSocketClose(a as unknown as WebSocket, 1006, "dropped", false);

        expect(roomCalls(shard).map((call) => call.args["kind"])).toEqual(["join", "leave"]);
    });

    it("does not refire onJoin for a duplicate subscribe to a room already joined", async () => {
        expect.assertions(1);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const shard = makeShard([a], { "room:chat": "rooms:chat" });

        await send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });
        await send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });

        expect(roomCalls(shard).map((call) => call.args["kind"])).toEqual(["join"]);
    });

    it("drops a room message from a socket that never joined the room", async () => {
        expect.assertions(2);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const b = new FakeSocket({ subs: {}, userId: "outsider" });
        const shard = makeShard([a, b], { "room:chat": "rooms:chat" });

        await send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });
        await send(shard, b, { data: encodeWire({ text: "forged" }), topic: "room:chat", type: "whisper" });

        expect(roomCalls(shard).filter((call) => call.args["kind"] === "message")).toHaveLength(0);
        expect(a.frames.filter((frame) => frame.type === "whisper")).toEqual([]);
    });

    it("discards a room broadcast when the handler's mutation fails, so members never see rolled-back writes", async () => {
        expect.assertions(2);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const b = new FakeSocket({ subs: {} });
        const shard = makeShard([a, b], { "room:chat": "rooms:chat" }, [], {
            "rooms:chat": (event) => {
                if (event["kind"] === "message") {
                    (event["socket"] as { broadcast: (message: unknown) => void }).broadcast({ committed: false });

                    throw new Error("write failed");
                }

                return undefined;
            },
        });

        await send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });
        await send(shard, b, { topic: "room:chat", type: "whisper_subscribe" });
        await send(shard, a, { data: encodeWire({ text: "x" }), topic: "room:chat", type: "whisper" });

        expect(a.frames.filter((frame) => frame.type === "whisper")).toEqual([]);
        expect(b.frames.filter((frame) => frame.type === "whisper")).toEqual([]);
    });

    it("leaves an ordinary whisper topic on the direct peer-relay path (no room dispatch)", async () => {
        expect.assertions(2);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const b = new FakeSocket({ subs: {} });
        const shard = makeShard([a, b], { "room:chat": "rooms:chat" });

        await send(shard, a, { topic: "cursors", type: "whisper_subscribe" });
        await send(shard, b, { topic: "cursors", type: "whisper_subscribe" });
        await send(shard, a, { data: { x: 1 }, topic: "cursors", type: "whisper" });

        // No room handler ran, and the raw whisper was relayed to the other member.
        expect(roomCalls(shard)).toHaveLength(0);
        expect(b.frames.filter((frame) => frame.type === "whisper")).toEqual([{ data: { x: 1 }, from: "user-a", topic: "cursors", type: "whisper" }]);
    });

    it("does not record membership for a join whose onJoin rejects", async () => {
        expect.assertions(1);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const shard = makeShard([a], { "room:chat": "rooms:chat" }, [], {
            "rooms:chat": () => {
                throw new Error("join refused");
            },
        });

        await send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });

        // A join the handler refused is not a member: it is undone, not left on the attachment.
        expect((a.deserializeAttachment() as { whispers?: string[] }).whispers).toBeUndefined();
    });

    it("lets a throttled socket leave a room it already joined", async () => {
        expect.assertions(2);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const shard = makeShard([a], { "room:chat": "rooms:chat" });

        await send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });

        // Exhaust the admission bucket: every further room event is refused.
        (shard as unknown as { allowWhisper: () => boolean }).allowWhisper = () => false;

        await send(shard, a, { topic: "room:chat", type: "whisper_unsubscribe" });

        expect(roomCalls(shard).map((call) => call.args["kind"])).toEqual(["join", "leave"]);
        expect((a.deserializeAttachment() as { whispers?: string[] }).whispers).toBeUndefined();
    });

    it("delivers a message sent behind a join only after that join has committed", async () => {
        expect.assertions(2);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        let releaseJoin: () => void = () => undefined;
        const joinGate = new Promise<void>((resolve) => {
            releaseJoin = resolve;
        });
        const order: string[] = [];
        const shard = makeShard([a], { "room:chat": "rooms:chat" }, [], {
            "rooms:chat": async (args) => {
                if (args["kind"] === "join") {
                    await joinGate;
                    order.push("join-committed");
                } else {
                    order.push(String(args["kind"]));
                }

                return undefined;
            },
        });

        const joined = send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });
        const messaged = send(shard, a, { data: 1, topic: "room:chat", type: "whisper" });

        releaseJoin();
        await Promise.all([joined, messaged]);

        expect(order).toEqual(["join-committed", "message"]);
        expect(roomCalls(shard).map((call) => call.args["kind"])).toEqual(["join", "message"]);
    });

    it("never dispatches a message from a socket whose join was refused", async () => {
        expect.assertions(2);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const shard = makeShard([a], { "room:chat": "rooms:chat" }, [], {
            "rooms:chat": async (args) => {
                if (args["kind"] === "join") {
                    throw new Error("join refused");
                }

                return undefined;
            },
        });

        await Promise.all([
            send(shard, a, { topic: "room:chat", type: "whisper_subscribe" }),
            send(shard, a, { data: 1, topic: "room:chat", type: "whisper" }),
        ]);

        // Only the refused join ran: the message found no membership to deliver under.
        expect(roomCalls(shard).map((call) => call.args["kind"])).toEqual(["join"]);
        expect((a.deserializeAttachment() as { whispers?: string[] }).whispers).toBeUndefined();
    });

    it("does not let a failed join erase a rejoin made after it", async () => {
        expect.assertions(1);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        let releaseFirstJoin: () => void = () => undefined;
        const firstJoinGate = new Promise<void>((resolve) => {
            releaseFirstJoin = resolve;
        });
        let joins = 0;
        const shard = makeShard([a], { "room:chat": "rooms:chat" }, [], {
            "rooms:chat": async (args) => {
                if (args["kind"] === "join") {
                    joins += 1;

                    if (joins === 1) {
                        await firstJoinGate;
                        throw new Error("first join refused");
                    }
                }

                return undefined;
            },
        });

        // Join, leave and rejoin while the first join's handler is still in flight.
        const first = send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });
        // Let the first join record its membership; its handler stays in flight at the gate.
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
        const left = send(shard, a, { topic: "room:chat", type: "whisper_unsubscribe" });
        const rejoined = send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });

        releaseFirstJoin();
        await Promise.all([first, left, rejoined]);

        // The refused first join undoes only its own membership; the rejoin is still a member.
        expect((a.deserializeAttachment() as { whispers?: string[] }).whispers).toEqual(["room:chat"]);
    });

    it("refuses a room message from a socket whose close is in flight", async () => {
        expect.assertions(1);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const shard = makeShard([a], { "room:chat": "rooms:chat" });

        await send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });
        (shard as unknown as { closingSockets: WeakSet<object> }).closingSockets.add(a);
        await send(shard, a, { data: 1, topic: "room:chat", type: "whisper" });

        expect(roomCalls(shard).map((call) => call.args["kind"])).toEqual(["join"]);
    });

    it("refuses a room message over the whisper size cap", async () => {
        expect.assertions(1);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const shard = makeShard([a], { "room:chat": "rooms:chat" });

        await send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });
        await send(shard, a, { data: "x".repeat(5000), topic: "room:chat", type: "whisper" });

        expect(roomCalls(shard).map((call) => call.args["kind"])).toEqual(["join"]);
    });

    it("does not deliver a room broadcast to a socket whose join is still settling", async () => {
        expect.assertions(1);

        const member = new FakeSocket({ subs: {}, userId: "member" });
        const joining = new FakeSocket({ subs: {}, userId: "user-a" });
        let releaseJoin: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            releaseJoin = resolve;
        });
        const shard = makeShard([member, joining], { "room:chat": "rooms:chat" }, [], {
            "rooms:chat": async (args) => {
                if (args["kind"] === "join" && (args["socket"] as { userId: string }).userId === "user-a") {
                    await gate;
                    throw new Error("join refused");
                }

                return undefined;
            },
        });

        await send(shard, member, { topic: "room:chat", type: "whisper_subscribe" });
        const pendingJoin = send(shard, joining, { topic: "room:chat", type: "whisper_subscribe" });
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });

        // The member's message is echoed to the room while the other join is still settling.
        await send(shard, member, { data: { hi: 1 }, topic: "room:chat", type: "whisper" });

        releaseJoin();
        await pendingJoin;

        expect(joining.frames.filter((frame) => frame.type === "whisper")).toEqual([]);
    });

    it("runs no onLeave for a leave queued behind a join that was refused", async () => {
        expect.assertions(1);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        let releaseJoin: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            releaseJoin = resolve;
        });
        const shard = makeShard([a], { "room:chat": "rooms:chat" }, [], {
            "rooms:chat": async (args) => {
                if (args["kind"] === "join") {
                    await gate;
                    throw new Error("join refused");
                }

                return undefined;
            },
        });

        const join = send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
        const leave = send(shard, a, { topic: "room:chat", type: "whisper_unsubscribe" });

        releaseJoin();
        await Promise.all([join, leave]);

        // The refused join never committed, so its paired leave has nothing to undo: no onLeave.
        expect(roomCalls(shard).map((call) => call.args["kind"])).toEqual(["join"]);
    });

    it("drops a message sent before a leave and rejoin instead of running it under the new membership", async () => {
        expect.assertions(1);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        let releaseFirstJoin: () => void = () => undefined;
        const firstJoinGate = new Promise<void>((resolve) => {
            releaseFirstJoin = resolve;
        });
        let joins = 0;
        const shard = makeShard([a], { "room:chat": "rooms:chat" }, [], {
            "rooms:chat": async (args) => {
                if (args["kind"] === "join") {
                    joins += 1;

                    if (joins === 1) {
                        await firstJoinGate;
                    }
                }

                return undefined;
            },
        });
        const settle = async (): Promise<void> => {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
            });
        };

        const firstJoin = send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });
        await settle();
        // Sent under the first membership, queued behind the still-running join.
        const message = send(shard, a, { data: { n: 1 }, topic: "room:chat", type: "whisper" });
        await settle();
        const leave = send(shard, a, { topic: "room:chat", type: "whisper_unsubscribe" });
        const rejoin = send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });

        releaseFirstJoin();
        await Promise.all([firstJoin, message, leave, rejoin]);

        // The message ran under a membership that no longer exists, so it is dropped.
        expect(roomCalls(shard).map((call) => call.args["kind"])).toEqual(["join", "leave", "join"]);
    });

    it("does not deliver a join's own broadcast to the joining socket, but does to the members already in the room", async () => {
        expect.assertions(2);

        const member = new FakeSocket({ subs: {}, userId: "member" });
        const joiner = new FakeSocket({ subs: {}, userId: "joiner" });
        const shard = makeShard([member, joiner], { "room:chat": "rooms:chat" }, [], {
            "rooms:chat": (args) => {
                if (args["kind"] === "join") {
                    (args["socket"] as { broadcast: (message: unknown) => void }).broadcast({ welcome: (args["socket"] as { userId: string }).userId });
                }

                return undefined;
            },
        });

        await send(shard, member, { topic: "room:chat", type: "whisper_subscribe" });
        await send(shard, joiner, { topic: "room:chat", type: "whisper_subscribe" });

        // The joiner's own welcome is not delivered to it...
        expect(joiner.frames.filter((frame) => frame.type === "whisper")).toStrictEqual([]);
        // ...but the member already in the room receives it.
        expect(member.frames.filter((frame) => frame.type === "whisper").map((frame) => frame.data)).toStrictEqual([{ welcome: "joiner" }]);
    });

    it("caps the room events a single socket can queue behind a slow handler", async () => {
        expect.assertions(1);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        let releaseJoin: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            releaseJoin = resolve;
        });
        const shard = makeShard([a], { "room:chat": "rooms:chat" }, [], {
            "rooms:chat": async (args) => {
                if (args["kind"] === "join") {
                    await gate;
                }

                return undefined;
            },
        });

        // Admit every message, so the queue bound is what limits them, not the message budget.
        (shard as unknown as { allowWhisper: () => boolean }).allowWhisper = () => true;

        const pending = [send(shard, a, { topic: "room:chat", type: "whisper_subscribe" })];
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });

        // Seventy messages behind the slow join: only what fits the queue runs.
        for (let index = 0; index < 70; index += 1) {
            pending.push(send(shard, a, { data: index, topic: "room:chat", type: "whisper" }));
        }

        releaseJoin();
        await Promise.all(pending);

        // The join plus the messages that fit the 64-event queue; the rest were refused.
        expect(roomCalls(shard)).toHaveLength(64);
    });

    it("delivers a room update whose write committed even when its post-commit step fails", async () => {
        expect.assertions(2);

        const member = new FakeSocket({ subs: {}, userId: "member" });
        const sender = new FakeSocket({ subs: {}, userId: "user-a" });
        // The handler broadcasts after its write, then the post-commit schedule step fails.
        let committed = true;
        const shard = makeShard([member, sender], { "room:chat": "rooms:chat" }, [], {
            "rooms:chat": (args) => {
                if (args["kind"] === "message") {
                    (args["socket"] as { broadcast: (message: unknown) => void }).broadcast({ update: 1 });

                    throw committed ? Object.assign(new Error("deferred schedule would not enqueue"), { committed: true }) : new Error("pre-commit failure");
                }

                return undefined;
            },
        });

        await send(shard, member, { topic: "room:chat", type: "whisper_subscribe" });
        await send(shard, sender, { topic: "room:chat", type: "whisper_subscribe" });
        await send(shard, sender, { data: "x", topic: "room:chat", type: "whisper" });

        // The write is durable, so members hear it.
        expect(member.frames.filter((frame) => frame.type === "whisper").map((frame) => frame.data)).toStrictEqual([{ update: 1 }]);

        // A failure before the commit is a rollback: the broadcast is discarded.
        committed = false;
        const before = member.frames.length;

        await send(shard, sender, { data: "y", topic: "room:chat", type: "whisper" });

        expect(member.frames).toHaveLength(before);
    });

    it("still runs onLeave for a leave that arrives while the queue is full", async () => {
        expect.assertions(1);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        let releaseJoin: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            releaseJoin = resolve;
        });
        const shard = makeShard([a], { "room:chat": "rooms:chat" }, [], {
            "rooms:chat": async (args) => {
                if (args["kind"] === "join") {
                    await gate;
                }

                return undefined;
            },
        });
        (shard as unknown as { allowWhisper: () => boolean }).allowWhisper = () => true;

        const pending = [send(shard, a, { topic: "room:chat", type: "whisper_subscribe" })];
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });

        // Fill the queue behind the slow join, then leave.
        for (let index = 0; index < 70; index += 1) {
            pending.push(send(shard, a, { data: index, topic: "room:chat", type: "whisper" }));
        }
        pending.push(send(shard, a, { topic: "room:chat", type: "whisper_unsubscribe" }));

        releaseJoin();
        await Promise.all(pending);

        // The leave is queued even at the cap, so the room's onLeave runs.
        expect(roomCalls(shard).at(-1)?.args["kind"]).toBe("leave");
    });

    it("keeps a member's room membership across a hibernation wake-up", async () => {
        expect.assertions(2);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const before = makeShard([a], { "room:chat": "rooms:chat" });

        await send(before, a, { topic: "room:chat", type: "whisper_subscribe" });

        // A fresh instance over the same sockets reads membership back off the attachment alone.
        const woken = makeShard([a], { "room:chat": "rooms:chat" });

        await send(woken, a, { data: { n: 1 }, topic: "room:chat", type: "whisper" });

        expect(roomCalls(woken).map((call) => call.args["kind"])).toEqual(["message"]);
        expect(roomCalls(woken)[0]?.args["message"]).toEqual({ n: 1 });
    });

    it("undoes a join when reading the socket's attachment fails inside the queued handler", async () => {
        expect.assertions(2);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const shard = makeShard([a], { "room:chat": "rooms:chat" });
        const internals = shard as unknown as { lifecycleInfo: (attachment: unknown) => unknown; logs: { entries: () => { message: string }[] } };
        const lifecycleInfo = internals.lifecycleInfo.bind(shard);
        let failed = false;

        // The first room-handler dispatch reads the attachment, which fails once.
        internals.lifecycleInfo = (attachment: unknown) => {
            if (!failed) {
                failed = true;

                throw new Error("corrupt attachment");
            }

            return lifecycleInfo(attachment);
        };

        await send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });

        // The join it was establishing is undone, and the failure is recorded.
        expect((a.deserializeAttachment() as { whispers?: string[] }).whispers).toBeUndefined();
        expect(internals.logs.entries().map((entry) => entry.message)).toContain("corrupt attachment");
    });

    it("admits a room join even after the socket has spent its message budget", async () => {
        expect.assertions(1);

        const a = new FakeSocket({ subs: {}, userId: "user-a" });
        const shard = makeShard([a], { "room:chat": "rooms:chat" });

        // Message traffic has drained the message bucket: joins draw from their own bucket.
        (shard as unknown as { allowWhisper: () => boolean }).allowWhisper = () => false;

        await send(shard, a, { topic: "room:chat", type: "whisper_subscribe" });

        expect(roomCalls(shard).map((call) => call.args["kind"])).toEqual(["join"]);
    });
});
