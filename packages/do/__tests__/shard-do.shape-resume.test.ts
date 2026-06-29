import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, readCdcEpoch, runShardMigrations, trimCdcChanges } from "../src/ctx-db";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import type { SocketAttachment } from "../src/types";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

// Characterization tests for the shape `canResume` decision matrix in
// `seedShapeSubscription`. Covers each clause of the five-way conjunction:
//
//   canResume = cdcEnabled() && sinceSeq !== undefined && sinceEpoch === epoch
//            && sinceSeq <= cursor
//            && (sinceSeq === cursor || (floor !== undefined && floor <= sinceSeq + 1))
//
// Observable invariants (asserted on `FakeWebSocket.sent`):
//   - Resume path (canResume = true): the `pokeStart` frame carries a
//     `baseCheckpoint` equal to the client's sinceCheckpoint; `rowsPatch`
//     contains only the diff over (sinceSeq, cursor].
//   - Re-seed path (canResume = false): `pokeStart.baseCheckpoint` is absent
//     (undefined in the parsed frame); `rowsPatch` carries the full current
//     membership as `insert` ops.
//
// The test harness is the same canonical pattern as `shard-do.shape-poke.test.ts`:
// a real `ShardDO` subclass with `resolveShape` wired to `{ channelId }` predicate
// writes through a real `createShardCtxDb` writer over `node:sqlite`.

