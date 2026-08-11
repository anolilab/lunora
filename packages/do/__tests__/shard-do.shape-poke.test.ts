import type { CdcChange, DatabaseWriterLike, SocketAttachment, SqlExec } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, readCdcCursor, readShapePokeCursor, runShardMigrations } from "@lunora/shard-engine";
import { beforeEach, describe, expect, it } from "vitest";

import { encodeWire } from "../../../shared/wire-codec";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * End-to-end shape poke protocol over the real dispatch + CDC path. A socket
 * `shape_subscribe`s to a `channelId`-scoped shape; the seed ships the current
 * membership as an insert-poke, and each subsequent write flush pokes the
 * membership diff:
 * - an in-channel insert → `insert` row-op;
 * - a row moved OUT of the channel → `delete` row-op (left the set);
 * - an out-of-channel write → no poke part (nothing the shape cares about).
 *
 * The base `ShardDO` resolves no shapes, so the test subclass overrides
 * `resolveShape` (the same hook the codegen subclass overrides) to a flat
 * `{ channelId }` predicate, and writes through a real `createShardCtxDb` writer
 * so the JSON-blob store + `__cdc_log` behave exactly as in a Durable Object.
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

/** A shard whose only shape is `messagesByChannel(channelId)` and whose `handleRpc` writes through a real ctx-db writer. */
class ShapePokeShard extends ShardDO {
    private writer: DatabaseWriterLike | undefined;

    public override async handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        const writer = this.getWriter();

        switch (functionPath) {
            case "messages:move": {
                await writer.patch(args["_id"] as string, { channelId: args["channelId"] });

                break;
            }
            case "messages:remove": {
                await writer.delete(args["_id"] as string);

                break;
            }
            case "messages:send": {
                await writer.insert(
                    "messages",
                    { _id: args["_id"], authorId: "u1", channelId: args["channelId"], text: args["text"] ?? "x" },
                    { allowExplicitId: true },
                );

                break;
            }
            default: {
                break;
            }
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
            cdc: true,
            clock: () => 1_700_000_000_000,
            schema: messagesSchema,
            sql: this.sql as Parameters<typeof createShardContextDatabase>[0]["sql"],
        });

        return this.writer;
    }
}

/**
 * {@link ShapePokeShard} that counts every `__cdc_log` page read backing a shape
 * diff, so a test can prove the flush-local op-range cache collapses N
 * same-range shape diffs to ONE changelog drain.
 */
class CountingShapePokeShard extends ShapePokeShard {
    public cdcPageReads = 0;

    /** Every `sinceSeq` a shape diff was drained from, in call order — lets a test pin exactly which baseline a poke resumed from. */
    public sinceSeqSeen: number[] = [];

    protected override readShapeCdcPage(sql: SqlExec, sinceSeq: number, tables: ReadonlySet<string>): { changes: CdcChange[]; cursor: number } {
        this.cdcPageReads += 1;
        this.sinceSeqSeen.push(sinceSeq);

        return super.readShapeCdcPage(sql, sinceSeq, tables);
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
        // No `waitUntil` → `flushChangedTables` awaits the fan-out synchronously,
        // so a poke is observable immediately after `fetch` resolves.
        storage: { sql: harness.sql as unknown as ShardDOState["storage"]["sql"] },
    };
};

const write = (functionPath: string, args: Record<string, unknown>): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

const subscribeShape = async (shard: ShardDO, ws: FakeWebSocket, channelId: string): Promise<void> => {
    await shard.webSocketMessage(
        ws as unknown as WebSocket,
        JSON.stringify({ id: "s1", shape: { args: { channelId }, name: "messagesByChannel" }, type: "shape_subscribe" }),
    );
};

/** Collect the row-ops across every `pokePart` frame the socket received. */
const pokeOps = (ws: FakeWebSocket): { key: string; op: string; value?: Record<string, unknown> }[] =>
    ws.sent
        .map((raw) => JSON.parse(raw) as { rowsPatch?: { key: string; op: string; value?: Record<string, unknown> }[]; type: string })
        .filter((frame) => frame.type === "pokePart")
        .flatMap((frame) => frame.rowsPatch ?? []);

