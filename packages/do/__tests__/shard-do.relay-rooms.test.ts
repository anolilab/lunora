import { encodeWire } from "@lunora/wire";
import { afterEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A room on a relay-hosted socket. The relay holds the socket and its membership, but
 * the room's handler runs on the owner: join, message and leave are forwarded there over
 * the relay control channel, and a refused join is undone on the relay. Both DOs run for
 * real against their own SQLite; the namespace binding routes each to the other in-process.
 */

const OWNER = "room-1";
const RELAY = `${OWNER}::relay::0`;
const TOPIC = "room:chat";

interface Frame {
    topic?: string;
    type: string;
}

/** Round-trips the hibernation attachment and records the frames sent to it. */
class FakeSocket {
    public readonly frames: Frame[] = [];

    private attachment: unknown;

    public constructor(initial?: unknown) {
        this.attachment = initial;
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

/** The room handler stands in for the app's `onJoin` / `onMessage` / `onLeave`; a join it refuses throws. */
class RoomShard extends ShardDO {
    public readonly calls: RoomCall[] = [];

    public constructor(
        state: ShardDOState,
        env: unknown,
        private readonly admitJoin: () => boolean,
    ) {
        super(state, env);
    }

    public override handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        this.calls.push({ args, functionPath });

        if (args["kind"] === "join" && !this.admitJoin()) {
            return Promise.reject(new Error("join refused by the room handler"));
        }

        if (args["kind"] === "message") {
            (args["socket"] as { broadcast: (message: unknown) => void }).broadcast({ echo: args["message"] });
        }

        if (args["kind"] === "join") {
            (args["socket"] as { broadcast: (message: unknown) => void }).broadcast({ joined: (args["socket"] as { userId: string }).userId });
        }

        return Promise.resolve(undefined);
    }

    // eslint-disable-next-line class-methods-use-this -- test fixture: one fixed room topic, no instance state
    protected override roomHandlerPath(topic: string): string | undefined {
        return topic === TOPIC ? "rooms:chat" : undefined;
    }
}

const flush = async (): Promise<void> => {
    await new Promise((resolve) => {
        setTimeout(resolve, 5);
    });
};

describe("shardDO rooms on a relay", () => {
    const databases: ReturnType<typeof createSqliteExec>[] = [];

    afterEach(() => {
        for (const database of databases.splice(0)) {
            database.close();
        }
    });

    /** An owner and one of its relays, each with its own SQLite, wired to reach the other. */
    const makeRig = (admitJoin: () => boolean = () => true) => {
        const ownerDb = createSqliteExec();
        const relayDb = createSqliteExec();

        databases.push(ownerDb, relayDb);

        const relaySockets: FakeSocket[] = [];
        const ownerState = {
            acceptWebSocket() {},
            getWebSockets: () => [],
            id: { name: OWNER },
            storage: { sql: ownerDb.sql as unknown as ShardDOState["storage"]["sql"] },
        } as unknown as ShardDOState;
        const relayState = {
            acceptWebSocket() {},
            getWebSockets: () => relaySockets,
            id: { name: RELAY },
            storage: { sql: relayDb.sql as unknown as ShardDOState["storage"]["sql"] },
        } as unknown as ShardDOState;

        // Each DO reaches its sibling through the binding. The name is ignored: there is one of each.
        const peers: { owner?: RoomShard; relay?: RoomShard } = {};
        const reach = (target: () => RoomShard | undefined) => {
            return {
                get: () => {
                    return {
                        fetch: (url: string, init?: RequestInit): Promise<Response> => {
                            const peer = target();

                            if (peer === undefined) {
                                throw new Error("peer not wired");
                            }

                            return peer.fetch(new Request(url, init));
                        },
                    };
                },
                idFromName: (name: string) => name,
            };
        };

        peers.owner = new RoomShard(ownerState, { SHARD: reach(() => peers.relay) }, admitJoin);
        peers.relay = new RoomShard(relayState, { SHARD: reach(() => peers.owner) }, () => true);
        const { owner, relay } = peers as { owner: RoomShard; relay: RoomShard };

        // The runtime stamps the binding on forwarded requests; set it directly here.
        Object.assign(owner, { shardBinding: "SHARD" });
        Object.assign(relay, { shardBinding: "SHARD" });

        const socket = new FakeSocket({ connectionId: "conn-1", subs: {}, userId: "user-a" });

        relaySockets.push(socket);

        const send = (envelope: Record<string, unknown>): Promise<void> => relay.webSocketMessage(socket as unknown as WebSocket, JSON.stringify(envelope));

        return { owner, relay, relaySockets, send, socket };
    };

    it("forwards a join to the owner, which runs onJoin as the relay socket, and records membership on the relay", async () => {
        expect.assertions(4);

        const { owner, send, socket } = makeRig();

        await send({ topic: TOPIC, type: "whisper_subscribe" });

        const calls = owner.calls.filter((call) => call.functionPath === "rooms:chat");

        expect(calls).toHaveLength(1);
        expect(calls[0]?.args["kind"]).toBe("join");
        expect((calls[0]?.args["socket"] as { userId: string }).userId).toBe("user-a");
        expect((socket.deserializeAttachment() as { whispers?: string[] }).whispers).toEqual([TOPIC]);
    });

    it("forwards a message to the owner's handler and delivers the owner's broadcast back to the relay socket", async () => {
        expect.assertions(2);

        const { owner, send, socket } = makeRig();

        await send({ topic: TOPIC, type: "whisper_subscribe" });
        await send({ data: encodeWire({ text: "hi" }), topic: TOPIC, type: "whisper" });
        await flush();

        const message = owner.calls.find((call) => call.args["kind"] === "message");

        expect(message?.args["message"]).toEqual({ text: "hi" });
        expect(socket.frames.filter((frame) => frame.type === "whisper" && frame.topic === TOPIC)).toHaveLength(1);
    });

    it("does not send a relay-hosted joiner its own join broadcast, but sends it to the other members on that relay", async () => {
        expect.assertions(2);

        const { relay, relaySockets, socket } = makeRig();
        const peer = new FakeSocket({ connectionId: "conn-2", subs: {}, userId: "user-b" });

        relaySockets.push(peer);
        await relay.webSocketMessage(peer as unknown as WebSocket, JSON.stringify({ topic: TOPIC, type: "whisper_subscribe" }));
        await relay.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ topic: TOPIC, type: "whisper_subscribe" }));
        await flush();

        // The joiner's own `{ joined: "user-a" }` broadcast is skipped on its socket...
        expect(socket.frames.filter((frame) => frame.type === "whisper")).toHaveLength(0);
        // ...while the member who was already there receives it.
        expect(peer.frames.filter((frame) => frame.type === "whisper" && frame.topic === TOPIC)).toHaveLength(1);
    });

    it("keeps no per-socket state on the owner: a relay socket's stand-in is not retained between events", async () => {
        expect.assertions(1);

        const { owner, send } = makeRig();

        await send({ topic: TOPIC, type: "whisper_subscribe" });
        await flush();

        // A relay socket can vanish without a close; nothing on the owner may wait for one.
        expect(Object.keys(owner)).not.toContain("relayRoomProxies");
    });

    it("forwards a leave to the owner's onLeave and clears the relay membership", async () => {
        expect.assertions(3);

        const { owner, send, socket } = makeRig();

        await send({ topic: TOPIC, type: "whisper_subscribe" });
        await send({ topic: TOPIC, type: "whisper_unsubscribe" });

        const leave = owner.calls.find((call) => call.args["kind"] === "leave");

        expect(leave).toBeDefined();
        expect(leave?.functionPath).toBe("rooms:chat");
        expect((socket.deserializeAttachment() as { whispers?: string[] }).whispers).toBeUndefined();
    });

    it("refuses a join the owner refuses: no membership on the relay, and the refusal is logged", async () => {
        expect.assertions(3);

        const { owner, relay, send, socket } = makeRig(() => false);

        await send({ topic: TOPIC, type: "whisper_subscribe" });

        expect(owner.calls.some((call) => call.args["kind"] === "join")).toBe(true);
        expect((socket.deserializeAttachment() as { whispers?: string[] }).whispers).toBeUndefined();

        const logs = (relay as unknown as { logs: { buffer: { functionPath: string; level: string }[] } }).logs.buffer;

        expect(logs.some((entry) => entry.functionPath === "rooms:chat" && entry.level === "error")).toBe(true);
    });

    it("forwards the leave when the relay socket closes while still in the room", async () => {
        expect.assertions(3);

        const { owner, relay, send, socket } = makeRig();

        await send({ topic: TOPIC, type: "whisper_subscribe" });
        await relay.webSocketClose(socket as unknown as WebSocket, 1000, "", true);

        expect(owner.calls.filter((call) => call.args["kind"] === "leave")).toHaveLength(1);
        expect((owner.calls.find((call) => call.args["kind"] === "leave")?.args["socket"] as { connectionId?: string }).connectionId).toBe("conn-1");
        expect(owner.calls.find((call) => call.args["kind"] === "leave")?.functionPath).toBe("rooms:chat");
    });
});