interface FakeWebSocket {
    attachment: SocketAttachment | undefined;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

const createFakeWebSocket = (): FakeWebSocket => {
    return {
        attachment: { subs: {} },
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

/** Subclass that resolves the `messagesByChannel` shape and writes through a real ctx-db writer. Accepts a `cdc` flag so the same class can test CDC-on and CDC-off. */
class ShapeResumeShard extends ShardDO {
    private readonly cdcMode: boolean;
    private writer: DatabaseWriterLike | undefined;

    public constructor(state: ShardDOState, env: Record<string, unknown>, cdcMode: boolean = true) {
        super(state, env);
        this.cdcMode = cdcMode;
    }

    public override async handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        if (functionPath === "messages:send") {
            await this.getWriter().insert(
                "messages",
                { _id: args["_id"], authorId: "u1", channelId: args["channelId"], text: args["text"] ?? "msg" },
                { allowExplicitId: true },
            );
        }

        this.recordChangedTable("messages");

        return { ok: true };
    }

    // eslint-disable-next-line class-methods-use-this -- test stub override: resolves by `name`/`args` alone, no instance state.
    protected override resolveShape(name: string, args: Record<string, unknown>): { effectiveWhere?: Record<string, unknown>; table: string } | undefined {
        if (name !== "messagesByChannel") {
            return undefined;
        }

        return { effectiveWhere: { channelId: args["channelId"] }, table: "messages" };
    }

    private getWriter(): DatabaseWriterLike {
        this.writer ??= createShardContextDatabase({
            broadcast: () => undefined,
            cdc: this.cdcMode,
            clock: () => 1_700_000_000_000,
            schema: messagesSchema,
            sql: this.sql as Parameters<typeof createShardContextDatabase>[0]["sql"],
        });

        return this.writer;
    }
}

let harness: ReturnType<typeof createSqliteExec>;

const makeState = (sockets: FakeWebSocket[]): ShardDOState => {
    return {
        acceptWebSocket(ws) {
            sockets.push(ws as unknown as FakeWebSocket);
        },
        getWebSockets() {
            return sockets as unknown as WebSocket[];
        },
        storage: { sql: harness.sql as unknown as ShardDOState["storage"]["sql"] },
    };
};

const write = (functionPath: string, args: Record<string, unknown>): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

/** Subscribe with a resume hint — supplies both `sinceCheckpoint` and `sinceEpoch`. */
const subscribeShapeWithResume = async (shard: ShardDO, ws: FakeWebSocket, channelId: string, sinceCheckpoint: number, sinceEpoch: string): Promise<void> => {
    await shard.webSocketMessage(
        ws as unknown as WebSocket,
        JSON.stringify({
            id: "s1",
            shape: { args: { channelId }, name: "messagesByChannel" },
            sinceCheckpoint,
            sinceEpoch,
            type: "shape_subscribe",
        }),
    );
};

/** Extract the `pokeStart` frame from a socket's sent messages. */
const pokeStartFrame = (ws: FakeWebSocket): { baseCheckpoint?: number; type: string } => {
    const frames = ws.sent.map((raw) => JSON.parse(raw) as { baseCheckpoint?: number; type: string });
    const start = frames.find((f) => f.type === "pokeStart");

    if (!start) {
        throw new Error("no pokeStart frame found");
    }

    return start;
};

/** Collect the row-ops across every `pokePart` frame the socket received. */
const pokeOps = (ws: FakeWebSocket): { key: string; op: string; value?: Record<string, unknown> }[] =>
    ws.sent
        .map((raw) => JSON.parse(raw) as { rowsPatch?: { key: string; op: string; value?: Record<string, unknown> }[]; type: string })
        .filter((frame) => frame.type === "pokePart")
        .flatMap((frame) => frame.rowsPatch ?? []);

describe("shardDO shape canResume decision matrix", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, messagesSchema, { cdc: true });
    });

    afterEach(() => {
        harness.close();
    });

    it("clause 1-5 all pass: resumes via diff path — only rows since sinceSeq appear", async () => {
        expect.assertions(3);

        // Clause coverage: cdcEnabled=true, sinceSeq defined, epoch matches, sinceSeq<=cursor, floor<=sinceSeq+1.
        const sockets: FakeWebSocket[] = [];
        const shard = new ShapeResumeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        sockets.push(ws);

        // Write m1 → CDC seq=1. Write m2 → CDC seq=2.
        await shard.fetch(write("messages:send", { _id: "m1", channelId: "c1", text: "msg-1" }));
        await shard.fetch(write("messages:send", { _id: "m2", channelId: "c1", text: "msg-2" }));

        // Mint (or read) the epoch so we can supply it in sinceEpoch.
        const epoch = readCdcEpoch(harness.sql);
        ws.sent.length = 0;

        // Client holds m1 (sinceCheckpoint=1); resume diff covers (1, 2] → only m2.
        await subscribeShapeWithResume(shard, ws, "c1", 1, epoch);

        const start = pokeStartFrame(ws);

        // Resume path: baseCheckpoint is set to the client's sinceCheckpoint.
        expect(start.baseCheckpoint).toBe(1);

        // Diff contains only m2 — m1 was already known to the client.
        const ops = pokeOps(ws);

        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ key: "m2", op: "insert", table: "messages" });
    });

    it("clause 3 fails (epoch mismatch): falls back to full re-seed", async () => {
        expect.assertions(3);

        const sockets: FakeWebSocket[] = [];
        const shard = new ShapeResumeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        sockets.push(ws);

        await shard.fetch(write("messages:send", { _id: "m1", channelId: "c1", text: "msg-1" }));

        // Mint the real epoch; subscribe with a stale one.
        readCdcEpoch(harness.sql);
        ws.sent.length = 0;

        await subscribeShapeWithResume(shard, ws, "c1", 0, "stale-epoch");

        const start = pokeStartFrame(ws);

        // Re-seed path: baseCheckpoint absent.
        expect(start.baseCheckpoint).toBeUndefined();

        // Full membership: m1.
        const ops = pokeOps(ws);

        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ key: "m1", op: "insert" });
    });

    it("clause 4 fails (client ahead of cursor): falls back to full re-seed", async () => {
        expect.assertions(3);

        const sockets: FakeWebSocket[] = [];
        const shard = new ShapeResumeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        sockets.push(ws);

        // cursor = 1 after one write.
        await shard.fetch(write("messages:send", { _id: "m1", channelId: "c1", text: "msg-1" }));

        const epoch = readCdcEpoch(harness.sql);
        ws.sent.length = 0;

        // sinceCheckpoint=5 > cursor=1 → rollback guard fires → re-seed.
        await subscribeShapeWithResume(shard, ws, "c1", 5, epoch);

        const start = pokeStartFrame(ws);

        expect(start.baseCheckpoint).toBeUndefined();

        const ops = pokeOps(ws);

        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ key: "m1", op: "insert" });
    });

    it("clause 5 fails (retention gap: floor > sinceSeq + 1): falls back to full re-seed", async () => {
        expect.assertions(3);

        const sockets: FakeWebSocket[] = [];
        const shard = new ShapeResumeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        sockets.push(ws);

        // Write m1 (seq=1), m2 (seq=2). Trim seq=1 → floor becomes 2.
        await shard.fetch(write("messages:send", { _id: "m1", channelId: "c1", text: "msg-1" }));
        await shard.fetch(write("messages:send", { _id: "m2", channelId: "c1", text: "msg-2" }));
        trimCdcChanges(harness.sql, 1);

        // floor=2, sinceSeq=0, sinceSeq+1=1, 2 > 1 → retention gap → re-seed.
        const epoch = readCdcEpoch(harness.sql);
        ws.sent.length = 0;

        await subscribeShapeWithResume(shard, ws, "c1", 0, epoch);

        const start = pokeStartFrame(ws);

        expect(start.baseCheckpoint).toBeUndefined();

        // Full membership: both m1 and m2.
        const ops = pokeOps(ws);

        expect(ops).toHaveLength(2);
        expect(ops.map((o) => o.key).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["m1", "m2"]);
    });

    it("clause 5 edge: fully-compacted log, client already at cursor → resume with empty diff", async () => {
        expect.assertions(2);

        // Covers: sinceSeq === cursor (the only safe resume when floor === undefined).
        const sockets: FakeWebSocket[] = [];
        const shard = new ShapeResumeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        sockets.push(ws);

        // Write m1 (seq=1), then trim all entries → floor=undefined, cursor=1.
        await shard.fetch(write("messages:send", { _id: "m1", channelId: "c1", text: "msg-1" }));
        trimCdcChanges(harness.sql, 1);

        const epoch = readCdcEpoch(harness.sql);
        ws.sent.length = 0;

        // Client already at cursor=1 → sinceSeq === cursor → resume (nothing to diff).
        await subscribeShapeWithResume(shard, ws, "c1", 1, epoch);

        const start = pokeStartFrame(ws);

        // Resume path: baseCheckpoint = sinceCheckpoint = 1.
        expect(start.baseCheckpoint).toBe(1);

        // Empty diff (no changes in (1,1]).
        expect(pokeOps(ws)).toHaveLength(0);
    });

    it("clause 5 edge: fully-compacted log, client lagging → re-seeds (can't prove what was missed)", async () => {
        expect.assertions(3);

        // Covers: floor === undefined but sinceSeq < cursor (the trimmed changes are unknown).
        const sockets: FakeWebSocket[] = [];
        const shard = new ShapeResumeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        sockets.push(ws);

        // Write m1 (seq=1), m2 (seq=2), trim all → floor=undefined, cursor=2.
        await shard.fetch(write("messages:send", { _id: "m1", channelId: "c1", text: "msg-1" }));
        await shard.fetch(write("messages:send", { _id: "m2", channelId: "c1", text: "msg-2" }));
        trimCdcChanges(harness.sql, 2);

        const epoch = readCdcEpoch(harness.sql);
        ws.sent.length = 0;

        // Client at sinceCheckpoint=0, cursor=2, floor=undefined → can't prove nothing missed → re-seed.
        await subscribeShapeWithResume(shard, ws, "c1", 0, epoch);

        const start = pokeStartFrame(ws);

        expect(start.baseCheckpoint).toBeUndefined();

        // Full membership: m1 and m2.
        const ops = pokeOps(ws);

        expect(ops).toHaveLength(2);
        expect(ops.map((o) => o.key).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["m1", "m2"]);
    });
});