const frameTypes = (ws: FakeWebSocket): string[] => ws.sent.map((raw) => (JSON.parse(raw) as { type: string }).type);

describe("shardDO shape poke protocol (dispatch path)", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, messagesSchema, { cdc: true });
    });

    it("acks and seeds a fresh subscription with the current membership", async () => {
        expect.assertions(3);

        const sockets: FakeWebSocket[] = [];
        const shard = new ShapePokeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        sockets.push(ws);

        // Pre-existing rows: one in c1, one in c2.
        await shard.fetch(write("messages:send", { _id: "m1", channelId: "c1" }));
        await shard.fetch(write("messages:send", { _id: "m2", channelId: "c2" }));
        ws.sent.length = 0;

        await subscribeShape(shard, ws, "c1");

        // The full seed poke (start/part/end) carrying only the c1 row, then the
        // ack last — the ack is sent only after the shape resolves and seeds.
        expect(frameTypes(ws)).toStrictEqual(["pokeStart", "pokePart", "pokeEnd", "ack"]);

        const ops = pokeOps(ws);

        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ key: "m1", op: "insert" });
    });

    it("pokes an insert when a new row joins the shape", async () => {
        expect.assertions(2);

        const sockets: FakeWebSocket[] = [];
        const shard = new ShapePokeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        sockets.push(ws);

        await subscribeShape(shard, ws, "c1");
        ws.sent.length = 0;

        await shard.fetch(write("messages:send", { _id: "m3", channelId: "c1", text: "hi" }));

        expect(frameTypes(ws)).toStrictEqual(["pokeStart", "pokePart", "pokeEnd"]);
        expect(pokeOps(ws)).toStrictEqual([{ key: "m3", op: "insert", table: "messages", value: expect.objectContaining({ _id: "m3", text: "hi" }) }]);
    });

    it("pokes a delete when a row moves out of the shape", async () => {
        expect.assertions(1);

        const sockets: FakeWebSocket[] = [];
        const shard = new ShapePokeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        sockets.push(ws);

        await shard.fetch(write("messages:send", { _id: "m1", channelId: "c1" }));
        await subscribeShape(shard, ws, "c1");
        ws.sent.length = 0;

        // Move m1 from c1 → c2: it left the membership set → delete row-op.
        await shard.fetch(write("messages:move", { _id: "m1", channelId: "c2" }));

        expect(pokeOps(ws)).toStrictEqual([{ key: "m1", op: "delete", table: "messages" }]);
    });

    it("sends no poke when a write touches only rows outside the shape", async () => {
        expect.assertions(1);

        const sockets: FakeWebSocket[] = [];
        const shard = new ShapePokeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        sockets.push(ws);

        await subscribeShape(shard, ws, "c1");
        ws.sent.length = 0;

        // A write entirely in c2 changes the table but no c1 member.
        await shard.fetch(write("messages:send", { _id: "m9", channelId: "c2" }));

        expect(ws.sent).toStrictEqual([]);
    });

    it("isolates shapes per socket identity/args", async () => {
        expect.assertions(2);

        const sockets: FakeWebSocket[] = [];
        const shard = new ShapePokeShard(makeState(sockets), {});
        const a = createFakeWebSocket();
        const b = createFakeWebSocket();
        sockets.push(a, b);

        await subscribeShape(shard, a, "c1");
        await shard.webSocketMessage(
            b as unknown as WebSocket,
            JSON.stringify({ id: "s1", shape: { args: { channelId: "c2" }, name: "messagesByChannel" }, type: "shape_subscribe" }),
        );
        a.sent.length = 0;
        b.sent.length = 0;

        await shard.fetch(write("messages:send", { _id: "m1", channelId: "c1" }));

        // Only the c1 subscriber is poked.
        expect(pokeOps(a)).toStrictEqual([{ key: "m1", op: "insert", table: "messages", value: expect.objectContaining({ _id: "m1" }) }]);
        expect(b.sent).toStrictEqual([]);
    });

    it("shares one op-log drain across same-range shape diffs in a flush (op-range cache)", async () => {
        expect.assertions(3);

        // Run the SAME single write against a shard holding `socketCount` shapes
        // on the identical (table, range), counting only the page reads the write
        // flush performs.
        const measure = async (socketCount: number): Promise<{ reads: number; sockets: FakeWebSocket[] }> => {
            harness = createSqliteExec();
            runShardMigrations(harness.sql, messagesSchema, { cdc: true });

            const sockets: FakeWebSocket[] = [];
            const shard = new CountingShapePokeShard(makeState(sockets), {});

            // Every socket subscribes to the SAME shape (c1) before any write, so
            // each shape memo records the same seed cursor → an identical diff
            // range `(memoCursor, checkpoint]` for all of them on the write flush.
            for (let index = 0; index < socketCount; index += 1) {
                const ws = createFakeWebSocket();

                sockets.push(ws);
                // eslint-disable-next-line no-await-in-loop -- sequential subscribe keeps seed cursors identical
                await subscribeShape(shard, ws, "c1");
            }

            shard.cdcPageReads = 0;
            await shard.fetch(write("messages:send", { _id: "m1", channelId: "c1", text: "hi" }));

            return { reads: shard.cdcPageReads, sockets };
        };

        const one = await measure(1);
        const three = await measure(3);

        // A single shape diff drains the op range with at least one page read.
        expect(one.reads).toBeGreaterThan(0);

        // Three sockets on the identical (table, range) share that ONE drain — the
        // flush-local cache collapses the extra two, so the page-read count is
        // unchanged (pre-cache this would have been 3x).
        expect(three.reads).toBe(one.reads);

        // Correctness is intact: every subscriber still received the insert poke.
        expect(three.sockets.every((ws) => pokeOps(ws).some((op) => op.key === "m1" && op.op === "insert"))).toBe(true);
    });

    it("decodes wire-encoded shape args at the shape_subscribe entry point (attachment + resolveShape see real values)", async () => {
        expect.assertions(4);

        const sockets: FakeWebSocket[] = [];
        let seenArgs: Record<string, unknown> | undefined;

        class CapturingShard extends ShapePokeShard {
            protected override resolveShape(
                name: string,
                args: Record<string, unknown>,
            ): { effectiveWhere?: Record<string, unknown>; table: string } | undefined {
                seenArgs = args;

                return super.resolveShape(name, args);
            }
        }

        const shard = new CapturingShard(makeState(sockets), {});
        const ws = createFakeWebSocket();

        sockets.push(ws);

        await shard.fetch(write("messages:send", { _id: "m1", channelId: "c1" }));
        ws.sent.length = 0;

        // The frame carries the client's wire-encoded args (raw JSON would drop the bigint).
        await shard.webSocketMessage(
            ws as unknown as WebSocket,
            JSON.stringify({
                id: "s1",
                shape: { args: encodeWire({ channelId: "c1", since: 123n }), name: "messagesByChannel" },
                type: "shape_subscribe",
            }),
        );

        // Resolution ran under the DECODED args, not the tagged arrays.
        expect(seenArgs).toStrictEqual({ channelId: "c1", since: 123n });
        // The attachment stores decoded args, so hibernation and every later
        // `resolveShape` (poke diffs, relay probes) see real values.
        expect(ws.attachment?.shapes?.["s1"]?.args).toStrictEqual({ channelId: "c1", since: 123n });
        expect(frameTypes(ws)).toContain("ack");
        expect(pokeOps(ws)).toHaveLength(1);
    });

    it("answers a malformed tagged shape payload with a structured error instead of throwing", async () => {
        expect.assertions(2);

        const sockets: FakeWebSocket[] = [];
        const shard = new ShapePokeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();

        sockets.push(ws);

        await shard.webSocketMessage(
            ws as unknown as WebSocket,
            JSON.stringify({
                id: "s1",
                shape: { args: { since: ["$lunora.wire$", "bigint", "9".repeat(2000)] }, name: "messagesByChannel" },
                type: "shape_subscribe",
            }),
        );

        expect(JSON.parse(ws.sent[0]!)).toMatchObject({ code: "BAD_SUBSCRIPTION_ARGS", id: "s1", type: "error" });
        expect(ws.attachment?.shapes?.["s1"]).toBeUndefined();
    });
});

