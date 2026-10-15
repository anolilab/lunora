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
        expect(a.frames).toEqual([{ data: { echo: { text: "hi" } }, topic: "room:chat", type: "whisper" }]);
        expect(b.frames).toEqual([{ data: { echo: { text: "hi" } }, topic: "room:chat", type: "whisper" }]);
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
        expect(a.frames).toEqual([]);
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

        expect(a.frames).toEqual([]);
        expect(b.frames).toEqual([]);
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
        expect(b.frames).toEqual([{ data: { x: 1 }, from: "user-a", topic: "cursors", type: "whisper" }]);
    });
});
