import { v } from "@lunora/values";
import { describe, expect, it, vi } from "vitest";

import type { WebSocketHandle, WebSocketMessageHandler } from "../src/index";
import { defineWebSocket } from "../src/index";

const makeSocket = (overrides: Partial<WebSocketHandle> = {}): WebSocketHandle => {
    return {
        broadcast: vi.fn<(message: unknown) => void>(),
        connectionId: "conn-1",
        path: "/chat",
        send: vi.fn<(message: unknown) => void>(),
        shardKey: "__root__",
        userId: "user-1",
        ...overrides,
    };
};

const dispatch = (route: ReturnType<typeof defineWebSocket>, event: Record<string, unknown>): Promise<void> =>
    route.handler({}, event as unknown as Record<string, never>) as Promise<void>;

describe("defineWebSocket", () => {
    it("tags an internal mutation marked `socket`, keyed by its path", () => {
        expect.assertions(4);

        const route = defineWebSocket({ message: v.object({ text: v.string() }), onMessage: () => undefined, path: "/chat" });

        // A mutation, not a query: the handler may write state to the shard's
        // SQLite, so it needs the mutation transaction wrapper.
        expect(route.kind).toBe("mutation");
        expect(route.visibility).toBe("internal");
        expect(route.lifecycle).toBe("socket");
        expect(route.socketPath).toBe("/chat");
    });

    it("defaults `auth` to false (anonymous sockets allowed)", () => {
        expect.assertions(1);

        expect(defineWebSocket({ message: v.object({}), onMessage: () => undefined, path: "/chat" }).auth).toBe(false);
    });

    it("carries an explicit `auth: true`", () => {
        expect.assertions(1);

        expect(defineWebSocket({ auth: true, message: v.object({}), onMessage: () => undefined, path: "/chat" }).auth).toBe(true);
    });

    it("rejects an empty or relative path", () => {
        expect.assertions(3);

        expect(() => defineWebSocket({ message: v.object({}), onMessage: () => undefined, path: "" })).toThrow(/plain URL path/u);
        expect(() => defineWebSocket({ message: v.object({}), onMessage: () => undefined, path: "chat" })).toThrow(/starting with/u);
        // A query string is not part of the pathname the worker matches, so the route could never be reached.
        expect(() => defineWebSocket({ message: v.object({}), onMessage: () => undefined, path: "/chat?room=1" })).toThrow(/plain URL path/u);
    });

    it("rejects a path under the reserved `/_lunora` prefix", () => {
        expect.assertions(3);

        // The sync socket upgrades at `/_lunora/ws`; a route there would take over every subscription socket.
        expect(() => defineWebSocket({ message: v.object({}), onMessage: () => undefined, path: "/_lunora/ws" })).toThrow(/reserved `\/_lunora`/u);
        expect(() => defineWebSocket({ message: v.object({}), onMessage: () => undefined, path: "/_lunora" })).toThrow(/reserved `\/_lunora`/u);
        // A sibling that merely starts with the same letters is an ordinary app path.
        expect(() => defineWebSocket({ message: v.object({}), onMessage: () => undefined, path: "/_lunorachat" })).not.toThrow();
    });

    it("routes an `open` to onOpen with the socket and no message", async () => {
        expect.assertions(2);

        const onOpen = vi.fn<(context: unknown, socket: WebSocketHandle) => void>();
        const onMessage = vi.fn<WebSocketMessageHandler<{ text: string }>>();
        const route = defineWebSocket({ message: v.object({ text: v.string() }), onMessage, onOpen, path: "/chat" });
        const socket = makeSocket();

        await dispatch(route, { kind: "open", socket });

        expect(onOpen).toHaveBeenCalledWith(expect.anything(), socket);
        expect(onMessage).not.toHaveBeenCalled();
    });

    it("routes a `close` to onClose", async () => {
        expect.assertions(1);

        const onClose = vi.fn<(context: unknown, socket: WebSocketHandle) => void>();
        const route = defineWebSocket({ message: v.object({}), onClose, onMessage: () => undefined, path: "/chat" });
        const socket = makeSocket();

        await dispatch(route, { kind: "close", socket });

        expect(onClose).toHaveBeenCalledWith(expect.anything(), socket);
    });

    it("validates and forwards a typed `message` to onMessage", async () => {
        expect.assertions(2);

        const onMessage = vi.fn<WebSocketMessageHandler<{ author: string; text: string }>>();
        const route = defineWebSocket({ message: v.object({ author: v.string(), text: v.string() }), onMessage, path: "/chat" });
        const socket = makeSocket();

        await dispatch(route, { kind: "message", message: { author: "ada", text: "hi" }, socket });

        expect(onMessage).toHaveBeenCalledTimes(1);
        expect(onMessage).toHaveBeenCalledWith(expect.anything(), { author: "ada", text: "hi" }, socket);
    });

    it("refuses a message that does not match the validator", async () => {
        expect.assertions(2);

        const onMessage = vi.fn<WebSocketMessageHandler<{ text: string }>>();
        const route = defineWebSocket({ message: v.object({ text: v.string() }), onMessage, path: "/chat" });

        await expect(dispatch(route, { kind: "message", message: { text: 42 }, socket: makeSocket() })).rejects.toThrow(/message/u);
        expect(onMessage).not.toHaveBeenCalled();
    });

    it("is a no-op for an open/close with no handler declared", async () => {
        expect.assertions(0);

        const route = defineWebSocket({ message: v.object({}), onMessage: () => undefined, path: "/chat" });

        await dispatch(route, { kind: "open", socket: makeSocket() });
        await dispatch(route, { kind: "close", socket: makeSocket() });
    });
});
