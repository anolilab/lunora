import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeliveryAuthorization } from "../src/delivery-authorization";
import { cleanupDatabases, gate, setup, Socket, TestShard } from "./_helpers/delivery-authorization";

class RoomShard extends TestShard {
    public readonly roomCalls: string[] = [];
    public readonly leaveStarted = gate();
    public leaveGate: Promise<void> | undefined;
    private readonly rooms = new Map([["room:chat", "rooms:chat"]]);

    public enableAuthorization(authority: DeliveryAuthorization): void {
        Reflect.set(this, "deliveryAuthorization", authority);
    }

    public deliveredWhispers(): number {
        return this["fanout"].whisper.socketsDelivered;
    }

    public override async handleRpc(path: string, args: Record<string, unknown> = {}): Promise<unknown> {
        if (path === "rooms:chat") {
            this.roomCalls.push(String(args.kind));
            if (args.kind === "leave") {
                (args.socket as { broadcast: (value: unknown) => void }).broadcast({ left: true });
                this.leaveStarted.resolve();
                await this.leaveGate;
            }
            return undefined;
        }
        return super.handleRpc(path);
    }

    protected override roomHandlerPath(topic: string): string | undefined {
        return this.rooms.get(topic);
    }
}
const send = (shard: RoomShard, socket: Socket, type: string, topic = "room:chat") =>
    shard.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type, topic }));

const retainedRooms = async (hibernated = false) => {
    const test = setup();
    let sockets = [test.socket, new Socket()];
    const state = { ...test.state, getWebSockets: () => sockets as unknown as WebSocket[] };
    const original = new RoomShard(state, {});
    const first = sockets[0];
    const second = sockets[1];
    if (!first || !second) {
        throw new Error("missing sockets");
    }
    await send(original, first, "whisper_subscribe");
    await send(original, second, "whisper_subscribe");
    await send(original, second, "whisper_subscribe", "presence");

    await test.send(original);

    const joins = [...original.roomCalls];
    original.roomCalls.length = 0;
    const enable = () => {
        if (!hibernated) {
            original.enableAuthorization(test.authority);
            return original;
        }
        sockets = sockets.map((socket) => {
            const resumed = new Socket();
            resumed.attachment = structuredClone(socket.attachment);
            return resumed;
        });
        return new RoomShard(state, {}, { deliveryAuthorization: test.authority });
    };
    const members = (): [Socket, Socket] => {
        const a = sockets[0];
        const b = sockets[1];
        if (!a || !b) {
            throw new Error("missing sockets");
        }
        return [a, b];
    };
    const exclude = (socket: Socket): void => {
        sockets = sockets.filter((candidate) => candidate !== socket);
    };
    return { enable, exclude, joins, members, original, state };
};

