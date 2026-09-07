/**
 * Dispatches that are NOT an `/rpc` request must be metered against their OWN
 * transaction budget.
 *
 * `dispatchLifecycle` (the `onConnect`/`onDisconnect` hooks), `handleRunAs` and
 * the admin `runShardWrite` behind the studio's row editor all call `handleRpc`
 * without minting a tracker, so the generated ctx falls back to
 * `this.transactionHeadroom()`. That used to hand back an INSTANCE FIELD
 * stamped by `beginDispatch` — "the meter of whichever `/rpc` is in flight" —
 * so a hook either spent an unrelated mutation's budget (tripping a ceiling
 * neither of them caused) or, with no dispatch in flight, ran unmetered.
 *
 * `handleRpc` below mirrors what codegen emits: `headroom ?? this.transactionHeadroom()`.
 */
import type { SchemaLike, SocketAttachment, SqlExec, SubscriptionEnvelope, TransactionHeadroomTracker } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/shard-engine";
import { beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

const schema: SchemaLike = {
    tables: {
        items: {
            indexes: [],
            shape: { value: { kind: "string" } },
        },
    },
};

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

/**
 * `presence:onConnect` writes {@link HookShard.hookWrites} rows; `notes:write`
 * writes one row, parks on `gate`, then writes one more. With
 * `maxWrittenRows: 2` a two-row hook is exactly its own budget and over a
 * shared one, so "did it throw" reads out as "whose meter did it spend".
 */
class HookShard extends ShardDO {
    public connectPaths: string[] = [];

    /** Rows the `presence:onConnect` hook writes. */
    public hookWrites = 2;

    /** Error codes escaping each handler, keyed by functionPath — `undefined` means it completed. */
    public readonly failures = new Map<string, string | undefined>();

    public gate: Promise<void> | undefined;

    /** Resolves once `notes:write` has made its first write and parked. */
    public readonly parked: Promise<void>;

    private readonly signalParked: () => void;

    public constructor(state: ShardDOState, env: unknown) {
        super(state, env);

        let signal!: () => void;

        this.parked = new Promise<void>((resolve) => {
            signal = resolve;
        });
        this.signalParked = signal;
    }

    public override async handleRpc(functionPath: string, _args: Record<string, unknown>, headroom?: TransactionHeadroomTracker): Promise<unknown> {
        const writer = createShardContextDatabase({
            headroom: headroom ?? this.transactionHeadroom(),
            schema,
            sql: this.sql as SqlExec,
        });

        try {
            if (functionPath === "notes:write") {
                await writer.insert("items", { value: "notes-1" });
                this.signalParked();
                await this.gate;
                await writer.insert("items", { value: "notes-2" });
            } else {
                for (let index = 0; index < this.hookWrites; index += 1) {
                    // eslint-disable-next-line no-await-in-loop -- writes must land in order against the one tracker under test
                    await writer.insert("items", { value: `${functionPath}-${String(index)}` });
                }
            }

            this.failures.set(functionPath, undefined);
        } catch (error: unknown) {
            this.failures.set(functionPath, (error as { code?: string }).code ?? String(error));

            throw error;
        }

        return { ok: true };
    }

    public driveMessage(ws: FakeWebSocket, envelope: SubscriptionEnvelope): Promise<void> {
        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
    }

    public registerSocket(ws: FakeWebSocket): void {
        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment({ connectionId: "conn-1", subs: {} });
    }

    protected override lifecycleHookPaths(event: "connect" | "disconnect" | "init" | "reactor"): ReadonlyArray<string> {
        return event === "connect" ? this.connectPaths : [];
    }

    // eslint-disable-next-line class-methods-use-this -- deliberately tiny so a shared budget trips within two handlers
    protected override transactionLimits(): { maxWrittenRows: number } {
        return { maxWrittenRows: 2 };
    }
}

const rpcRequest = (functionPath: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

describe("out-of-band dispatches are metered against their own budget", () => {
    let harness: ReturnType<typeof createSqliteExec>;
    let shard: HookShard;
    let sockets: FakeWebSocket[];

    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);

        sockets = [];

        const state: ShardDOState = {
            acceptWebSocket(ws: WebSocket) {
                sockets.push(ws as unknown as FakeWebSocket);
            },
            getWebSockets(): WebSocket[] {
                return sockets as unknown as WebSocket[];
            },
            storage: { sql: harness.sql as unknown as ShardDOState["storage"]["sql"] },
        };

        shard = new HookShard(state, {});
        shard.connectPaths = ["presence:onConnect"];
    });

    it("meters an onConnect hook that runs with no /rpc dispatch in flight", async () => {
        expect.assertions(1);

        // One row over the ceiling. With the ambient fallback there was no
        // dispatch in flight, so `transactionHeadroom()` answered `undefined`,
        // the hook built an UNMETERED writer and all three rows landed — a
        // runaway hook could take the isolate down.
        shard.hookWrites = 3;

        const ws = createFakeWebSocket();

        shard.registerSocket(ws);
        await shard.driveMessage(ws, { id: "connect", type: "connect" });

        expect(shard.failures.get("presence:onConnect")).toBe("TRANSACTION_LIMIT_EXCEEDED");
    });

    it("does not charge an onConnect hook to the in-flight /rpc's budget", async () => {
        expect.assertions(3);

        const ws = createFakeWebSocket();

        shard.registerSocket(ws);

        let release!: () => void;

        shard.gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        // Park a mutation mid-handler with one row of its two-row budget spent.
        const rpc = shard.fetch(rpcRequest("notes:write"));

        await shard.parked;

        // The hook's two writes land while that mutation is parked. On a shared
        // meter the mutation has already spent one of the two rows, so the
        // hook's second write trips a ceiling it did not cause.
        await shard.driveMessage(ws, { id: "connect", type: "connect" });

        expect(shard.failures.get("presence:onConnect")).toBeUndefined();

        release();

        const response = await rpc;

        // ...and, symmetrically, the mutation still has its own second row.
        expect(response.status).toBe(200);
        expect(shard.failures.get("notes:write")).toBeUndefined();
    });
});
