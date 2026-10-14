import type { CdcChangeKey, DatabaseWriterLike, SocketAttachment, SqlExec } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, readCdcCursor, readShapePokeCursor, runShardMigrations } from "@lunora/shard-engine";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
            // A write to a table no shape in this suite watches, so the flush it
            // triggers carries `changed = {roomMembers}` and still advances the CDC
            // cursor — the "unrelated table" half of the empty-advance path.
            case "rooms:join": {
                await writer.insert("roomMembers", { _id: args["_id"], roomId: args["roomId"] ?? "r1", userId: "u1" }, { allowExplicitId: true });
                this.recordChangedTable("roomMembers");

                return { ok: true };
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
 * {@link ShapePokeShard} that counts every `__cdc_log` read backing a shape
 * diff, so a test can prove the flush-local diff cache collapses N same-range
 * shape diffs to ONE changed-key scan.
 */
class CountingShapePokeShard extends ShapePokeShard {
    public cdcPageReads = 0;

    /** Every `sinceSeq` a shape diff was scanned from, in call order — lets a test pin exactly which baseline a poke resumed from. */
    public sinceSeqSeen: number[] = [];

    protected override readShapeCdcKeys(sql: SqlExec, table: string, sinceSeq: number, upTo: number): CdcChangeKey[] {
        this.cdcPageReads += 1;
        this.sinceSeqSeen.push(sinceSeq);

        return super.readShapeCdcKeys(sql, table, sinceSeq, upTo);
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

/** The `baseCheckpoint` on every `pokePart` the socket received, in order. */
const partBases = (ws: FakeWebSocket): (number | undefined)[] =>
    ws.sent
        .map((raw) => JSON.parse(raw) as { baseCheckpoint?: number; type: string })
        .filter((frame) => frame.type === "pokePart")
        .map((frame) => frame.baseCheckpoint);

/** The `checkpoint` on every `pokeEnd` the socket received, in order. */
const endCheckpoints = (ws: FakeWebSocket): (number | undefined)[] =>
    ws.sent
        .map((raw) => JSON.parse(raw) as { checkpoint?: number; type: string })
        .filter((frame) => frame.type === "pokeEnd")
        .map((frame) => frame.checkpoint);

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

    /**
     * Defect #6 — the live poke path shipped `baseCheckpoint: undefined`, so the
     * client's gap detector was dead code on the ONE path where a gap actually
     * happens. It has to be the cursor the client is really at, which is the last
     * poke that CARRIED ROWS for this shape — not the shape's memo cursor, which
     * also advances on an empty diff and would read as a gap the client never had.
     */
    it("stamps each live poke part with the checkpoint of the last poke that carried rows", async () => {
        expect.assertions(3);

        const sockets: FakeWebSocket[] = [];
        const shard = new ShapePokeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        sockets.push(ws);

        await subscribeShape(shard, ws, "c1");

        // First live poke: its base is the seed's checkpoint.
        await shard.fetch(write("messages:send", { _id: "m1", channelId: "c1", text: "one" }));

        const seedCheckpoint = endCheckpoints(ws)[0];

        expect(partBases(ws)[1]).toBe(seedCheckpoint);

        const afterFirst = endCheckpoints(ws)[1];

        // An out-of-channel write: the shape is diffed, the diff is empty, so no
        // part is delivered and the client's cursor does NOT move — but the memo
        // does. Stamping the memo would fire a spurious gap on the next real poke.
        await shard.fetch(write("messages:send", { _id: "other", channelId: "c2", text: "two" }));

        expect(frameTypes(ws).filter((type) => type === "pokePart")).toHaveLength(2);

        await shard.fetch(write("messages:send", { _id: "m2", channelId: "c1", text: "three" }));

        expect(partBases(ws)[2]).toBe(afterFirst);
    });

    /**
     * A failed poke has to survive the next flush on an UNRELATED table.
     *
     * The shape's memo is deliberately left where it was when a send fails, so the
     * rows are re-emitted. But the next flush that does not touch the shape's table
     * used to force-advance that memo's `cursor` straight past the undelivered
     * range while `delivered` stayed behind — so the rows were never diffed again,
     * and the poke after that stamped `baseCheckpoint = delivered`, exactly where
     * the client already was. The client's own gap check therefore PASSED and it
     * spliced newer rows onto a permanently incomplete view.
     *
     * Both flushes are required to see it: a suite that only fails one send watches
     * the (correct) re-emit on the next write to the same table and never reaches
     * the force-advance.
     */
    it("re-delivers rows a failed poke owes even when the next flush changes another table", async () => {
        expect.assertions(4);

        const sockets: FakeWebSocket[] = [];
        const shard = new ShapePokeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        sockets.push(ws);

        await subscribeShape(shard, ws, "c1");
        ws.sent.length = 0;

        // Flush A — the shape's own table changes, but the poke never lands. The
        // realistic trigger is an oversized `pokePart` frame on an otherwise
        // healthy socket: `pokeStart` is already on the wire when the part throws.
        const healthy = ws.send.bind(ws);

        ws.send = (data: string): void => {
            if ((JSON.parse(data) as { type: string }).type === "pokePart") {
                throw new Error("frame too large");
            }

            healthy(data);
        };

        await shard.fetch(write("messages:send", { _id: "m1", channelId: "c1", text: "owed" }));

        expect(pokeOps(ws)).toStrictEqual([]);

        ws.send = healthy;
        ws.sent.length = 0;

        // Flush B — an unrelated table. The shape is absent from `changed`, which
        // is the force-advance the client can never recover from.
        await shard.fetch(write("rooms:join", { _id: "rm1", roomId: "r1" }));

        expect(pokeOps(ws)).toStrictEqual([{ key: "m1", op: "insert", table: "messages", value: expect.objectContaining({ _id: "m1", text: "owed" }) }]);

        // …and the shape is settled again afterwards: the next in-channel write
        // carries only its own row, stamped against the checkpoint the re-delivery
        // above actually reached.
        const redeliveredAt = endCheckpoints(ws).at(-1);

        ws.sent.length = 0;

        await shard.fetch(write("messages:send", { _id: "m2", channelId: "c1", text: "after" }));

        expect(pokeOps(ws)).toStrictEqual([{ key: "m2", op: "insert", table: "messages", value: expect.objectContaining({ _id: "m2", text: "after" }) }]);
        expect(partBases(ws)[0]).toBe(redeliveredAt);
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

    it("clamps an attachment sinceSeq above the current watermark down to 0 instead of trusting it (PITR rollback guard)", async () => {
        expect.assertions(2);

        const sockets: FakeWebSocket[] = [];
        const shard = new CountingShapePokeShard(makeState(sockets), {});

        // Establish a real watermark below the inflated sinceSeq the socket
        // below will claim.
        await shard.fetch(write("messages:send", { _id: "seed", channelId: "c1", text: "seed" }));
        const cursor = readCdcCursor(harness.sql);

        const ws = createFakeWebSocket();

        // No durable row for this connection (fresh conn id, so `stored` is
        // undefined), and an attachment `sinceSeq` claiming to have seen MORE
        // than the shard's current watermark — the same rollback scenario
        // `evaluateResume`'s guard names (e.g. a PITR restore), or a durable
        // write that silently failed at subscribe time after the client had
        // already cached a higher value.
        ws.attachment = {
            connectionId: "conn-rollback",
            shapes: { s1: { args: { channelId: "c1" }, name: "messagesByChannel", sinceSeq: cursor + 1000 } },
            subs: {},
        };
        sockets.push(ws);

        await shard.fetch(write("messages:send", { _id: "after-rollback", channelId: "c1", text: "after" }));

        // The inflated sinceSeq must not be trusted as a diff baseline — a
        // baseline above the watermark would make `buildShapeDiff` scan an
        // empty range and silently drop this row for the subscriber.
        expect(shard.sinceSeqSeen[0]).toBe(0);
        expect(pokeOps(ws).some((op) => op.key === "after-rollback" && op.op === "insert")).toBe(true);
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

    it("removes every durable cursor for a socket on webSocketError, which workerd dispatches INSTEAD of webSocketClose", async () => {
        expect.assertions(3);

        // workerd's hibernation manager dispatches exactly one termination event
        // per socket (`legacy-hibernation-manager.c++`,
        // `handleSocketTermination`): a premature `DISCONNECTED` becomes a
        // synthetic 1006 close, and every OTHER exception — a protocol error, an
        // event timeout, a `webSocketMessage` handler that threw — becomes an
        // error event with no close to follow. An empty `webSocketError` stub
        // therefore orphans this socket's `__shape_poke_cursor` rows under a
        // `connectionId` that can never reconnect, and `minShapePokeCursor` is a
        // `SELECT MIN(cursor)` over the whole table, so ONE orphan pins CDC
        // retention permanently.
        const sockets: FakeWebSocket[] = [];
        const shard = new ShapePokeShard(makeState(sockets), {});
        const wsA = createFakeWebSocket();
        const wsB = createFakeWebSocket();

        wsA.attachment = { connectionId: "conn-err-1", subs: {} };
        wsB.attachment = { connectionId: "conn-err-2", subs: {} };
        sockets.push(wsA, wsB);

        await subscribeShape(shard, wsA, "c1");
        await shard.webSocketMessage(
            wsA as unknown as WebSocket,
            JSON.stringify({ id: "s2", shape: { args: { channelId: "c2" }, name: "messagesByChannel" }, type: "shape_subscribe" }),
        );
        await subscribeShape(shard, wsB, "c1");

        await shard.webSocketError(wsA as unknown as WebSocket, new Error("connection reset"));

        expect(readShapePokeCursor(harness.sql, "conn-err-1", "s1")).toBeUndefined();
        expect(readShapePokeCursor(harness.sql, "conn-err-1", "s2")).toBeUndefined();
        // Untouched: a different socket's connection.
        expect(readShapePokeCursor(harness.sql, "conn-err-2", "s1")).toBeDefined();
    });

    it("still purges durable cursors and clears the attachment when lifecycle dispatch throws", async () => {
        expect.assertions(3);

        // The dispatch *machinery* throwing (not a hook — hooks are swallowed
        // per-hook inside `dispatchLifecycle`) must not skip the deterministic
        // teardown: durable cursor purge + attachment clear live in a `finally`.
        class ThrowingDispatchShard extends ShapePokeShard {
            // eslint-disable-next-line class-methods-use-this -- test override: fail the dispatch machinery unconditionally
            protected override async dispatchLifecycle(): Promise<void> {
                throw new Error("dispatch machinery failed");
            }
        }

        const sockets: FakeWebSocket[] = [];
        const shard = new ThrowingDispatchShard(makeState(sockets), {});
        const ws = createFakeWebSocket();

        ws.attachment = { connectionId: "conn-8", subs: {} };
        sockets.push(ws);

        await subscribeShape(shard, ws, "c1");

        // The dispatch failure still surfaces to the runtime…
        await expect(shard.webSocketClose(ws as unknown as WebSocket, 1000, "", true)).rejects.toThrow("dispatch machinery failed");

        // …but the durable row is gone and the attachment is cleared anyway.
        expect(readShapePokeCursor(harness.sql, "conn-8", "s1")).toBeUndefined();
        expect(ws.attachment).toBeUndefined();
    });

    it("keeps the dispatch failure as the thrown error when the relay drain also fails", async () => {
        expect.assertions(2);

        // `announceDrain` is a network post, so it can reject. Running it in the
        // teardown `finally` must not let it displace the dispatch error the
        // caller still has to see.
        class ThrowingDispatchShard extends ShapePokeShard {
            // eslint-disable-next-line class-methods-use-this -- test override: fail the dispatch machinery unconditionally
            protected override async dispatchLifecycle(): Promise<void> {
                throw new Error("dispatch machinery failed");
            }
        }

        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const sockets: FakeWebSocket[] = [];
        const shard = new ThrowingDispatchShard(makeState(sockets), {});
        const ws = createFakeWebSocket();

        ws.attachment = { connectionId: "conn-9", subs: {} };
        sockets.push(ws);

        await subscribeShape(shard, ws, "c1");
        // Install a relay whose drain rejects. The unit harness has no relay
        // (`announceDrain` is skipped), and close touches no other relay method
        // — but a subscribe does, so this lands after the subscribe above.
        (shard as unknown as { relay: { announceDrain: () => Promise<void>; releaseRelayShapes: () => Promise<void> } }).relay = {
            announceDrain: () => Promise.reject(new Error("relay detach failed")),
            // The close path also releases this socket's relayed shape
            // registrations; a relay double that omits it fails on the wrong
            // call and hides the drain failure this test is about.
            releaseRelayShapes: () => Promise.resolve(),
        };

        await expect(shard.webSocketClose(ws as unknown as WebSocket, 1000, "", true)).rejects.toThrow("dispatch machinery failed");
        // The relay failure is reported, not swallowed silently.
        expect(consoleError).toHaveBeenCalledWith("[@lunora/do] relay drain failed during socket close:", expect.any(Error));

        consoleError.mockRestore();
    });

    it("logs a relay drain failure rather than failing the close handler", async () => {
        expect.assertions(3);

        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const sockets: FakeWebSocket[] = [];
        const shard = new ShapePokeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();

        ws.attachment = { connectionId: "conn-10", subs: {} };
        sockets.push(ws);

        await subscribeShape(shard, ws, "c1");
        // Install a relay whose drain rejects. The unit harness has no relay
        // (`announceDrain` is skipped), and close touches no other relay method
        // — but a subscribe does, so this lands after the subscribe above.
        (shard as unknown as { relay: { announceDrain: () => Promise<void>; releaseRelayShapes: () => Promise<void> } }).relay = {
            announceDrain: () => Promise.reject(new Error("relay detach failed")),
            // The close path also releases this socket's relayed shape
            // registrations; a relay double that omits it fails on the wrong
            // call and hides the drain failure this test is about.
            releaseRelayShapes: () => Promise.resolve(),
        };

        // The detach is a fire-and-forget control frame — a dropped one falls
        // back to the coarser reclamation. Rejecting out of `webSocketClose`
        // would instead fail a Durable Object close event, which the runtime can
        // only answer by breaking the actor and every OTHER socket on this
        // shard. So it resolves and the failure is logged…
        await expect(shard.webSocketClose(ws as unknown as WebSocket, 1000, "", true)).resolves.toBeUndefined();
        expect(consoleError).toHaveBeenCalledWith("[@lunora/do] relay drain failed during socket close:", expect.any(Error));
        // …and the teardown ahead of it still ran.
        expect(readShapePokeCursor(harness.sql, "conn-10", "s1")).toBeUndefined();

        consoleError.mockRestore();
    });

    it("logs a relayed-shape release failure rather than failing the close handler", async () => {
        expect.assertions(3);

        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const sockets: FakeWebSocket[] = [];
        const shard = new ShapePokeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();

        ws.attachment = { connectionId: "conn-11", subs: {} };
        sockets.push(ws);

        await subscribeShape(shard, ws, "c1");
        // Same contract as the drain above: the release is a best-effort
        // cross-DO post whose loss is reclaimed on detach/full drain. It must
        // not be able to fail the close handler either.
        (shard as unknown as { relay: { announceDrain: () => Promise<void>; releaseRelayShapes: () => Promise<void> } }).relay = {
            announceDrain: () => Promise.resolve(),
            releaseRelayShapes: () => Promise.reject(new Error("relay shape release failed")),
        };

        await expect(shard.webSocketClose(ws as unknown as WebSocket, 1000, "", true)).resolves.toBeUndefined();
        expect(consoleError).toHaveBeenCalledWith("[@lunora/do] relay shape release failed during socket close:", expect.any(Error));
        expect(ws.attachment).toBeUndefined();

        consoleError.mockRestore();
    });
});
