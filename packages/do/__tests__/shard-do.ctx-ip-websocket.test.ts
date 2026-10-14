import type { SocketAttachment, SubscriptionEnvelope, SubscriptionIdentity } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { ShardDOState, SubscriptionOutcome } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * `ctx.ip` on the socket path.
 *
 * The forwarded `x-lunora-client-ip` header is read in `beginDispatch`, which
 * only runs for `POST /rpc` — the WS upgrade returns before it. So the socket
 * had no IP of its own, and every read it drove fell back to `getCurrentIp()`:
 * the SHARED per-request field.
 *
 * Two consequences, and the second is the bad one. A subscription seed carries
 * no request at all, so `ctx.ip` read `undefined`. A write-flush re-run, though,
 * runs inside the mutating dispatch's own `flushChangedTables` — before its
 * `endDispatch` clears the field — so every subscriber's query observed the
 * WRITER's IP. The fix is the one identity already uses: capture at upgrade,
 * thread by value.
 */

const SUBSCRIBER_IP = "203.0.113.5";
const WRITER_IP = "198.51.100.1";

/** Minimal WebSocket double mirroring workerd's `serializeAttachment` / `deserializeAttachment` instance methods. */
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

/** One observation of a subscription run: what was threaded in, and what the shared per-request field said at the same instant. */
interface Observation {
    /** `getCurrentIp()` — the shared field the emitted `buildCtx` used to read for `ctx.ip`. */
    shared: string | undefined;
    /** `identity.ip` — what the emitted `buildCtx` now reads for `ctx.ip`. */
    threaded: string | undefined;
}

class IpShard extends ShardDO {
    public readonly seen: Observation[] = [];

    public async handleRpc(functionPath: string): Promise<unknown> {
        if (functionPath === "messages:send") {
            this.recordChangedTable("messages");
        }

        return { ok: true };
    }

    public drive(ws: FakeWebSocket, envelope: SubscriptionEnvelope): Promise<void> {
        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
    }

    public register(ws: FakeWebSocket, attachment: SocketAttachment): void {
        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment(attachment);
    }

    // eslint-disable-next-line class-methods-use-this -- override hook; nothing in this harness is paywalled
    protected override isPaidFunction(): boolean {
        return false;
    }

    /**
     * Stands in for the generated override. The codegen `buildCtx` builds
     * `ctx.ip` from the `identity` argument, so recording it here is recording
     * what a real app's query would see — and `getCurrentIp()` alongside it is
     * what it used to see.
     */
    protected override executeSubscription(
        _functionPath: string,
        _args: Record<string, unknown>,
        identity?: SubscriptionIdentity,
    ): Promise<SubscriptionOutcome | null> {
        this.seen.push({ shared: this.getCurrentIp(), threaded: identity?.ip });

        return Promise.resolve({ result: {}, tables: new Set(["messages"]) });
    }
}

const rpc = (functionPath: string, ip: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { "content-type": "application/json", "x-lunora-client-ip": ip },
        method: "POST",
    });

const makeState = (withWaitUntil: boolean): { pending: Promise<unknown>[]; state: ShardDOState } => {
    const database = createSqliteExec();

    database.raw(`CREATE TABLE "messages" ("__id__" TEXT PRIMARY KEY, "text" TEXT)`);

    const sockets: WebSocket[] = [];
    const pending: Promise<unknown>[] = [];
    const state: ShardDOState = {
        acceptWebSocket(ws: WebSocket) {
            sockets.push(ws);
        },
        getWebSockets(): WebSocket[] {
            return sockets;
        },
        id: { name: "shard-ip" },
        storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        ...(withWaitUntil
            ? {
                  waitUntil: (promise: Promise<unknown>) => {
                      pending.push(promise);
                  },
              }
            : {}),
    };

    return { pending, state };
};

/**
 * Drive a real WS upgrade and return the attachment it stamped.
 *
 * On its OWN throwaway shard: the upgrade accepts its socket into the state it
 * ran against, and a second registered socket carrying the same attachment
 * would then be refreshed twice per write.
 *
 * `WebSocketPair` is a workerd global, and Node rejects the `101` response the
 * upgrade ends with — but the attachment is stamped before that line, so the
 * `RangeError` is expected and the capture is already complete when it throws.
 */
const upgradeAttachment = async (headers: Record<string, string>): Promise<SocketAttachment | undefined> => {
    const shard = new IpShard(makeState(false).state, {});
    const server = createFakeWebSocket();
    const globalWithPair = globalThis as { WebSocketPair?: unknown };
    const original = globalWithPair.WebSocketPair;

    globalWithPair.WebSocketPair = function WebSocketPair() {
        return { 0: {}, 1: server } as unknown;
    };

    try {
        await shard.fetch(new Request("https://shard.internal/", { headers: new Headers({ Upgrade: "websocket", ...headers }) }));
    } catch (error) {
        if (!(error instanceof RangeError)) {
            throw error;
        }
    } finally {
        globalWithPair.WebSocketPair = original;
    }

    return server.attachment;
};

describe("ctx.ip over the WebSocket", () => {
    it("stamps the upgrade's forwarded client IP onto the socket attachment", async () => {
        expect.hasAssertions();

        const attachment = await upgradeAttachment({ "x-lunora-client-ip": SUBSCRIBER_IP });

        expect(attachment?.ip).toBe(SUBSCRIBER_IP);
    });

    it("leaves the attachment IP absent when the upgrade forwarded none", async () => {
        expect.hasAssertions();

        const attachment = await upgradeAttachment({});

        expect(attachment).not.toHaveProperty("ip");
    });

    // Both drains: the inline one, and the host `waitUntil` the DO defers to when
    // the platform offers it. The leak reached subscribers through either.
    it.each([[false], [true]])(
        "runs the seed and the write-flush re-run under the subscriber's IP, never the writer's (waitUntil=%s)",
        async (withWaitUntil: boolean) => {
            expect.hasAssertions();

            const { pending, state } = makeState(withWaitUntil);
            const shard = new IpShard(state, {});
            const ws = createFakeWebSocket();

            const attachment = await upgradeAttachment({ "x-lunora-client-ip": SUBSCRIBER_IP });

            shard.register(ws, attachment as SocketAttachment);
            await shard.drive(ws, { id: "sub1", query: { functionPath: "messages:list" }, type: "subscribe" });

            // A DIFFERENT caller mutates over HTTP under its own IP, which fans the
            // write out to this socket.
            const response = await shard.fetch(rpc("messages:send", WRITER_IP));

            await Promise.all(pending);

            expect(response.status).toBe(200);
            expect(shard.seen).toHaveLength(2);

            const [seed, rerun] = shard.seen as [Observation, Observation];

            // Both halves of the defect: the seed used to see nothing, and the re-run
            // used to see `WRITER_IP`.
            expect(seed.threaded).toBe(SUBSCRIBER_IP);
            expect(rerun.threaded).toBe(SUBSCRIBER_IP);

            // Why the by-value channel is load-bearing rather than incidental: at the
            // instant of the re-run the shared per-request field still holds the
            // writer's IP, because the flush runs before that dispatch's
            // `endDispatch`. Reading it — as `buildCtx` did — is the leak.
            expect(rerun.shared).toBe(WRITER_IP);
        },
    );
});
