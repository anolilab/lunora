import type { SocketAttachment, SubscriptionEnvelope } from "@lunora/shard-engine";
import { beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

interface FakeWebSocket {
    attachment: SocketAttachment | undefined;
    close: (code?: number, reason?: string) => void;
    closes: { code?: number; reason?: string }[];
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

const SESSION_BEARER = "session-bearer-value";

const createFakeWebSocket = (): FakeWebSocket => {
    return {
        attachment: undefined,
        close(code?: number, reason?: string) {
            this.closes.push({ code, reason });
        },
        closes: [],
        // Storage hands out copies, as hibernation does: a read is not a live handle on what was saved.
        deserializeAttachment() {
            return this.attachment === undefined ? undefined : structuredClone(this.attachment);
        },
        send(data: string) {
            this.sent.push(data);
        },
        sent: [],
        serializeAttachment(value: unknown) {
            this.attachment = value === undefined ? undefined : (structuredClone(value) as SocketAttachment);
        },
    };
};

class GateShard extends ShardDO {
    public readonly dispatched: string[] = [];

    public override async handleRpc(functionPath: string): Promise<unknown> {
        this.dispatched.push(functionPath);

        return undefined;
    }

    public registerSocket(ws: FakeWebSocket, attachment: SocketAttachment): void {
        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment(attachment);
    }

    public driveFrame(ws: FakeWebSocket, frame: Partial<SubscriptionEnvelope> & { type: string }): Promise<void> {
        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(frame));
    }

    public driveClose(ws: FakeWebSocket): Promise<void> {
        return this.webSocketClose(ws as unknown as WebSocket, 1000, "", true);
    }

    public admitPending(now: number): boolean {
        return this.admitPendingSocket(now, false);
    }

    // eslint-disable-next-line class-methods-use-this -- override stub: the manifest is a fixed list
    protected override lifecycleHookPaths(event: "connect" | "disconnect"): ReadonlyArray<string> {
        return event === "disconnect" ? ["hooks:onLeave"] : [];
    }
}

/** A socket the upgrade accepted without a credential: `authenticated: false` is what it carries. */
const unauthenticated = (): SocketAttachment => {
    return { authenticated: false, connectionId: "conn-1", subs: {} };
};

describe("shardDO: session credential rides the connect frame, not the URL", () => {
    let sockets: FakeWebSocket[];
    let state: ShardDOState;

    beforeEach(() => {
        sockets = [];
        state = {
            acceptWebSocket(ws) {
                sockets.push(ws as unknown as FakeWebSocket);
            },
            getWebSockets() {
                return sockets as unknown as WebSocket[];
            },
            id: { name: "shard-a" },
            storage: { sql: {} },
        };
    });

    const bearerEnv = { LUNORA_WS_BEARER: SESSION_BEARER };

    it("refuses an unauthenticated socket's first frame when it is not connect, before anything dispatches", async () => {
        expect.assertions(4);

        const shard = new GateShard(state, bearerEnv);
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, unauthenticated());
        await shard.driveFrame(ws, { id: "s", query: { args: {}, functionPath: "messages:list" }, type: "subscribe" });

        expect(ws.sent.map((data) => JSON.parse(data) as { error?: { code?: string } }).find((frame) => frame.error)?.error?.code).toBe("UNAUTHENTICATED");
        expect(ws.closes).toStrictEqual([{ code: 4003, reason: "unauthenticated" }]);
        expect(shard.dispatched).toStrictEqual([]);
        expect(ws.sent.some((data) => data.includes('"type":"identity"'))).toBe(false);
    });

    it("refuses a connect whose token does not match, and sends no identity", async () => {
        expect.assertions(3);

        const shard = new GateShard(state, bearerEnv);
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, unauthenticated());
        await shard.driveFrame(ws, { id: "connect", token: "wrong", type: "connect" });

        expect(ws.closes).toStrictEqual([{ code: 4003, reason: "unauthenticated" }]);
        expect(ws.sent.some((data) => data.includes('"type":"identity"'))).toBe(false);
        expect(ws.attachment?.connected).toBeUndefined();
    });

    it("refuses a connect that carries no token at all", async () => {
        expect.assertions(1);

        const shard = new GateShard(state, bearerEnv);
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, unauthenticated());
        await shard.driveFrame(ws, { id: "connect", type: "connect" });

        expect(ws.closes).toStrictEqual([{ code: 4003, reason: "unauthenticated" }]);
    });

    it("admits a socket on a connect carrying the matching token, then answers identity and keeps it open", async () => {
        expect.assertions(4);

        const shard = new GateShard(state, bearerEnv);
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, unauthenticated());
        await shard.driveFrame(ws, { id: "connect", token: SESSION_BEARER, type: "connect" });

        expect(ws.closes).toStrictEqual([]);
        expect(ws.sent.some((data) => data.includes('"type":"identity"'))).toBe(true);
        expect(ws.attachment?.authenticated).toBe(true);
        expect(ws.attachment?.connected).toBe(true);
    });

    it("persists the authenticated flag before the relay announce, so a subscribe during that await is not refused", async () => {
        expect.assertions(1);

        const shard = new GateShard(state, bearerEnv);
        const ws = createFakeWebSocket();
        const flagAtAnnounce: (boolean | undefined)[] = [];

        // A relay's announce awaits the owner, and a subscribe can arrive meanwhile: what storage holds
        // at that instant is what that subscribe will read.
        Reflect.set(shard, "relay", {
            announce: async () => {
                flagAtAnnounce.push(ws.attachment?.authenticated);
            },
        });

        shard.registerSocket(ws, unauthenticated());
        await shard.driveFrame(ws, { id: "connect", token: SESSION_BEARER, type: "connect" });

        expect(flagAtAnnounce).toStrictEqual([true]);
    });

    it("does not run onDisconnect for a socket refused at the gate, since it never ran onConnect", async () => {
        expect.assertions(1);

        const shard = new GateShard(state, bearerEnv);
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, unauthenticated());
        await shard.driveFrame(ws, { id: "connect", token: "wrong", type: "connect" });
        await shard.driveClose(ws);

        expect(shard.dispatched).toStrictEqual([]);
    });

    it("runs onDisconnect for an admitted socket, so the refused-socket case above proves the skip and not a dead hook", async () => {
        expect.assertions(1);

        const shard = new GateShard(state, bearerEnv);
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, unauthenticated());
        await shard.driveFrame(ws, { id: "connect", token: SESSION_BEARER, type: "connect" });
        await shard.driveClose(ws);

        expect(shard.dispatched).toStrictEqual(["hooks:onLeave"]);
    });

    it("does not gate a socket when no bearer is configured, and ignores a token it was sent", async () => {
        expect.assertions(2);

        const shard = new GateShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { connectionId: "conn-1", subs: {} });
        await shard.driveFrame(ws, { id: "connect", token: "anything", type: "connect" });

        expect(ws.closes).toStrictEqual([]);
        expect(ws.sent.some((data) => data.includes('"type":"identity"'))).toBe(true);
    });

    describe("pending sockets are capped and deadlined", () => {
        const PENDING_CAP = 1024;
        const DEADLINE_MS = 10_000;

        it("refuses a new pending upgrade once the cap is full of live pending sockets", () => {
            expect.assertions(2);

            const shard = new GateShard(state, bearerEnv);
            const now = 1_000_000;

            for (let index = 0; index < PENDING_CAP; index += 1) {
                shard.registerSocket(createFakeWebSocket(), { ...unauthenticated(), pendingSince: now });
            }

            expect(shard.admitPending(now)).toBe(false);
            expect(sockets.every((ws) => ws.closes.length === 0)).toBe(true);
        });

        it("closes a pending socket past its connect deadline and frees its slot", () => {
            expect.assertions(3);

            const shard = new GateShard(state, bearerEnv);
            const now = 1_000_000;
            const stale = createFakeWebSocket();

            for (let index = 0; index < PENDING_CAP - 1; index += 1) {
                shard.registerSocket(createFakeWebSocket(), { ...unauthenticated(), pendingSince: now });
            }

            shard.registerSocket(stale, { ...unauthenticated(), pendingSince: now - DEADLINE_MS - 1 });

            expect(shard.admitPending(now)).toBe(true);
            expect(stale.closes).toStrictEqual([{ code: 4003, reason: "connect deadline" }]);
            expect(sockets.filter((ws) => ws.closes.length > 0)).toHaveLength(1);
        });

        it("does not count an authenticated socket against the cap", () => {
            expect.assertions(1);

            const shard = new GateShard(state, bearerEnv);
            const now = 1_000_000;

            for (let index = 0; index < PENDING_CAP; index += 1) {
                shard.registerSocket(createFakeWebSocket(), { connectionId: `conn-${String(index)}`, subs: {} });
            }

            expect(shard.admitPending(now)).toBe(true);
        });

        it("drops the deadline once connect proves the credential", async () => {
            expect.assertions(2);

            const shard = new GateShard(state, bearerEnv);
            const ws = createFakeWebSocket();

            shard.registerSocket(ws, { ...unauthenticated(), pendingSince: 1 });
            await shard.driveFrame(ws, { id: "connect", token: SESSION_BEARER, type: "connect" });

            expect(ws.attachment?.authenticated).toBe(true);
            expect(ws.attachment).not.toHaveProperty("pendingSince");
        });
    });
});