describe("retained rooms when delivery authorization is enabled", () => {
    afterEach(cleanupDatabases);

    it("does not rescan sibling attachments after the retained memberships were removed", async () => {
        expect.hasAssertions();

        const test = await retainedRooms();
        const shard = test.enable();
        const [sender, sibling] = test.members();
        await send(shard, sender, "whisper_unsubscribe");
        const reads = vi.spyOn(sibling, "deserializeAttachment");
        await send(shard, sender, "whisper");
        await send(shard, sender, "connect");
        await send(shard, sender, "whisper_subscribe");
        await send(shard, sender, "whisper");

        expect(reads).not.toHaveBeenCalled();
        expect(sibling.attachment.whispers).toBeUndefined();
        expect(shard.roomCalls).toEqual([]);
    });

    it("includes a closing socket even after the host stopped enumerating it", async () => {
        expect.hasAssertions();

        const test = await retainedRooms(true);
        const shard = test.enable();
        const [closing, remaining] = test.members();

        test.exclude(closing);

        await shard.webSocketClose(closing as unknown as WebSocket, 1000, "closed", true);

        expect(closing.frames.filter((frame) => frame.type === "error")).toEqual([expect.objectContaining({ topic: "room:chat", code: "NOT_IMPLEMENTED" })]);
        expect(remaining.attachment.whispers).toBeUndefined();
        expect(shard.roomCalls).toEqual([]);
    });

    it("retries a sweep that threw before all retained sockets were visited", async () => {
        expect.hasAssertions();

        const test = await retainedRooms(true);
        const shard = test.enable();
        const [sender, sibling] = test.members();
        vi.spyOn(sibling, "deserializeAttachment").mockImplementationOnce(() => {
            throw new Error("attachment read unavailable");
        });

        await expect(send(shard, sender, "whisper_unsubscribe")).rejects.toThrow("attachment read unavailable");

        await send(shard, sender, "connect");

        expect(sibling.attachment.whispers).toBeUndefined();
        expect(sibling.frames.filter((frame) => frame.type === "error")).toHaveLength(2);
        expect(shard.roomCalls).toEqual([]);
    });

    it.each([false, true])("removes and notifies retained room and whisper members before onLeave with hibernated=%s", async (hibernated) => {
        expect.hasAssertions();

        const test = await retainedRooms(hibernated);

        expect(test.joins).toEqual(["join", "join"]);

        const shard = test.enable();
        const [leaving, remaining] = test.members();
        await send(shard, leaving, "whisper_unsubscribe");

        expect(shard.roomCalls).toEqual([]);
        expect(test.members().map((socket) => socket.attachment.whispers)).toEqual([undefined, undefined]);
        expect(test.members().map((socket) => socket.frames.filter((frame) => frame.type === "error"))).toEqual([
            [expect.objectContaining({ code: "NOT_IMPLEMENTED", topic: "room:chat" })],
            [expect.objectContaining({ code: "NOT_IMPLEMENTED", topic: "room:chat" }), expect.objectContaining({ code: "NOT_IMPLEMENTED", topic: "presence" })],
        ]);
        expect(leaving.attachment.subs.view).toBeDefined();
        expect(remaining.frames.filter((frame) => frame.type === "whisper")).toEqual([]);
        expect(shard.deliveredWhispers()).toBe(0);
    });

    it("retires retained memberships before a closing socket can dispatch onLeave", async () => {
        expect.hasAssertions();

        const test = await retainedRooms(true);
        const shard = test.enable();
        const [leaving, remaining] = test.members();
        await shard.webSocketClose(leaving as unknown as WebSocket, 1000, "closed", true);

        expect(shard.roomCalls).toEqual([]);
        expect(remaining.attachment.whispers).toBeUndefined();
        expect(remaining.frames.filter((frame) => frame.type === "error")).toHaveLength(2);
        expect(shard.deliveredWhispers()).toBe(0);
    });

    it("rejects an onLeave broadcast that was already waiting when authorization was enabled", async () => {
        expect.hasAssertions();

        const test = await retainedRooms();
        const [leaving, remaining] = test.members();
        const release = gate();

        test.original.leaveGate = release.promise;

        const pending = send(test.original, leaving, "whisper_unsubscribe");

        await test.original.leaveStarted.promise;

        const shard = test.enable();
        release.resolve();
        await pending;

        expect(shard.roomCalls).toEqual(["leave"]);
        expect(remaining.attachment.whispers).toBeUndefined();
        expect(remaining.frames.filter((frame) => frame.type === "error")).toHaveLength(2);
        expect(remaining.frames.filter((frame) => frame.type === "whisper")).toEqual([]);
        expect(shard.deliveredWhispers()).toBe(0);
    });

    it("retries failed attachment cleanup without running the room handler", async () => {
        expect.hasAssertions();

        const test = await retainedRooms(true);
        const shard = test.enable();
        const [leaving, remaining] = test.members();
        const save = vi.spyOn(remaining, "serializeAttachment").mockImplementationOnce(() => {
            throw new Error("attachment unavailable");
        });
        await send(shard, leaving, "whisper_unsubscribe");

        expect(remaining.attachment.whispers).toEqual(["room:chat"]);
        expect(shard.roomCalls).toEqual([]);

        save.mockRestore();
        await send(shard, remaining, "whisper_unsubscribe");

        expect(remaining.attachment.whispers).toBeUndefined();
        expect(shard.roomCalls).toEqual([]);
    });

    it("preserves feature-off onLeave broadcasts and counts only successful sends", async () => {
        expect.hasAssertions();

        const test = await retainedRooms();
        const [leaving, remaining] = test.members();
        vi.spyOn(remaining, "send").mockImplementationOnce(() => {
            throw new Error("closed receiver");
        });
        await send(test.original, leaving, "whisper_unsubscribe");

        expect(test.original.roomCalls).toEqual(["leave"]);
        expect(test.original.deliveredWhispers()).toBe(0);

        await send(test.original, leaving, "whisper_subscribe");
        await send(test.original, leaving, "whisper_unsubscribe");

        expect(remaining.frames.filter((frame) => frame.type === "whisper")).toEqual([expect.objectContaining({ data: { left: true } })]);
        expect(test.original.deliveredWhispers()).toBe(1);
    });
});
