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

const createFakeWebSocket = (): FakeWebSocket => {
    return {
        attachment: undefined,
        close(code?: number, reason?: string) {
            this.closes.push({ code, reason });
        },
        closes: [],
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

class LifecycleShard extends ShardDO {
    public readonly dispatched: string[] = [];

    public override async handleRpc(functionPath: string): Promise<unknown> {
        this.dispatched.push(functionPath);

        return undefined;
    }

    public registerSocket(ws: FakeWebSocket, attachment: SocketAttachment): void {
        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment(attachment);
    }

    public driveMessage(ws: FakeWebSocket, envelope: SubscriptionEnvelope): Promise<void> {
        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
    }

    public driveClose(ws: FakeWebSocket): Promise<void> {
        return this.webSocketClose(ws as unknown as WebSocket, 4001, "token_expired", true);
    }

    // eslint-disable-next-line class-methods-use-this -- override stub: the manifest is a fixed list
    protected override lifecycleHookPaths(event: "connect" | "disconnect"): ReadonlyArray<string> {
        return event === "disconnect" ? ["hooks:onLeave"] : [];
    }
}

describe("shardDO: expired-credential socket drop", () => {
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

    const expired = (): SocketAttachment => {
        return { connectionId: "conn-1", expiresAt: 1000, subs: {}, userId: "user-1" };
    };

    it("runs the close teardown itself, because the runtime does not dispatch a close for a server-initiated one", async () => {
        expect.assertions(3);

        const shard = new LifecycleShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, expired());
        await shard.driveMessage(ws, { id: "s", query: { args: {}, functionPath: "messages:list" }, type: "subscribe" });

        // Teardown is queued on the DO's background work; let it settle.
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(ws.closes.map((close) => close.code)).toStrictEqual([4001]);
        // `onDisconnect` is how presence and other connection-scoped cleanup learn the socket is gone.
        expect(shard.dispatched).toStrictEqual(["hooks:onLeave"]);
        // The attachment is cleared, so a later real close finds nothing to tear down twice.
        expect(ws.attachment).toBeUndefined();
    });

    it("does not run the teardown twice when the runtime also delivers a close", async () => {
        expect.assertions(1);

        const shard = new LifecycleShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, expired());
        await shard.driveMessage(ws, { id: "s", query: { args: {}, functionPath: "messages:list" }, type: "subscribe" });
        await shard.driveClose(ws);
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(shard.dispatched).toStrictEqual(["hooks:onLeave"]);
    });
});
