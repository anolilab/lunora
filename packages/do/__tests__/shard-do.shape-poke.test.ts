import type { CdcChange, DatabaseWriterLike, SocketAttachment, SqlExec } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/shard-engine";
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

    protected override readShapeCdcPage(sql: SqlExec, sinceSeq: number, tables: ReadonlySet<string>): { changes: CdcChange[]; cursor: number } {
        this.cdcPageReads += 1;

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