/**
 * The durable `__shape_poke_cursor` table (plan 326): `shapeMemos` is an
 * in-memory `WeakMap` that a hibernation eviction clears, so without a
 * durable backing the first write after every wake fell back to a literal
 * `0` and re-scanned the shard's ENTIRE retained `__cdc_log` for that table.
 * These tests exercise the fallback chain `readShapeMemoCursor` now applies
 * on a cold memo: stored cursor → attachment `sinceSeq` → `0` — and the
 * write-through + cleanup that keep it correct.
 */
describe("shardDO shape poke: durable poke-cursor survival (plan 326)", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, messagesSchema, { cdc: true });
    });

    it("resumes a cold-memo poke from the stored cursor after a hibernation wake, not from 0", async () => {
        expect.assertions(2);

        const sockets: FakeWebSocket[] = [];
        const shard = new CountingShapePokeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();

        // A connection id (minted at upgrade in production) keys the durable
        // cursor row; without it the memo stays in-memory only.
        ws.attachment = { connectionId: "conn-1", subs: {} };
        sockets.push(ws);

        await subscribeShape(shard, ws, "c1");
        await shard.fetch(write("messages:send", { _id: "m1", channelId: "c1", text: "one" }));

        const storedCursor = readShapePokeCursor(harness.sql, "conn-1", "s1");

        expect(storedCursor).toBeDefined();

        // Simulate a hibernation wake: a brand-new `ShardDO` instance over the
        // SAME SQLite storage + the same (serialized) socket. Its in-memory
        // `shapeMemos` WeakMap starts empty — only the durable table and the
        // socket's attachment carry state across the wake.
        const woken = new CountingShapePokeShard(makeState([ws]), {});

        await woken.fetch(write("messages:send", { _id: "m2", channelId: "c1", text: "two" }));

        // The cold-memo poke drained the op range from the STORED cursor, not
        // a bare 0 (which would re-scan the whole retained log).
        expect(woken.sinceSeqSeen[0]).toBe(storedCursor);
    });

    it("falls back to the attachment's subscribe-time sinceSeq when no durable row is stored", async () => {
        expect.assertions(1);

        const sockets: FakeWebSocket[] = [];
        const shard = new CountingShapePokeShard(makeState(sockets), {});

        // Prior history the client already claims to have seen, up to this
        // checkpoint.
        await shard.fetch(write("messages:send", { _id: "seen", channelId: "c1", text: "seen" }));
        const seenCursor = readCdcCursor(harness.sql);

        const ws = createFakeWebSocket();

        // A socket whose attachment carries a shape resume checkpoint but for
        // which no memo was ever recorded on THIS instance (no shapeMemos
        // entry, no durable row for conn-2/s1) — e.g. a durable write that
        // silently failed at subscribe time.
        ws.attachment = {
            connectionId: "conn-2",
            shapes: { s1: { args: { channelId: "c1" }, name: "messagesByChannel", sinceSeq: seenCursor } },
            subs: {},
        };
        sockets.push(ws);

        await shard.fetch(write("messages:send", { _id: "new", channelId: "c1", text: "new" }));

        expect(shard.sinceSeqSeen[0]).toBe(seenCursor);
    });

    it("falls back to 0 when neither a durable cursor nor an attachment sinceSeq exists, and still returns a correct diff", async () => {
        expect.assertions(2);

        const sockets: FakeWebSocket[] = [];
        const shard = new CountingShapePokeShard(makeState(sockets), {});

        await shard.fetch(write("messages:send", { _id: "before", channelId: "c1", text: "before" }));

        const ws = createFakeWebSocket();

        // No sinceSeq on the shape descriptor at all.
        ws.attachment = { connectionId: "conn-3", shapes: { s1: { args: { channelId: "c1" }, name: "messagesByChannel" } }, subs: {} };
        sockets.push(ws);

        await shard.fetch(write("messages:send", { _id: "after", channelId: "c1", text: "after" }));

        expect(shard.sinceSeqSeen[0]).toBe(0);
        // Superset-correct: the poke still surfaces the row it cares about.
        // Missing a row would be the unsafe direction (§3.1); re-scanning
        // extra history is merely wasteful, never wrong.
        expect(pokeOps(ws).some((op) => op.key === "after" && op.op === "insert")).toBe(true);
    });

    it("never stores a poke cursor ahead of the shard's actual CDC watermark", async () => {
        expect.assertions(1);

        const sockets: FakeWebSocket[] = [];
        const shard = new ShapePokeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();

        ws.attachment = { connectionId: "conn-4", subs: {} };
        sockets.push(ws);

        await subscribeShape(shard, ws, "c1");

        for (let index = 0; index < 5; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential writes so each poke's memo advance is observable before the next
            await shard.fetch(write("messages:send", { _id: `m${String(index)}`, channelId: "c1", text: `t${String(index)}` }));
        }

        const stored = readShapePokeCursor(harness.sql, "conn-4", "s1");
        const trueWatermark = readCdcCursor(harness.sql);

        // §3.1 / §8: a baseline ahead of the watermark would silently skip
        // rows on the next diff — the write path must never produce one.
        expect(stored).toBeLessThanOrEqual(trueWatermark);
    });

    it("removes the durable cursor on shape_unsubscribe, leaving a sibling subscription's row intact", async () => {
        expect.assertions(2);

        const sockets: FakeWebSocket[] = [];
        const shard = new ShapePokeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();

        ws.attachment = { connectionId: "conn-5", subs: {} };
        sockets.push(ws);

        await subscribeShape(shard, ws, "c1");
        await shard.webSocketMessage(
            ws as unknown as WebSocket,
            JSON.stringify({ id: "s2", shape: { args: { channelId: "c2" }, name: "messagesByChannel" }, type: "shape_subscribe" }),
        );

        await shard.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ id: "s1", type: "shape_unsubscribe" }));

        expect(readShapePokeCursor(harness.sql, "conn-5", "s1")).toBeUndefined();
        expect(readShapePokeCursor(harness.sql, "conn-5", "s2")).toBeDefined();
    });

    it("removes every durable cursor for a socket on webSocketClose, leaving another connection's rows intact", async () => {
        expect.assertions(3);

        const sockets: FakeWebSocket[] = [];
        const shard = new ShapePokeShard(makeState(sockets), {});
        const wsA = createFakeWebSocket();
        const wsB = createFakeWebSocket();

        wsA.attachment = { connectionId: "conn-6", subs: {} };
        wsB.attachment = { connectionId: "conn-7", subs: {} };
        sockets.push(wsA, wsB);

        await subscribeShape(shard, wsA, "c1");
        await shard.webSocketMessage(
            wsA as unknown as WebSocket,
            JSON.stringify({ id: "s2", shape: { args: { channelId: "c2" }, name: "messagesByChannel" }, type: "shape_subscribe" }),
        );
        await subscribeShape(shard, wsB, "c1");

        await shard.webSocketClose(wsA as unknown as WebSocket, 1000, "", true);

        expect(readShapePokeCursor(harness.sql, "conn-6", "s1")).toBeUndefined();
        expect(readShapePokeCursor(harness.sql, "conn-6", "s2")).toBeUndefined();
        // Untouched: a different socket's connection.
        expect(readShapePokeCursor(harness.sql, "conn-7", "s1")).toBeDefined();
    });
});
