import { v } from "@lunora/values";
import { describe, expect, it, vi } from "vitest";

import type { RoomJoinHandler, RoomLeaveHandler, RoomMessageHandler, RoomSocket } from "../src/index";
import { defineRoom } from "../src/index";

const makeSocket = (overrides: Partial<RoomSocket> = {}): RoomSocket => {
    return {
        broadcast: vi.fn<(message: unknown) => void>(),
        connectionId: "conn-1",
        shardKey: "__root__",
        userId: "user-1",
        ...overrides,
    };
};

const dispatch = (room: ReturnType<typeof defineRoom>, event: Record<string, unknown>): Promise<void> =>
    room.handler({}, event as unknown as Record<string, never>) as Promise<void>;

describe("defineRoom", () => {
    it("tags an internal mutation on the room channel, keyed by its name", () => {
        expect.assertions(4);

        const room = defineRoom({ message: v.object({ text: v.string() }), name: "chat", onMessage: () => undefined });

        // A mutation, not a query: `onMessage` writes room state to the shard's
        // SQLite, so it needs the mutation transaction wrapper.
        expect(room.kind).toBe("mutation");
        expect(room.visibility).toBe("internal");
        // A channel, not a lifecycle moment: a socket reaches it by name.
        expect(room.lifecycle).toBeUndefined();
        expect(room.channel).toStrictEqual({ kind: "room", name: "chat" });
    });

    it("rejects an empty name", () => {
        expect.assertions(1);

        expect(() => defineRoom({ message: v.object({}), name: "", onMessage: () => undefined })).toThrow(/non-empty string/u);
    });

    it("routes a `join` to onJoin with the socket and no message", async () => {
        expect.assertions(2);

        const onJoin = vi.fn<RoomJoinHandler<{ text: string }>>();
        const onMessage = vi.fn<RoomMessageHandler<{ text: string }>>();
        const room = defineRoom({ message: v.object({ text: v.string() }), name: "chat", onJoin, onMessage });
        const socket = makeSocket();

        await dispatch(room, { kind: "join", socket });

        expect(onJoin).toHaveBeenCalledWith(expect.anything(), socket);
        expect(onMessage).not.toHaveBeenCalled();
    });

    it("routes a `leave` to onLeave", async () => {
        expect.assertions(1);

        const onLeave = vi.fn<RoomLeaveHandler<{ text: string }>>();
        const room = defineRoom({ message: v.object({ text: v.string() }), name: "chat", onLeave, onMessage: () => undefined });
        const socket = makeSocket();

        await dispatch(room, { kind: "leave", socket });

        expect(onLeave).toHaveBeenCalledWith(expect.anything(), socket);
    });

    it("validates and forwards a typed `message` to onMessage", async () => {
        expect.assertions(2);

        const onMessage = vi.fn<RoomMessageHandler<{ author: string; text: string }>>();
        const room = defineRoom({ message: v.object({ author: v.string(), text: v.string() }), name: "chat", onMessage });
        const socket = makeSocket();

        await dispatch(room, { kind: "message", message: { author: "ada", text: "hi" }, socket });

        expect(onMessage).toHaveBeenCalledTimes(1);
        expect(onMessage).toHaveBeenCalledWith(expect.anything(), { author: "ada", text: "hi" }, socket);
    });

    it("refuses a message that does not match the validator", async () => {
        expect.assertions(2);

        const onMessage = vi.fn<RoomMessageHandler<{ text: string }>>();
        const room = defineRoom({ message: v.object({ text: v.string() }), name: "chat", onMessage });

        await expect(dispatch(room, { kind: "message", message: { text: 42 }, socket: makeSocket() })).rejects.toThrow(/message/u);
        expect(onMessage).not.toHaveBeenCalled();
    });

    it("is a no-op for a join/leave with no handler declared", async () => {
        expect.assertions(0);

        const room = defineRoom({ message: v.object({}), name: "chat", onMessage: () => undefined });

        await dispatch(room, { kind: "join", socket: makeSocket() });
        await dispatch(room, { kind: "leave", socket: makeSocket() });
    });
});