describe("shardDO shape canResume — CDC disabled", () => {
    let noCdcHarness: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        noCdcHarness = createSqliteExec();
        runShardMigrations(noCdcHarness.sql, messagesSchema, { cdc: false });
    });

    afterEach(() => {
        noCdcHarness.close();
    });

    it("clause 1 fails (CDC disabled): falls back to full re-seed regardless of sinceCheckpoint/sinceEpoch", async () => {
        expect.assertions(3);

        // Build the shard and harness state against the no-CDC sql.
        const sockets: FakeWebSocket[] = [];
        const state: ShardDOState = {
            acceptWebSocket(ws) {
                sockets.push(ws as unknown as FakeWebSocket);
            },
            getWebSockets() {
                return sockets as unknown as WebSocket[];
            },
            storage: { sql: noCdcHarness.sql as unknown as ShardDOState["storage"]["sql"] },
        };
        const shard = new ShapeResumeShard(state, {}, false);
        const ws = createFakeWebSocket();
        sockets.push(ws);

        // Write m1 without CDC.
        await shard.fetch(write("messages:send", { _id: "m1", channelId: "c1", text: "msg-1" }));
        ws.sent.length = 0;

        // Even a matching sinceEpoch + in-range sinceCheckpoint must re-seed when CDC is off.
        await shard.webSocketMessage(
            ws as unknown as WebSocket,
            JSON.stringify({
                id: "s1",
                shape: { args: { channelId: "c1" }, name: "messagesByChannel" },
                sinceCheckpoint: 0,
                sinceEpoch: "any-epoch",
                type: "shape_subscribe",
            }),
        );

        const start = pokeStartFrame(ws);

        expect(start.baseCheckpoint).toBeUndefined();

        // Full membership: m1.
        const ops = pokeOps(ws);

        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ key: "m1", op: "insert" });
    });
});
