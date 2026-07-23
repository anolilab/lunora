import type { SocketAttachment, SubscriptionEnvelope } from "@lunora/shard-engine";
import { beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

/**
 * Minimal WebSocket double mirroring the `serializeAttachment` /
 * `deserializeAttachment` instance methods workerd exposes — enough to carry a
 * {@link SocketAttachment} across the connect/close lifecycle calls.
 */
interface FakeWebSocket {
    attachment: SocketAttachment | undefined;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

const createFakeWebSocket = (): FakeWebSocket => {
    return {
        attachment: undefined,
        deserializeAttachment() {
            return this.attachment;
        },
        send(data: string) {
            this.sent.push(data);
        },
        sent: [],
        serializeAttachment(value: unknown) {
            this.attachment = value as SocketAttachment | undefined;
        },
    };
};

/** One captured `handleRpc` invocation — the dispatch surface for a lifecycle hook. */
interface Dispatch {
    args: Record<string, unknown>;
    functionPath: string;
    /** The trusted-system flag in effect — lifecycle hooks must run as system. */
    system: boolean;
    /** The verified user id the hook ran under (`undefined` ≙ anonymous). */
    userId: string | undefined;
}

/**
 * A ShardDO that records every dispatched hook instead of building a real ctx,
 * and lets a test set the connect/disconnect manifests the base reads.
 */
class LifecycleShard extends ShardDO {
    public connectPaths: string[] = [];

    public disconnectPaths: string[] = [];

    public readonly dispatched: Dispatch[] = [];

    public override async handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        this.dispatched.push({
            args,
            functionPath,
            system: this.isSystemDispatch(),
            userId: this.getCurrentUserId(),
        });

        return undefined;
    }

    public driveClose(ws: FakeWebSocket): Promise<void> {
        return this.webSocketClose(ws as unknown as WebSocket, 1000, "", true);
    }

    public driveMessage(ws: FakeWebSocket, envelope: SubscriptionEnvelope): Promise<void> {
        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
    }

    public registerSocket(ws: FakeWebSocket, attachment: SocketAttachment): void {
        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment(attachment);
    }

    /** Expose the protected trusted-system flag so a test can assert it's restored. */
    public systemFlag(): boolean {
        return this.isSystemDispatch();
    }

    protected override lifecycleHookPaths(event: "connect" | "disconnect"): ReadonlyArray<string> {
        return event === "connect" ? this.connectPaths : this.disconnectPaths;
    }
}

describe("shardDO connection-lifecycle dispatch", () => {
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

    const attachment = (overrides: Partial<SocketAttachment> = {}): SocketAttachment => {
        return {
            admin: false,
            connectionId: "conn-1",
            identity: { roles: ["member"] },
            subs: {},
            userId: "user-1",
            ...overrides,
        };
    };

    const connectEnvelope = (context?: Record<string, unknown>): SubscriptionEnvelope => {
        return { id: "connect", type: "connect", ...(context === undefined ? {} : { context }) };
    };

    it("fires every registered onConnect hook with the lifecycle event", async () => {
        expect.assertions(4);

        const shard = new LifecycleShard(state, {});
        shard.connectPaths = ["hooks:onJoin", "audit:connected"];

        const ws = createFakeWebSocket();
        shard.registerSocket(ws, attachment());

        await shard.driveMessage(ws, connectEnvelope({ roomId: "room-1", sessionId: "sess-1" }));

        expect(shard.dispatched.map((d) => d.functionPath)).toEqual(["hooks:onJoin", "audit:connected"]);
        expect(shard.dispatched[0]?.args).toEqual({
            connectionId: "conn-1",
            context: { roomId: "room-1", sessionId: "sess-1" },
            shardKey: "shard-a",
            userId: "user-1",
        });
        // Both hooks saw the same event.
        expect(shard.dispatched[1]?.args).toMatchObject({ connectionId: "conn-1", shardKey: "shard-a" });
        expect(shard.dispatched).toHaveLength(2);
    });

    it("fires onConnect exactly once even when the client re-sends the connect frame", async () => {
        expect.assertions(2);

        const shard = new LifecycleShard(state, {});
        shard.connectPaths = ["hooks:onJoin"];

        const ws = createFakeWebSocket();
        shard.registerSocket(ws, attachment());

        // A duplicate / re-sent connect frame on an already-announced socket must
        // not re-fire the hooks — otherwise onConnect out-numbers the single
        // onDisconnect dispatched at close.
        await shard.driveMessage(ws, connectEnvelope({ roomId: "room-1" }));
        await shard.driveMessage(ws, connectEnvelope({ roomId: "room-1" }));

        expect(shard.dispatched).toHaveLength(1);
        expect(shard.dispatched[0]?.functionPath).toBe("hooks:onJoin");
    });

    it("runs onConnect hooks under the socket's verified identity via system dispatch", async () => {
        expect.assertions(3);

        const shard = new LifecycleShard(state, {});
        shard.connectPaths = ["hooks:onJoin"];

        const ws = createFakeWebSocket();
        shard.registerSocket(ws, attachment({ userId: "user-42" }));

        await shard.driveMessage(ws, connectEnvelope());

        // Identity replayed, and the internal hook is permitted only because the
        // base toggles the trusted-system flag — never client-asserted.
        expect(shard.dispatched[0]?.userId).toBe("user-42");
        expect(shard.dispatched[0]?.system).toBe(true);
        // The flag is restored after dispatch, never leaked to later requests.
        expect(shard.systemFlag()).toBe(false);
    });

    it("replays the connect context + identity to onDisconnect when the socket closes", async () => {
        expect.assertions(3);

        const shard = new LifecycleShard(state, {});
        shard.connectPaths = [];
        shard.disconnectPaths = ["presence:onLeave"];

        const ws = createFakeWebSocket();
        shard.registerSocket(ws, attachment());

        // The connect frame records the context on the attachment…
        await shard.driveMessage(ws, connectEnvelope({ roomId: "room-1", sessionId: "sess-1" }));
        // …and close replays it even though no context is supplied at close time.
        await shard.driveClose(ws);

        expect(shard.dispatched).toHaveLength(1);
        expect(shard.dispatched[0]?.functionPath).toBe("presence:onLeave");
        expect(shard.dispatched[0]?.args).toEqual({
            connectionId: "conn-1",
            context: { roomId: "room-1", sessionId: "sess-1" },
            shardKey: "shard-a",
            userId: "user-1",
        });
    });

    it("dispatches no disconnect hook for a socket that never went through the lifecycle upgrade", async () => {
        expect.assertions(1);

        const shard = new LifecycleShard(state, {});
        shard.disconnectPaths = ["presence:onLeave"];

        // A pre-lifecycle attachment: no connectionId recorded at upgrade.
        const ws = createFakeWebSocket();
        shard.registerSocket(ws, { admin: false, subs: {} });

        await shard.driveClose(ws);

        expect(shard.dispatched).toHaveLength(0);
    });

    it("dispatches nothing when no hooks are registered for the event", async () => {
        expect.assertions(1);

        const shard = new LifecycleShard(state, {});
        // Empty manifests (the base default).

        const ws = createFakeWebSocket();
        shard.registerSocket(ws, attachment());

        await shard.driveMessage(ws, connectEnvelope({ roomId: "room-1" }));
        await shard.driveClose(ws);

        expect(shard.dispatched).toHaveLength(0);
    });
});
