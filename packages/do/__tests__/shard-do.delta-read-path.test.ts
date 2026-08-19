import type { DatabaseWriterLike, ShapeProbeCounters, SocketAttachment } from "@lunora/shard-engine";
import {
    CDC_LOG_TABLE_SEQ_INDEX,
    createShardCtxDb as createShardContextDatabase,
    minCdcDocSeq,
    minCdcSeq,
    readCdcChangeKeys,
    readCdcCursor,
    runShardMigrations,
} from "@lunora/shard-engine";
import { beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The delta-sync read path: the changed-key scan the shape diff runs on, the
 * membership probe it shares across sockets, and the retention sweep that keeps
 * the changelog from growing for the lifetime of the shard.
 *
 * Every assertion here is about COST or about what survives a sweep — the row-op
 * semantics themselves are covered by `shard-do.shape-poke.test.ts`, and this
 * suite deliberately does not restate them.
 */

interface FakeWebSocket {
    attachment: SocketAttachment | undefined;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

const createFakeWebSocket = (connectionId = "conn-1"): FakeWebSocket => {
    return {
        // A `connectionId` is what makes a shape's poke cursor DURABLE — without
        // one the memo stays in memory only, and the retention floor (which reads
        // those rows) would see no subscribers at all.
        attachment: { connectionId, subs: {} },
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
 * A shard with one `channelId`-scoped shape that counts the membership probes it
 * actually issues, so a test can tell "N sockets shared one query" from "N
 * sockets each ran their own".
 */
class ProbeCountingShard extends ShardDO {
    private writer: DatabaseWriterLike | undefined;

    /** The running membership-probe tallies `getFanoutMetrics` reports — `run` reached SQLite, `served` came from the per-flush cache. */
    public probeMetrics(): ShapeProbeCounters {
        return this.shapeProbe;
    }

    public override async handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        const writer = this.getWriter();

        if (functionPath === "messages:send") {
            await writer.insert(
                "messages",
                { _id: args["_id"], authorId: "u1", channelId: args["channelId"], text: args["text"] ?? args["_id"] },
                { allowExplicitId: true },
            );
        }

        this.recordChangedTable("messages");

        return { ok: true };
    }

    /** Write straight through the ctx-db writer, outside the dispatch path (no flush, no poke). */
    public async seed(id: string, channelId: string): Promise<void> {
        await this.getWriter().insert("messages", { _id: id, authorId: "u1", channelId, text: id }, { allowExplicitId: true });
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

const subscribeShape = async (shard: ShardDO, ws: FakeWebSocket, channelId: string): Promise<void> => {
    await shard.webSocketMessage(
        ws as unknown as WebSocket,
        JSON.stringify({ id: "s1", shape: { args: { channelId }, name: "messagesByChannel" }, type: "shape_subscribe" }),
    );
};

/** Every row-op across the socket's `pokePart` frames. */
const pokeOps = (ws: FakeWebSocket): { key: string; op: string; value?: Record<string, unknown> }[] =>
    ws.sent
        .map((raw) => JSON.parse(raw) as { rowsPatch?: { key: string; op: string; value?: Record<string, unknown> }[]; type: string })
        .filter((frame) => frame.type === "pokePart")
        .flatMap((frame) => frame.rowsPatch ?? []);

describe("delta-sync read path", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, messagesSchema, { cdc: true });
    });

    describe("changed-key scan", () => {
        it("plans the table-filtered changelog read through the (table, seq) index", () => {
            expect.assertions(2);

            const plan = harness.sql
                .exec(
                    `EXPLAIN QUERY PLAN SELECT id, op, MAX(seq) AS seq FROM __cdc_log WHERE "table" = ? AND seq > ? AND seq <= ? GROUP BY id`,
                    "messages",
                    0,
                    99,
                )
                .toArray()
                .map((row) => (row as { detail?: string }).detail ?? "")
                .join(" ");

            // Without the index this is a scan in commit order that reads and
            // discards every other table's rows — the cost that grows with the
            // BUSIEST table rather than with the one being watched.
            expect(plan).toContain(CDC_LOG_TABLE_SEQ_INDEX);
            expect(plan).not.toContain("SCAN __cdc_log");
        });

        it("collapses repeated ops on one row to its latest, bounded by the upper seq", async () => {
            expect.assertions(3);

            const writer = createShardContextDatabase({
                broadcast: () => undefined,
                cdc: true,
                clock: () => 1_700_000_000_000,
                schema: messagesSchema,
                sql: harness.sql,
            });

            await writer.insert("messages", { _id: "m1", authorId: "u1", channelId: "c1", text: "a" }, { allowExplicitId: true });
            await writer.patch("m1", { text: "b" });
            const midpoint = readCdcCursor(harness.sql);

            await writer.patch("m1", { text: "c" });

            // Three ops on one row collapse to one key…
            const keys = readCdcChangeKeys(harness.sql, "messages", 0, readCdcCursor(harness.sql));

            expect(keys).toStrictEqual([{ id: "m1", op: "update", seq: readCdcCursor(harness.sql) }]);

            // …at the LATEST op within the range, and the range's upper bound is
            // honoured, so a diff can never pull in a change past the checkpoint
            // its poke will be stamped with.
            expect(readCdcChangeKeys(harness.sql, "messages", 0, midpoint)).toStrictEqual([{ id: "m1", op: "update", seq: midpoint }]);
            expect(readCdcChangeKeys(harness.sql, "messages", midpoint, readCdcCursor(harness.sql))).toHaveLength(1);
        });
    });

    describe("membership probe sharing", () => {
        it("runs ONE probe for many sockets whose shape resolves to the same predicate", async () => {
            expect.assertions(3);

            const sockets: FakeWebSocket[] = [];
            const shard = new ProbeCountingShard(makeState(sockets), {});

            for (let index = 0; index < 5; index += 1) {
                const ws = createFakeWebSocket(`conn-${String(index)}`);

                sockets.push(ws);
                // eslint-disable-next-line no-await-in-loop -- subscriptions are seeded in order so each socket's baseline is deterministic
                await subscribeShape(shard, ws, "c1");
                ws.sent.length = 0;
            }

            await shard.fetch(write("messages:send", { _id: "m1", channelId: "c1" }));

            const metrics = shard.probeMetrics();

            // Five sockets, one query. The probe's inputs are the table, the
            // predicate and the id set — none of which name a socket — so the
            // other four were byte-identical duplicates.
            expect(metrics.run).toBe(1);
            expect(metrics.served).toBe(4);

            // And every socket still got its row: sharing the read must not
            // share it with FEWER recipients.
            expect(sockets.every((ws) => pokeOps(ws).some((op) => op.key === "m1"))).toBe(true);
        });

        it("does not share a probe between sockets whose predicates differ", async () => {
            expect.assertions(2);

            const sockets: FakeWebSocket[] = [];
            const shard = new ProbeCountingShard(makeState(sockets), {});
            const first = createFakeWebSocket("conn-a");
            const second = createFakeWebSocket("conn-b");

            sockets.push(first, second);
            await subscribeShape(shard, first, "c1");
            await subscribeShape(shard, second, "c2");
            first.sent.length = 0;
            second.sent.length = 0;

            await shard.fetch(write("messages:send", { _id: "m1", channelId: "c1" }));

            const metrics = shard.probeMetrics();

            // Two distinct predicates ⇒ two distinct questions ⇒ two queries.
            expect(metrics.run).toBe(2);
            expect(metrics.served).toBe(0);
        });
    });

    describe("retention sweep", () => {
        /** The lowest durable shape-poke cursor — the floor a sweep may never cross. */
        const readShapeCursor = (): number => {
            const rows = harness.sql.exec(`SELECT MIN(cursor) AS cursor FROM __shape_poke_cursor`).toArray();

            return Number((rows[0] as { cursor?: unknown } | undefined)?.cursor ?? 0);
        };

        const sweepWith = async (environment: Record<string, string>, rows: number): Promise<ProbeCountingShard> => {
            const sockets: FakeWebSocket[] = [];
            const shard = new ProbeCountingShard(makeState(sockets), environment);

            for (let index = 0; index < rows; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential writes build the changelog range the sweep acts on
                await shard.seed(`m${String(index)}`, "c1");
            }

            // One dispatched write drives a flush, and the flush ends in the sweep.
            await shard.fetch(write("messages:send", { _id: "trigger", channelId: "c1" }));

            return shard;
        };

        it("leaves the log untouched when neither knob is configured", async () => {
            expect.assertions(2);

            await sweepWith({}, 20);

            // The pre-existing behaviour, preserved deliberately: the log's
            // out-of-shard consumers (a warehouse connector's opaque cursor) are
            // invisible from here, so retention is something a deployment opts
            // into rather than something inferred.
            expect(minCdcSeq(harness.sql)).toBe(1);
            expect(minCdcDocSeq(harness.sql)).toBe(1);
        });

        it("compacts payloads while keeping every key resumable", async () => {
            expect.assertions(3);

            await sweepWith({ LUNORA_CDC_PAYLOAD_RETENTION: "5" }, 20);

            // The keys all survive — which is the point. A client below the
            // payload floor can still be told exactly WHICH rows moved, and reads
            // their values from the table, instead of re-downloading the shape.
            expect(minCdcSeq(harness.sql)).toBe(1);

            const docFloor = minCdcDocSeq(harness.sql);

            expect(docFloor).toBeGreaterThan(1);
            expect(readCdcChangeKeys(harness.sql, "messages", 0, readCdcCursor(harness.sql)).length).toBeGreaterThan(5);
        });

        it("deletes rows past the configured window", async () => {
            expect.assertions(1);

            await sweepWith({ LUNORA_CDC_LOG_RETENTION: "5" }, 20);

            expect(minCdcSeq(harness.sql)).toBeGreaterThan(1);
        });

        it("never sweeps past a live shape subscription's durable cursor", async () => {
            expect.assertions(2);

            const sockets: FakeWebSocket[] = [];
            const shard = new ProbeCountingShard(makeState(sockets), { LUNORA_CDC_LOG_RETENTION: "1" });
            const ws = createFakeWebSocket();

            sockets.push(ws);

            // Subscribe FIRST, so the socket's durable poke cursor sits near the
            // bottom of the log, then write a long range past it.
            await subscribeShape(shard, ws, "c1");

            for (let index = 0; index < 20; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- the writes must not flush between each other's cursors
                await shard.seed(`m${String(index)}`, "c1");
            }

            await shard.fetch(write("messages:send", { _id: "trigger", channelId: "c1" }));

            const floor = readShapeCursor();

            // A retention of 1 row would otherwise have deleted essentially the
            // whole log. The floor wins, because trimming past a live
            // subscription silently drops rows it was owed.
            expect(floor).toBeGreaterThan(0);
            expect(minCdcSeq(harness.sql) ?? 0).toBeLessThanOrEqual(floor + 1);
        });
    });
});
