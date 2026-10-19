import { OwnerRelay } from "@lunora/shard-engine";
import { encodeWire } from "@lunora/wire";
import { describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

/**
 * `defineWebSocket` over the real DO paths: the upgrade (auth gate + attachment
 * stamping + `onOpen`), a typed message round-trip through `webSocketMessage`,
 * and a `socket.broadcast` fan-out to every socket on the route. The reserved
 * route topic is the whisper channel, so the fan-out reuses the same local
 * delivery the room tests exercise.
 */

const CHAT_TOPIC = "__lunora_socket__:sockets:chat";

interface Frame {
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

interface SocketCall {
    args: Record<string, unknown>;
    functionPath: string;
}

/**
 * A shard with the socket route map wired in — the generated subclass's
 * `socketRoute` override faked here so the base class's dispatch is what the
 * assertions exercise. `onMessage` echoes the message back to the whole route
 * (broadcast), `onOpen` sends to the one socket (send).
 */
class SocketShard extends ShardDO {
    public readonly calls: SocketCall[] = [];

    public constructor(
        state: ShardDOState,
        private readonly routes: Record<string, { auth: boolean; functionPath: string }>,
        options: ConstructorParameters<typeof ShardDO>[2] = {},
    ) {
        super(state, {}, options);
    }

    public override handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        this.calls.push({ args, functionPath });

        const socket = args["socket"] as { broadcast: (message: unknown) => void; send: (message: unknown) => void };

        if (args["kind"] === "message") {
            socket.broadcast({ echo: args["message"] });
        } else if (args["kind"] === "open") {
            socket.send({ opened: true });
        }

        return Promise.resolve(undefined);
    }

    protected override socketRoute(path: string): { auth: boolean; functionPath: string } | undefined {
        return this.routes[path];
    }
}

const makeShard = (sockets: FakeSocket[], routes: Record<string, { auth: boolean; functionPath: string }>): SocketShard => {
    const state = {
        acceptWebSocket(ws: FakeSocket) {
            sockets.push(ws);
        },
        getWebSockets: () => sockets,
        storage: { sql: {} },
    } as unknown as ShardDOState;

    return new SocketShard(state, routes);
};

const send = async (shard: SocketShard, ws: FakeSocket, raw: string): Promise<void> => {
    await shard.webSocketMessage(ws as unknown as WebSocket, raw);
};

const socketCalls = (shard: SocketShard): SocketCall[] => shard.calls.filter((call) => call.functionPath === "sockets:chat");

const CHAT_ROUTE = { "/chat": { auth: false, functionPath: "sockets:chat" } };

describe("shardDO socket routes", () => {
    it("refuses an anonymous upgrade when the route requires auth", async () => {
        expect.assertions(2);

        const shard = makeShard([], { "/chat": { auth: true, functionPath: "sockets:chat" } });
        const response = await shard.fetch(new Request("https://shard.internal/chat", { headers: { Upgrade: "websocket" } }));

        expect(response.status).toBe(401);
        expect(socketCalls(shard)).toHaveLength(0);
    });

    it("accepts a verified upgrade, stamps the route, and fires onOpen", async () => {
        expect.assertions(4);

        const sockets: FakeSocket[] = [];
        const server = new FakeSocket();
        const globalWithPair = globalThis as { WebSocketPair?: unknown };
        const original = globalWithPair.WebSocketPair;

        globalWithPair.WebSocketPair = function WebSocketPair() {
            return { 0: {}, 1: server } as unknown;
        };

        const shard = makeShard(sockets, CHAT_ROUTE);

        try {
            // `new Response(null, { status: 101 })` is out of Node's allowed
            // range and throws — after the attachment is stamped and `onOpen`
            // dispatched, which is all these assertions read.
            await shard.fetch(new Request("https://shard.internal/chat", { headers: { Upgrade: "websocket", "x-lunora-userid": "user-1" } }));
        } catch (error) {
            if (!(error instanceof RangeError)) {
                throw error;
            }
        } finally {
            globalWithPair.WebSocketPair = original;
        }

        // The route path is persisted so a hibernated socket still resolves its
        // handler, and it joined the reserved broadcast topic.
        expect(server.deserializeAttachment()).toMatchObject({ socketFunction: "sockets:chat", socketPath: "/chat", whispers: [CHAT_TOPIC] });

        const open = socketCalls(shard).find((call) => call.args["kind"] === "open");

        expect(open).toBeDefined();
        expect((open?.args["socket"] as { userId: string }).userId).toBe("user-1");
        // `socket.send` reached the one socket that opened.
        expect(server.frames).toEqual([{ data: { opened: true }, topic: CHAT_TOPIC, type: "message" }]);
    });

    it("hands a route's onOpen to the host's waitUntil, so an eviction cannot cut it off", async () => {
        expect.assertions(2);

        const sockets: FakeSocket[] = [];
        const server = new FakeSocket();
        const deferred: Promise<unknown>[] = [];
        const globalWithPair = globalThis as { WebSocketPair?: unknown };
        const original = globalWithPair.WebSocketPair;

        globalWithPair.WebSocketPair = function WebSocketPair() {
            return { 0: {}, 1: server } as unknown;
        };

        const state = {
            acceptWebSocket(ws: FakeSocket) {
                sockets.push(ws);
            },
            getWebSockets: () => sockets,
            storage: { sql: {} },
            waitUntil: (promise: Promise<unknown>) => {
                deferred.push(promise);
            },
        } as unknown as ShardDOState;
        const shard = new SocketShard(state, CHAT_ROUTE);

        try {
            await shard.fetch(new Request("https://shard.internal/chat", { headers: { Upgrade: "websocket", "x-lunora-userid": "user-1" } }));
        } catch (error) {
            // Node refuses to build a 101 response; the dispatch already ran by then.
            if (!(error instanceof RangeError)) {
                throw error;
            }
        } finally {
            globalWithPair.WebSocketPair = original;
        }

        await Promise.all(deferred);

        expect(deferred.length).toBeGreaterThan(0);
        expect(socketCalls(shard).some((call) => call.args["kind"] === "open")).toBe(true);
    });

    it("validates a typed message and broadcasts the handler's reply to every route socket", async () => {
        expect.assertions(3);

        const a = new FakeSocket({ connectionId: "a", socketFunction: "sockets:chat", socketPath: "/chat", subs: {}, whispers: [CHAT_TOPIC] });
        const b = new FakeSocket({ connectionId: "b", socketFunction: "sockets:chat", socketPath: "/chat", subs: {}, whispers: [CHAT_TOPIC] });
        const shard = makeShard([a, b], CHAT_ROUTE);

        await send(shard, a, JSON.stringify(encodeWire({ text: "hi" })));

        const messageCall = socketCalls(shard).find((call) => call.args["kind"] === "message");

        // The client's wire-encoded frame was decoded before dispatch.
        expect(messageCall?.args["message"]).toEqual({ text: "hi" });

        // The handler's broadcast reached both members and, critically, did NOT
        // leak the raw client frame.
        expect(a.frames).toEqual([{ data: { echo: { text: "hi" } }, topic: CHAT_TOPIC, type: "message" }]);
        expect(b.frames).toEqual([{ data: { echo: { text: "hi" } }, topic: CHAT_TOPIC, type: "message" }]);
    });

    it("sends a route payload as it was at the call, not as the handler later left it", async () => {
        expect.assertions(1);

        class MutatingShard extends SocketShard {
            public override handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
                this.calls.push({ args, functionPath });

                if (args["kind"] === "message") {
                    const payload = { count: 1 };

                    (args["socket"] as { send: (message: unknown) => void }).send(payload);
                    payload.count = 2;
                }

                return Promise.resolve(undefined);
            }
        }

        const a = new FakeSocket({ connectionId: "a", socketFunction: "sockets:chat", socketPath: "/chat", subs: {}, whispers: [CHAT_TOPIC] });
        const state = { acceptWebSocket: () => undefined, getWebSockets: () => [a], storage: { sql: {} } } as unknown as ShardDOState;
        const shard = new MutatingShard(state, CHAT_ROUTE);

        await send(shard, a, JSON.stringify(encodeWire({ text: "hi" })));

        expect(a.frames).toEqual([{ data: { count: 1 }, topic: CHAT_TOPIC, type: "message" }]);
    });

    it("refuses a route payload the wire encoder cannot carry instead of flattening it", async () => {
        expect.assertions(2);

        class Point {
            public constructor(public readonly x: number) {}
        }

        class ClassSendingShard extends SocketShard {
            public override handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
                this.calls.push({ args, functionPath });

                if (args["kind"] === "message") {
                    (args["socket"] as { send: (message: unknown) => void }).send(new Point(1));
                }

                return Promise.resolve(undefined);
            }
        }

        const a = new FakeSocket({ connectionId: "a", socketFunction: "sockets:chat", socketPath: "/chat", subs: {}, whispers: [CHAT_TOPIC] });
        const state = { acceptWebSocket: () => undefined, getWebSockets: () => [a], storage: { sql: {} } } as unknown as ShardDOState;
        const shard = new ClassSendingShard(state, CHAT_ROUTE);

        await send(shard, a, JSON.stringify(encodeWire({ text: "hi" })));

        const entries = (shard as unknown as { logs: { entries: () => { functionPath?: string; message: string }[] } }).logs.entries();

        expect(a.frames).toEqual([]);
        expect(entries.some((entry) => entry.functionPath === "sockets:chat" && /encode/iu.test(entry.message))).toBe(true);
    });

    it("keeps a v.sensitive message out of the log when the handler rejects it", async () => {
        expect.assertions(2);

        const secret = "hunter2-the-real-secret";

        class VaultShard extends SocketShard {
            // eslint-disable-next-line class-methods-use-this -- test double: the handler always rejects with the secret
            public override handleRpc(): Promise<unknown> {
                return Promise.reject(new Error(`rejected ${secret}`));
            }

            // eslint-disable-next-line class-methods-use-this -- test double: the marked name is fixed
            protected override sensitiveArgNames(): ReadonlySet<string> {
                return new Set(["message"]);
            }
        }

        const a = new FakeSocket({ connectionId: "a", socketFunction: "sockets:chat", socketPath: "/chat", subs: {}, whispers: [CHAT_TOPIC] });
        const state = { acceptWebSocket: () => undefined, getWebSockets: () => [a], storage: { sql: {} } } as unknown as ShardDOState;
        const shard = new VaultShard(state, CHAT_ROUTE);

        await send(shard, a, JSON.stringify(encodeWire({ text: secret })));

        const entries = (shard as unknown as { logs: { entries: () => { functionPath?: string; message: string }[] } }).logs.entries();

        expect(entries.some((entry) => entry.functionPath === "sockets:chat" && entry.message.startsWith("rejected"))).toBe(true);
        expect(JSON.stringify(entries)).not.toContain(secret);
    });

    it("refuses a frame from an anonymous socket once its route requires auth", async () => {
        expect.assertions(3);

        // The socket opened on a public route, then the deployment made the route require a session.
        const anonymous = new FakeSocket({ connectionId: "a", socketFunction: "sockets:chat", socketPath: "/chat", subs: {}, whispers: [CHAT_TOPIC] });
        const verified = new FakeSocket({
            connectionId: "b",
            socketFunction: "sockets:chat",
            socketPath: "/chat",
            subs: {},
            userId: "user-1",
            whispers: [CHAT_TOPIC],
        });
        const shard = makeShard([anonymous, verified], { "/chat": { auth: true, functionPath: "sockets:chat" } });

        await send(shard, anonymous, JSON.stringify(encodeWire({ text: "hi" })));

        expect(socketCalls(shard)).toHaveLength(0);
        expect(anonymous.frames).toEqual([]);

        // The same route still dispatches a frame from a verified socket.
        await send(shard, verified, JSON.stringify(encodeWire({ text: "hi" })));

        expect(socketCalls(shard).map((call) => call.args["kind"])).toEqual(["message"]);
    });

    it("asks the relays about a live control call once when no relay answers", async () => {
        expect.assertions(2);

        // The owner has relays but none holds the connection: the call is forwarded once, and the caller gets the
        // ordinary not-found answer rather than a second round trip.
        const shard = makeShard([], CHAT_ROUTE);
        const relay = Object.create(OwnerRelay.prototype) as OwnerRelay;
        let forwards = 0;

        relay.forwardLiveControl = (): Promise<Response | undefined> => {
            forwards += 1;

            return Promise.resolve(undefined);
        };
        (shard as unknown as { relay: unknown }).relay = relay;

        const control = { action: "subscribe", callerId: "u1", connectionId: "c-ghost", key: "k", subscriptionId: "s1" };
        const response = await (shard as unknown as { handleLiveSocketControl: (call: unknown) => Promise<Response> }).handleLiveSocketControl(control);

        expect(forwards).toBe(1);
        expect(response.status).toBe(404);
    });

    it("binds a route socket to the function that accepted it, not to its path", async () => {
        expect.assertions(3);

        // The socket was accepted by `sockets:old` on `/chat`; a deployment then points `/chat` at `sockets:new`.
        const open = new FakeSocket({
            connectionId: "a",
            socketFunction: "sockets:old",
            socketPath: "/chat",
            subs: {},
            whispers: [CHAT_TOPIC],
        });
        const shard = makeShard([open], { "/chat": { auth: false, functionPath: "sockets:new" } });

        await send(shard, open, JSON.stringify(encodeWire({ text: "hi" })));
        await shard.webSocketClose(open as unknown as WebSocket, 1000, "", true);

        // Neither the frame nor the close reaches the replacement handler.
        expect(shard.calls).toEqual([]);
        expect(open.frames).toEqual([]);
        expect(open.closes).toEqual([]);
    });

    it("runs a route's onClose once when its expired socket is dropped, not again on the host's close", async () => {
        expect.assertions(3);

        const expired = new FakeSocket({
            connectionId: "a",
            expiresAt: Date.now() - 1000,
            socketFunction: "sockets:chat",
            socketPath: "/chat",
            subs: {},
            userId: "user-1",
            whispers: [CHAT_TOPIC],
        });
        const shard = makeShard([expired], CHAT_ROUTE);

        // The server closes an expired socket itself, and that close is not delivered back, so the drop runs `onClose`.
        await send(shard, expired, JSON.stringify(encodeWire({ text: "late" })));

        expect(socketCalls(shard).map((call) => call.args["kind"])).toEqual(["close"]);
        expect(expired.closes.map((close) => close.code)).toEqual([4001]);

        // A host that does deliver the close does not dispatch it a second time.
        await shard.webSocketClose(expired as unknown as WebSocket, 1000, "", true);

        expect(socketCalls(shard).map((call) => call.args["kind"])).toEqual(["close"]);
    });

    it("refuses a route broadcast over the byte cap even when its UTF-16 length is under it", async () => {
        expect.assertions(2);

        // 1400 euro signs are 1400 UTF-16 code units (under the 4096 cap) but 4200 UTF-8 bytes (over it).
        class OversizeShard extends SocketShard {
            public override handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
                if (args["kind"] === "message") {
                    (args["socket"] as { broadcast: (message: unknown) => void }).broadcast({ text: "€".repeat(1400) });

                    return Promise.resolve(undefined);
                }

                return super.handleRpc(functionPath, args);
            }
        }

        const a = new FakeSocket({ connectionId: "a", socketFunction: "sockets:chat", socketPath: "/chat", subs: {}, whispers: [CHAT_TOPIC] });
        const b = new FakeSocket({ connectionId: "b", socketFunction: "sockets:chat", socketPath: "/chat", subs: {}, whispers: [CHAT_TOPIC] });
        const sockets = [a, b];
        const state = {
            acceptWebSocket() {},
            getWebSockets: () => sockets,
            storage: { sql: {} },
        } as unknown as ShardDOState;
        const shard = new OversizeShard(state, CHAT_ROUTE);

        await send(shard, a, JSON.stringify(encodeWire({ text: "x" })));

        // The oversize frame is dropped for every member, not just the sender.
        expect(a.frames).toEqual([]);
        expect(b.frames).toEqual([]);
    });

    it("discards a route broadcast when the handler's mutation fails, so no socket sees rolled-back writes", async () => {
        expect.assertions(2);

        // A handler that broadcasts and then throws: the frame must never leave.
        class FailingShard extends SocketShard {
            public override handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
                if (args["kind"] === "message") {
                    (args["socket"] as { broadcast: (message: unknown) => void }).broadcast({ committed: false });

                    return Promise.reject(new Error("write failed"));
                }

                return super.handleRpc(functionPath, args);
            }
        }

        const a = new FakeSocket({ connectionId: "a", socketFunction: "sockets:chat", socketPath: "/chat", subs: {}, whispers: [CHAT_TOPIC] });
        const b = new FakeSocket({ connectionId: "b", socketFunction: "sockets:chat", socketPath: "/chat", subs: {}, whispers: [CHAT_TOPIC] });
        const sockets = [a, b];
        const state = {
            acceptWebSocket() {},
            getWebSockets: () => sockets,
            storage: { sql: {} },
        } as unknown as ShardDOState;
        const shard = new FailingShard(state, CHAT_ROUTE);

        await send(shard, a, JSON.stringify(encodeWire({ text: "x" })));

        expect(a.frames).toEqual([]);
        expect(b.frames).toEqual([]);
    });

    it("still sends a route's queued frames when the handler fails after its writes committed", async () => {
        expect.assertions(2);

        // The writes are durable, so the broadcast announcing them must still reach every route socket.
        class CommittedFailureShard extends SocketShard {
            public override handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
                if (args["kind"] === "message") {
                    (args["socket"] as { broadcast: (message: unknown) => void }).broadcast({ committed: true });

                    return Promise.reject(Object.assign(new Error("deferred step failed"), { committed: true }));
                }

                return super.handleRpc(functionPath, args);
            }
        }

        const a = new FakeSocket({ connectionId: "a", socketFunction: "sockets:chat", socketPath: "/chat", subs: {}, whispers: [CHAT_TOPIC] });
        const b = new FakeSocket({ connectionId: "b", socketFunction: "sockets:chat", socketPath: "/chat", subs: {}, whispers: [CHAT_TOPIC] });
        const sockets = [a, b];
        const state = {
            acceptWebSocket() {},
            getWebSockets: () => sockets,
            storage: { sql: {} },
        } as unknown as ShardDOState;
        const shard = new CommittedFailureShard(state, CHAT_ROUTE);

        await send(shard, a, JSON.stringify(encodeWire({ text: "x" })));

        expect(a.frames).toHaveLength(1);
        expect(b.frames).toHaveLength(1);
    });

    it("throttles a route's frames from one socket past its admission burst", async () => {
        expect.assertions(1);

        const burst = (ShardDO as unknown as { WHISPER_RATE_BURST: number }).WHISPER_RATE_BURST;
        const a = new FakeSocket({ connectionId: "a", socketFunction: "sockets:chat", socketPath: "/chat", subs: {}, whispers: [CHAT_TOPIC] });
        const shard = makeShard([a], CHAT_ROUTE);

        for (let index = 0; index < burst + 20; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- frames arrive in order on one socket
            await send(shard, a, JSON.stringify(encodeWire({ text: String(index) })));
        }

        // Admission refills only with elapsed time, so the flood cannot run the handler once per frame.
        expect(socketCalls(shard).length).toBeLessThan(burst + 20);
    });

    it("fires onClose for a route socket on close", async () => {
        expect.assertions(1);

        const a = new FakeSocket({ connectionId: "a", socketFunction: "sockets:chat", socketPath: "/chat", subs: {}, whispers: [CHAT_TOPIC] });
        const shard = makeShard([a], CHAT_ROUTE);

        await shard.webSocketClose(a as unknown as WebSocket, 1000, "done", true);

        expect(socketCalls(shard).map((call) => call.args["kind"])).toEqual(["close"]);
    });

    it("refuses a socket's frames past the queue cap instead of queueing them without bound", async () => {
        expect.assertions(1);

        // A message handler that never settles, so every later frame stays queued behind it. The admission
        // throttle would drop most of these before the queue, so the dispatch is called directly to reach the cap.
        class StuckShard extends SocketShard {
            public override handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
                if (args["kind"] === "message") {
                    return new Promise<unknown>(() => {
                        // Never settles.
                    });
                }

                return super.handleRpc(functionPath, args);
            }
        }

        const sockets: FakeSocket[] = [];
        const state = {
            acceptWebSocket(ws: FakeSocket) {
                sockets.push(ws);
            },
            getWebSockets: () => sockets,
            storage: { sql: {} },
        } as unknown as ShardDOState;
        const shard = new StuckShard(state, CHAT_ROUTE);
        const socket = new FakeSocket({ connectionId: "c1", subs: {}, userId: "u1" });
        const route = { functionPath: "sockets:chat", path: "/chat" };
        const cap = (SocketShard as unknown as { MAX_QUEUED_SOCKET_EVENTS: number }).MAX_QUEUED_SOCKET_EVENTS;

        for (let index = 0; index < cap + 6; index += 1) {
            shard["dispatchSocketEvent"](socket as never, route, "message", { text: String(index) }).catch(() => undefined);
        }

        expect(shard["logs"].entries().filter((entry) => entry.message.includes("socket frame refused"))).toHaveLength(6);
    });

    it("runs one socket's frames and its close strictly in arrival order", async () => {
        expect.assertions(3);

        // A message handler that stays open until the test releases it, so a later frame or the
        // close would overtake it if the socket's events were not queued.
        class SlowShard extends SocketShard {
            public readonly release: (() => void)[] = [];

            public readonly started: string[] = [];

            public override handleRpc(_functionPath: string, args: Record<string, unknown>): Promise<unknown> {
                if (args["kind"] !== "message") {
                    this.started.push(String(args["kind"]));

                    return Promise.resolve(undefined);
                }

                this.started.push(`message:${(args["message"] as { text: string }).text}`);

                return new Promise<unknown>((resolve) => {
                    this.release.push(() => {
                        resolve(undefined);
                    });
                });
            }
        }

        const settle = async (): Promise<void> => {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
            });
        };

        const a = new FakeSocket({ connectionId: "a", socketFunction: "sockets:chat", socketPath: "/chat", subs: {}, whispers: [CHAT_TOPIC] });
        const shard = new SlowShard(
            {
                acceptWebSocket() {},
                getWebSockets: () => [a],
                storage: { sql: {} },
            } as unknown as ShardDOState,
            CHAT_ROUTE,
        );

        const first = send(shard, a, JSON.stringify(encodeWire({ text: "1" })));
        const second = send(shard, a, JSON.stringify(encodeWire({ text: "2" })));
        const closed = shard.webSocketClose(a as unknown as WebSocket, 1000, "done", true);

        await settle();

        // Only the first frame's handler is running; the second frame and the close wait behind it.
        expect(shard.started).toEqual(["message:1"]);

        shard.release.shift()?.();
        await settle();

        expect(shard.started).toEqual(["message:1", "message:2"]);

        shard.release.shift()?.();
        await Promise.all([first, second, closed]);

        expect(shard.started).toEqual(["message:1", "message:2", "close"]);
    });

    it("refuses a route frame that arrives after the socket's close began, so the handler never sees a cleared identity", async () => {
        expect.assertions(2);

        const a = new FakeSocket({
            connectionId: "a",
            socketFunction: "sockets:chat",
            socketPath: "/chat",
            subs: {},
            userId: "user-a",
            whispers: [CHAT_TOPIC],
        });
        const shard = makeShard([a], CHAT_ROUTE);

        // The close is marked before its first await; the frame's own admission await then resolves after that mark.
        const closed = shard.webSocketClose(a as unknown as WebSocket, 1000, "done", true);

        await send(shard, a, JSON.stringify(encodeWire({ text: "late" })));
        await closed;

        // The close still runs; the late frame does not.
        expect(socketCalls(shard).map((call) => call.args["kind"])).toEqual(["close"]);
        expect(a.frames).toEqual([]);
    });

    it("refuses a route upgrade under delivery authorization and runs no route mutation", async () => {
        expect.assertions(2);

        const shard = new SocketShard({ acceptWebSocket() {}, getWebSockets: () => [], storage: { sql: {} } }, CHAT_ROUTE, {
            deliveryAuthorization: () => Promise.resolve(undefined),
        });
        const response = await shard.fetch(new Request("https://shard.internal/chat", { headers: { Upgrade: "websocket", "x-lunora-userid": "user-1" } }));

        expect(response.status).toBe(501);
        expect(socketCalls(shard)).toHaveLength(0);
    });

    it("treats a mixed-case Upgrade header as a websocket upgrade under delivery authorization", async () => {
        expect.assertions(1);

        const globalWithPair = globalThis as { WebSocketPair?: unknown };
        const original = globalWithPair.WebSocketPair;

        globalWithPair.WebSocketPair = function WebSocketPair() {
            return { 0: {}, 1: new FakeSocket() } as unknown;
        };

        const shard = new SocketShard({ acceptWebSocket() {}, getWebSockets: () => [], storage: { sql: {} } }, CHAT_ROUTE, {
            deliveryAuthorization: () => Promise.resolve(undefined),
        });
        let status: number;

        try {
            const response = await shard.fetch(
                new Request("https://shard.internal/_lunora/ws", { headers: { Upgrade: "WebSocket", "x-lunora-userid": "user-1" } }),
            );

            status = response.status;
        } catch (error) {
            // Node refuses to build a 101 response, so reaching the upgrade branch surfaces as this RangeError.
            if (!(error instanceof RangeError)) {
                throw error;
            }

            status = 101;
        } finally {
            globalWithPair.WebSocketPair = original;
        }

        expect(status).not.toBe(501);
    });

    it("records a route frame that is not valid JSON instead of dropping it silently", async () => {
        expect.assertions(2);

        const a = new FakeSocket({ connectionId: "a", socketFunction: "sockets:chat", socketPath: "/chat", subs: {}, whispers: [CHAT_TOPIC] });
        const shard = makeShard([a], CHAT_ROUTE);

        await send(shard, a, "{not json");

        const entries = (shard as unknown as { logs: { entries: () => { functionPath?: string; message: string }[] } }).logs.entries();

        expect(socketCalls(shard)).toHaveLength(0);
        expect(entries.some((entry) => entry.functionPath === "sockets:chat" && entry.message.includes("invalid JSON"))).toBe(true);
    });

    it("drops a route frame under delivery authorization instead of running its mutation", async () => {
        expect.assertions(2);

        // A route socket that predates the mode: its frame must not run the route's handler or broadcast.
        const a = new FakeSocket({
            connectionId: "a",
            socketFunction: "sockets:chat",
            socketPath: "/chat",
            subs: {},
            userId: "user-a",
            whispers: [CHAT_TOPIC],
        });
        const sockets = [a];
        const shard = new SocketShard({ acceptWebSocket() {}, getWebSockets: () => sockets, storage: { sql: {} } } as unknown as ShardDOState, CHAT_ROUTE, {
            deliveryAuthorization: () => Promise.resolve(undefined),
        });

        await send(shard, a, JSON.stringify(encodeWire({ text: "x" })));

        expect(socketCalls(shard)).toHaveLength(0);
        expect(a.frames).toEqual([]);
    });

    it("ignores a whisper frame addressed to a route's reserved topic", async () => {
        expect.assertions(2);

        const member = new FakeSocket({ connectionId: "a", socketFunction: "sockets:chat", socketPath: "/chat", subs: {}, whispers: [CHAT_TOPIC] });
        // A foreign subscription socket — not a route socket — trying to inject
        // into the route channel over the shared whisper surface.
        const foreign = new FakeSocket({ connectionId: "f", subs: {}, userId: "outsider" });
        const shard = makeShard([member, foreign], CHAT_ROUTE);

        await send(shard, foreign, JSON.stringify({ data: { text: "injected" }, topic: CHAT_TOPIC, type: "whisper" }));

        // No dispatch, and the route member received nothing: route channels are
        // not reachable through a whisper frame.
        expect(socketCalls(shard)).toHaveLength(0);
        expect(member.frames).toEqual([]);
    });
});
