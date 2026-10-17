import { serialize } from "node:v8";

import type { SocketAttachment, SubscriptionIdentity } from "@lunora/shard-engine";
import { readCdcEpoch, runShardMigrations } from "@lunora/shard-engine";
import { vi } from "vitest";

import { signSiblingBody } from "../../../shard-engine/src/sibling-channel";
import type { DeliveryAuthorization, DeliveryPermit } from "../../src/delivery-authorization";
import type { ShardDOState, SubscriptionOutcome } from "../../src/shard-do";
import { ShardDO } from "../../src/shard-do";
import messagesSchema from "./messages-schema";
import createSqliteExec from "./node-sqlite";

const drainState = vi.hoisted(() => {
    return { run: async (): Promise<void> => {} };
});
vi.mock(import("@lunora/shard-engine"), async (importOriginal) => {
    const original = await importOriginal();
    return { ...original, awaitWsDrain: () => drainState.run() };
});

const secret = "test-internal-control-secret";
const databases: ReturnType<typeof createSqliteExec>[] = [];

type Setup = {
    authority: ReturnType<typeof vi.fn<DeliveryAuthorization>>;
    database: ReturnType<typeof createSqliteExec>;
    fence: (target?: TestShard, nextEpoch?: number, signed?: boolean) => Promise<Response>;
    makeShard: () => TestShard;
    regrant: () => void;
    revoke: () => void;
    send: (target?: TestShard, sinceSeq?: number) => Promise<void>;
    shard: TestShard;
    socket: Socket;
    state: ShardDOState;
    write: (operationKey?: string) => Promise<Response>;
};

type Gate = {
    promise: Promise<void>;
    resolve: () => void;
};

const permit = (epoch: number): DeliveryPermit => {
    return { scope: "opaque-authority-scope", epoch };
};
const gate = (): Gate => {
    const deferred = Promise.withResolvers<undefined>();
    return {
        promise: deferred.promise,
        resolve: () => {
            deferred.resolve(undefined);
        },
    };
};

class Socket {
    public attachment: SocketAttachment = { subs: {}, identity: { subject: "alice" }, userId: "alice" };
    public readonly frames: Record<string, unknown>[] = [];
    public saves = 0;
    public attachmentLimit = 16_384;

    public deserializeAttachment(): SocketAttachment {
        return structuredClone(this.attachment);
    }

    public serializeAttachment(attachment: SocketAttachment): void {
        if (serialize(attachment).byteLength > this.attachmentLimit) {
            throw new Error("attachment too large");
        }
        this.saves += 1;
        this.attachment = structuredClone(attachment);
    }

    public send(frame: string): void {
        this.frames.push(JSON.parse(frame) as Record<string, unknown>);
    }
}

class TestShard extends ShardDO {
    public rows = ["before"];
    public rpcGate: Promise<void> | undefined;
    public rpcStarted = gate();
    public rpcRuns = 0;
    public queryStarted = gate();
    public queryGate: Promise<void> | undefined;
    public queryCalls = 0;
    public queryFailure: Error | undefined;
    public observedIdentity: SubscriptionIdentity | undefined;

    public override async handleRpc(functionPath: string): Promise<unknown> {
        this.rpcRuns += 1;
        if (functionPath === "messages:slow") {
            this.rpcStarted.resolve();
            await this.rpcGate;
        }
        this.recordChangedTable("messages");
        return { result: "receipt-payload" };
    }

    protected override async executeSubscription(_path: string, _args: Record<string, unknown>, identity?: SubscriptionIdentity): Promise<SubscriptionOutcome> {
        this.queryCalls += 1;
        if (this.queryFailure !== undefined) {
            throw this.queryFailure;
        }
        this.observedIdentity = identity;
        const rows = [...this.rows];
        this.queryStarted.resolve();
        await this.queryGate;
        return { result: rows, tables: new Set(["messages"]) };
    }
}

const cleanupDatabases = (): void => {
    drainState.run = async () => {};
    for (const database of databases.splice(0)) {
        database.close();
    }
};

const setup = (shardKey?: string): Setup => {
    const database = createSqliteExec();
    databases.push(database);
    runShardMigrations(database.sql, messagesSchema, { cdc: true });
    let allowed = true;
    let epoch = 0;
    const authority = vi.fn<DeliveryAuthorization>(async () => (allowed ? permit(epoch) : undefined));
    const socket = new Socket();
    const state: ShardDOState = {
        acceptWebSocket() {},
        ...(shardKey === undefined ? {} : { id: { name: shardKey } }),
        getWebSockets: () => [socket as unknown as WebSocket],
        storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
    };
    const makeShard = (): TestShard => new TestShard(state, { LUNORA_RELAY_SECRET: secret }, { deliveryAuthorization: authority });
    const shard = makeShard();
    const send = (target: TestShard = shard, sinceSeq?: number): Promise<void> =>
        target.webSocketMessage(
            socket as unknown as WebSocket,
            JSON.stringify({
                type: "subscribe",
                id: "view",
                query: { functionPath: "messages:list", args: {}, sinceSeq, sinceEpoch: readCdcEpoch(database.sql) },
            }),
        );
    const fence = async (target: TestShard = shard, nextEpoch = 1, signed = true): Promise<Response> => {
        const raw = JSON.stringify({ type: "delivery-fence", shardKey, fence: permit(nextEpoch) });
        return target.fetch(
            new Request("https://shard.internal/_lunora/delivery-fence", {
                method: "POST",
                body: raw,
                headers: signed ? { "x-lunora-relay-sig": await signSiblingBody(secret, raw) } : {},
            }),
        );
    };
    const write = (operationKey?: string): Promise<Response> =>
        shard.fetch(
            new Request("https://shard.internal/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "messages:write", args: {} }),
                headers: {
                    "x-lunora-userid": "alice",
                    "x-lunora-identity": JSON.stringify({ subject: "alice" }),
                    ...(operationKey === undefined ? {} : { "x-lunora-mutation-id": operationKey }),
                },
            }),
        );
    const revoke = (): void => {
        allowed = false;
        epoch += 1;
    };
    const regrant = (): void => {
        allowed = true;
        epoch += 1;
    };

    return { database, authority, socket, shard, makeShard, state, send, fence, write, revoke, regrant };
};

const dataFrames = (socket: Socket): Record<string, unknown>[] =>
    socket.frames.filter((frame) => ["data", "delta", "resume", "settled"].includes(String(frame.type)));

export { cleanupDatabases, dataFrames, drainState as drain, gate, permit, secret, setup, Socket, TestShard };
