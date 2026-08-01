/**
 * Plan 266 S4 — a plain `{type:"data"}` subscription frame now carries the
 * SAME per-client `lastMutationId` stamp the sibling `{type:"settled"}` frame
 * already carried (see `pushSubscriptionData` in `shard-do.ts`), closing the
 * gap where the client had no per-frame watermark to trust and instead
 * compensated with a provisional, frame-independent signal.
 *
 * Unlike `subscription-refresh.integration.test.ts`'s fake `sql.exec()` (which
 * always returns empty rows, so `socketClientWatermark` reads `0` for every
 * clientId), this suite drives the REAL `node:sqlite` harness so the announced
 * client's `__client_watermark` genuinely advances via the custom-mutator
 * dispatch path — the only way to observe a non-zero stamped value.
 */
import type { SocketAttachment, SubscriptionEnvelope } from "@lunora/shard-engine";
import { runShardMigrations } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { ShardDOState, SubscriptionOutcome } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

// ---------------------------------------------------------------------------
// Fake WebSocket — mirrors the shape in subscription-refresh.integration.test.ts.
// ---------------------------------------------------------------------------
interface FakeWebSocket {
    attachment: SocketAttachment | undefined;
    close: (code?: number, reason?: string) => void;
    closed: boolean;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

const createFakeWebSocket = (): FakeWebSocket => {
    return {
        attachment: undefined,
        close() {
            this.closed = true;
        },
        closed: false,
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

const makeState = (database: ReturnType<typeof createSqliteExec>): ShardDOState & { sockets: FakeWebSocket[] } => {
    const sockets: FakeWebSocket[] = [];

    return {
        acceptWebSocket(ws) {
            sockets.push(ws as unknown as FakeWebSocket);
        },
        getWebSockets() {
            return sockets as unknown as WebSocket[];
        },
        sockets,
        storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
    };
};

/**
 * A shard whose `messages:list` subscription returns a NEW result (a fresh
 * row) on every call — so a refresh always takes the plain `data` frame path,
 * never the `settled` (byte-identical) suppression path — and whose
 * `handleRpc` runs a real custom-mutator commit for `messages:sendMutator`
 * (advancing `__client_watermark` via `commitMutationBookkeeping`, exactly
 * like `CountingMutatorShard` in `shard-do.client-watermark.test.ts`) while
 * also recording `messages` as changed so the write triggers the
 * subscription-refresh pipeline.
 */
class DataWatermarkShard extends ShardDO {
    private nextRow = 0;

    public override handleRpc(functionPath: string): Promise<unknown> {
        return this.runInTransaction(() => {
            this.recordChangedTable("messages");

            const result = { ok: true, path: functionPath };

            this.commitMutationBookkeeping(result);

            return result;
        });
    }

    public registerSocket(ws: FakeWebSocket, attachment?: SocketAttachment): void {
        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment(attachment ?? { subs: {} });
    }

    public driveMessage(ws: FakeWebSocket, envelope: SubscriptionEnvelope): Promise<void> {
        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
    }

    /** Push a custom-mutator write (advances `__client_watermark` for `clientId`) and touches "messages". */
    public pushMutator(clientId: string, seq: number): Promise<Response> {
        return this.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:sendMutator" }),
                headers: { "content-type": "application/json", "x-lunora-client-id": clientId, "x-lunora-client-seq": String(seq) },
                method: "POST",
            }),
        );
    }

    // eslint-disable-next-line class-methods-use-this -- test stub override: classifies by `functionPath` alone, no instance state.
    protected override isCustomMutator(functionPath: string): boolean {
        return functionPath === "messages:sendMutator";
    }

    protected override executeSubscription(_functionPath: string, _args: Record<string, unknown>): Promise<SubscriptionOutcome | null> {
        this.nextRow += 1;

        const outcome: SubscriptionOutcome = {
            result: [{ _id: `m${String(this.nextRow)}`, text: `row ${String(this.nextRow)}` }],
            tables: new Set(["messages"]),
        };

        return Promise.resolve(outcome);
    }
}

/** `{type:"data"}` frames for a given subId, with their (optional) `lastMutationId`. */
const dataFrames = (ws: FakeWebSocket, subId: string): { data?: unknown; lastMutationId?: number }[] =>
    ws.sent
        .map((line) => JSON.parse(line) as { data?: unknown; id: string; lastMutationId?: number; type: string })
        .filter((frame) => frame.type === "data" && frame.id === subId)
        .map((frame) => {
            return { data: frame.data, lastMutationId: frame.lastMutationId };
        });

/** The raw (unmapped) last `{type:"data"}` frame for a subId — used to check field ABSENCE, not just `undefined`. */
const lastRawDataFrame = (ws: FakeWebSocket, subId: string): Record<string, unknown> | undefined =>
    ws.sent.map((line) => JSON.parse(line) as Record<string, unknown>).findLast((frame) => frame.type === "data" && frame.id === subId);

const subscribeSocket = (shard: DataWatermarkShard, ws: FakeWebSocket, subId: string, functionPath: string): Promise<void> =>
    shard.driveMessage(ws, { id: subId, query: { args: {}, functionPath }, type: "subscribe" });

describe("shardDO: plain data frame carries the per-client lastMutationId (plan 266 S4)", () => {
    it("stamps lastMutationId on a data frame for a clientId socket with an advanced watermark; omits it for a socket with no clientId", async () => {
        expect.assertions(4);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });

            const shard = new DataWatermarkShard(makeState(database), {});

            // Socket A announces a clientId (a custom-mutator @lunora/db client).
            const wsA = createFakeWebSocket();

            shard.registerSocket(wsA, { clientId: "client-A", subs: {}, userId: "" });

            // Socket B is a plain useQuery client — no clientId.
            const wsB = createFakeWebSocket();

            shard.registerSocket(wsB);

            await subscribeSocket(shard, wsA, "sub-A", "messages:list");
            await subscribeSocket(shard, wsB, "sub-B", "messages:list");

            // The seed frame already carries client-A's watermark (0 — the
            // resting default `readClientWatermark` returns for a clientId
            // with no row yet, since it announced a clientId).
            expect(dataFrames(wsA, "sub-A")[0]?.lastMutationId).toBe(0);

            // Client A's mutator write advances ITS watermark to 1 and touches
            // "messages", refreshing both subscriptions with a NEW row (never
            // byte-identical, so this always takes the plain `data` path).
            await shard.pushMutator("client-A", 1);

            const framesA = dataFrames(wsA, "sub-A");
            const framesB = dataFrames(wsB, "sub-B");

            // The refreshed frame on socket A (clientId "client-A") carries the
            // now-advanced watermark.
            expect(framesA.at(-1)?.lastMutationId).toBe(1);

            // The refreshed frame on socket B (no clientId) carries no field at
            // all — not `undefined`-valued, ABSENT (wire-compat: an old client
            // checking `"lastMutationId" in frame` must see it missing).
            const rawFrameB = lastRawDataFrame(wsB, "sub-B");

            expect(rawFrameB && "lastMutationId" in rawFrameB).toBe(false);
            // The refresh still delivered a (new, non-suppressed) row.
            expect(framesB.at(-1)?.data).not.toStrictEqual(framesB[0]?.data);
        } finally {
            database.close();
        }
    });
});
