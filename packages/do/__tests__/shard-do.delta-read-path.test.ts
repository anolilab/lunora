import type { CdcChange, DatabaseWriterLike, ShapeProbeCounters, SocketAttachment } from "@lunora/shard-engine";
import {
    CDC_LOG_TABLE_SEQ_INDEX,
    compactCdcDocs,
    createShardCtxDb as createShardContextDatabase,
    minCdcReplayableSeq,
    minCdcSeq,
    readCdcChangeKeys,
    readCdcCursor,
    runShardMigrations,
} from "@lunora/shard-engine";
import { beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import { createFakeR2Bucket } from "./_helpers/fake-r2";
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

    /** The same, on the second (quiet) table — so a test can drive one table's head past another's subscribers. */
    public async seedRoom(id: string, roomId: string): Promise<void> {
        await this.getWriter().insert("roomMembers", { _id: id, roomId, userId: "u1" }, { allowExplicitId: true });
    }

    /** The changelog page a streaming-export / read-replica consumer pulls, exposed so a test can assert what it refuses. */
    public syncCdc(sinceSeq: number): { changes: CdcChange[]; cursor: number } {
        return this.runShardCdcSync({ sinceSeq });
    }

    /** The same page as {@link ProbeCountingShard.syncCdc}, but through the admin dispatch's archive-backed path. */
    public syncCdcArchived(sinceSeq: number): Promise<{ changes: CdcChange[]; cursor: number }> {
        return this.cdcSyncPage({ sinceSeq });
    }

    /** Hard-delete through the ctx-db writer, so the changelog records a `delete` (post-image NULL by design). */
    public async wipe(id: string): Promise<void> {
        await this.getWriter().delete(id, undefined, { hard: true });
    }

    // eslint-disable-next-line class-methods-use-this -- test stub override: resolves by `name`/`args` alone, no instance state.
    protected override resolveShape(name: string, args: Record<string, unknown>): { effectiveWhere?: Record<string, unknown>; table: string } | undefined {
        if (name === "roomMembersByRoom") {
            return { effectiveWhere: { roomId: args["roomId"] }, table: "roomMembers" };
        }

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

const makeState = (sockets: FakeWebSocket[], name?: string): ShardDOState => {
    return {
        acceptWebSocket(ws: unknown) {
            sockets.push(ws as FakeWebSocket);
        },
        getWebSockets() {
            return sockets as unknown as WebSocket[];
        },
        // A name is what gives the DO a relay role at all — `createRelayLink`
        // returns `undefined` for an unnamed one, so a test asserting anything
        // about the relay tier has to supply it.
        ...(name === undefined ? {} : { id: { name } }),
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

            // Five sockets, two queries: one changed-key scan and one membership
            // probe. Neither read's inputs name a socket — the scan is
            // `(table, range)`, the probe is `(predicate, that same range)` — so
            // the other eight reads the per-socket loop would have issued were
            // byte-identical duplicates.
            //
            // Both halves are counted, deliberately. Counting only the probe
            // reported a sharing rate over half the work and made the scan's
            // collapse invisible.
            expect(metrics.run).toBe(2);
            expect(metrics.served).toBe(8);

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

            // Two distinct predicates ⇒ two distinct membership questions ⇒ two
            // probes. The changed-key scan is predicate-independent, so it still
            // runs once and is served to the second socket — which is the point
            // of keying the two halves separately.
            expect(metrics.run).toBe(3);
            expect(metrics.served).toBe(1);
        });
    });

    describe("payload-compaction guard", () => {
        /** A shard sharing the suite's SQLite handle — `runShardCdcSync` only ever touches `__cdc_log`. */
        const buildShard = (): ProbeCountingShard => new ProbeCountingShard(makeState([]), {});

        it("serves a log whose retained prefix opens with deletes", async () => {
            expect.assertions(2);

            const shard = buildShard();

            await shard.seed("m0", "c1");
            await shard.wipe("m0");

            // Trim the insert, exactly as the retention sweep would: the log now
            // starts with a `delete`, whose NULL post-image is correct rather than
            // compacted. Refusing here would break every change-feed consumer and
            // every read replica on a shard that has ever deleted a row near its
            // retention boundary — with nothing having been compacted at all.
            harness.sql.exec(`DELETE FROM __cdc_log WHERE seq = 1`);
            await shard.seed("m1", "c1");

            // Nothing was compacted, so the replay floor is still the oldest
            // retained row — a delete-opened prefix is fully serveable.
            expect(minCdcReplayableSeq(harness.sql)).toBe(2);

            // …and the page is still served, because no row in it LOST a payload.
            expect(shard.syncCdc(1).changes.map((change) => change.op)).toStrictEqual(["delete", "insert"]);
        });

        it("refuses a page carrying a genuinely compacted post-image", async () => {
            expect.assertions(2);

            const shard = buildShard();

            await shard.seed("m0", "c1");
            await shard.seed("m1", "c1");

            compactCdcDocs(harness.sql, 1, 100);

            // The compacted row is an `insert` with no post-image — the one thing
            // a change feed must never be handed silently.
            expect(() => shard.syncCdc(0)).toThrow(/compacted/u);

            // A consumer already past the compacted prefix is unaffected.
            expect(shard.syncCdc(1).changes).toHaveLength(1);
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
            expect(minCdcReplayableSeq(harness.sql)).toBe(1);
        });

        it("compacts payloads while keeping every key resumable", async () => {
            expect.assertions(3);

            await sweepWith({ LUNORA_CDC_PAYLOAD_RETENTION: "5" }, 20);

            // The keys all survive — which is the point. A client below the
            // payload floor can still be told exactly WHICH rows moved, and reads
            // their values from the table, instead of re-downloading the shape.
            expect(minCdcSeq(harness.sql)).toBe(1);

            const docFloor = minCdcReplayableSeq(harness.sql);

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

        it("compacts inside the window it deletes when both knobs are set", async () => {
            expect.assertions(3);

            // The two-tier design's whole point, and the only 2x2 cell the knobs
            // reach that the single-knob tests do not: a log whose tail is gone,
            // whose middle has keys but no payloads, and whose head is intact.
            await sweepWith({ LUNORA_CDC_LOG_RETENTION: "12", LUNORA_CDC_PAYLOAD_RETENTION: "4" }, 20);

            const trimFloor = minCdcSeq(harness.sql) ?? 0;
            const replayFloor = minCdcReplayableSeq(harness.sql) ?? 0;

            // Rows were deleted…
            expect(trimFloor).toBeGreaterThan(1);
            // …and inside what survived, the older payloads were dropped, so the
            // replay floor sits strictly above the key floor.
            expect(replayFloor).toBeGreaterThan(trimFloor);
            // The keys in between are still there: that is what lets a client
            // below the payload floor get an exact delta instead of a re-seed.
            expect(readCdcChangeKeys(harness.sql, "messages", trimFloor - 1, readCdcCursor(harness.sql)).length).toBeGreaterThan(4);
        });

        it("clamps a payload window wider than the row window instead of compacting nothing", async () => {
            expect.assertions(1);

            // Inverted knobs: payloads are asked to be kept LONGER than the rows
            // that carry them, which unclamped is a no-op with no warning (rows
            // leave before they can reach the payload cutoff).
            await sweepWith({ LUNORA_CDC_LOG_RETENTION: "5", LUNORA_CDC_PAYLOAD_RETENTION: "50" }, 20);

            const trimFloor = minCdcSeq(harness.sql) ?? 0;

            // Clamped to the row window, so the surviving rows keep their
            // payloads — the stated intent ("retain payloads generously") is
            // honoured as far as the row window allows.
            expect(minCdcReplayableSeq(harness.sql)).toBe(trimFloor);
        });

        it("treats a malformed retention value as unset rather than reinterpreting it", async () => {
            expect.assertions(2);

            // `Number.parseInt` reads this as 10 and deletes the changelog. The
            // whole-string parse reads it as malformed, i.e. as off — the only
            // safe direction for a knob whose effect is a DELETE.
            await sweepWith({ LUNORA_CDC_LOG_RETENTION: "10k" }, 20);

            expect(minCdcSeq(harness.sql)).toBe(1);
            expect(minCdcReplayableSeq(harness.sql)).toBe(1);
        });

        it("never sweeps past a RELAYED subscriber's in-memory cursor on a quiet table", async () => {
            expect.assertions(2);

            const sockets: FakeWebSocket[] = [];
            const shard = new ProbeCountingShard(makeState(sockets, "room-1"), { LUNORA_CDC_LOG_RETENTION: "1" });

            // A relayed subscriber records NO `__shape_poke_cursor` row — its
            // resume position lives only in the owner's in-memory cohort
            // registry. A floor computed from SQLite alone therefore sees a fully
            // relayed shard as having no subscribers at all.
            //
            // The exposure needs a QUIET table, because a flush advances the
            // cohort frontier only for shapes whose table changed. A busy sibling
            // table drives the log's head far past a quiet shape's frontier, and
            // a sweep that trims to the head then deletes exactly the rows that
            // shape's next diff has to read. Nothing errors — the relayed clients
            // just silently keep rows that moved.
            await shard.seedRoom("r-seed", "room-a");
            await shard.fetch(
                new Request("https://shard.internal/_lunora/relay", {
                    body: JSON.stringify({
                        args: { roomId: "room-a" },
                        connectionId: "relay-conn",
                        name: "roomMembersByRoom",
                        relayIndex: 0,
                        subId: "sub-1",
                        type: "relay_shape_subscribe",
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
            );

            const relayFloor = readCdcCursor(harness.sql);

            for (let index = 0; index < 20; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- the busy sibling table has to drive the head past the quiet shape's frontier
                await shard.seed(`m${String(index)}`, "c1");
            }

            await shard.fetch(write("messages:send", { _id: "trigger", channelId: "c1" }));

            // No durable cursor row exists — the point of the case.
            expect(readShapeCursor()).toBe(0);
            // …and the sweep still stopped at the relayed frontier.
            expect(minCdcSeq(harness.sql) ?? 0).toBeLessThanOrEqual(relayFloor + 1);
        });

        it("refuses a changelog page that starts below the trimmed floor", async () => {
            expect.assertions(2);

            const shard = await sweepWith({ LUNORA_CDC_LOG_RETENTION: "5" }, 20);
            const floor = minCdcSeq(harness.sql) ?? 0;

            expect(floor).toBeGreaterThan(1);

            // A warehouse connector resuming from below the floor must be told,
            // not handed the surviving tail with an advanced cursor — that loses
            // the trimmed range permanently and reports nothing.
            expect(() => shard.syncCdc(0)).toThrow(/trimmed/u);
        });
    });

    describe("changelog archive", () => {
        /**
         * The sweep with a cold tier attached. `waitUntil` is captured rather
         * than ignored because the archive-then-destroy step deliberately runs
         * off the write path — a test that did not await it would assert against
         * a log the sweep had not finished touching.
         */
        const sweepWithArchive = async (environment: Record<string, unknown>, rows: number): Promise<ProbeCountingShard> => {
            const pending: Promise<unknown>[] = [];
            const sockets: FakeWebSocket[] = [];
            const state: ShardDOState = {
                ...makeState(sockets),
                waitUntil: (promise: Promise<unknown>) => {
                    pending.push(promise);
                },
            };
            const shard = new ProbeCountingShard(state, environment);

            for (let index = 0; index < rows; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential writes build the changelog range the sweep acts on
                await shard.seed(`m${String(index)}`, "c1");
            }

            await shard.fetch(write("messages:send", { _id: "trigger", channelId: "c1" }));
            await Promise.all(pending);

            return shard;
        };

        it("serves a trimmed range from the archive instead of demanding a re-seed", async () => {
            expect.assertions(3);

            const bucket = createFakeR2Bucket();
            const shard = await sweepWithArchive({ LUNORA_CDC_ARCHIVE: bucket, LUNORA_CDC_LOG_RETENTION: "5" }, 20);

            // The rows really did leave SQLite — this is not a sweep that quietly
            // did nothing because a bucket was configured.
            expect(minCdcSeq(harness.sql) ?? 0).toBeGreaterThan(1);

            // The live log still refuses the consumer below its floor…
            expect(() => shard.syncCdc(0)).toThrow(/trimmed/u);

            // …and the archive answers it, starting at the very next change.
            const page = await shard.syncCdcArchived(0);

            expect(page.changes[0]?.seq).toBe(1);
        });

        it("destroys nothing it has not archived", async () => {
            expect.assertions(1);

            const bucket = createFakeR2Bucket();

            // A bucket whose `put` always fails: the sweep must skip its
            // destructive half entirely rather than delete rows into a void.
            const failing = {
                ...bucket,
                put: async () => {
                    throw new Error("r2 down");
                },
            };

            await sweepWithArchive({ LUNORA_CDC_ARCHIVE: failing, LUNORA_CDC_LOG_RETENTION: "5" }, 20);

            expect(minCdcSeq(harness.sql)).toBe(1);
        });

        it("does not archive when only payload retention is configured", async () => {
            expect.assertions(2);

            const bucket = createFakeR2Bucket();

            await sweepWithArchive({ LUNORA_CDC_ARCHIVE: bucket, LUNORA_CDC_PAYLOAD_RETENTION: "5" }, 20);

            // Compaction keeps every key, so nothing is lost and there is nothing
            // to soften. Uploading anyway would also never terminate: with no
            // trim advancing the window, each sweep re-reads the same oldest rows
            // and re-uploads the same segment forever.
            expect(bucket.keys()).toHaveLength(0);
            expect(minCdcReplayableSeq(harness.sql) ?? 0).toBeGreaterThan(1);
        });

        it("still refuses a range the archive was turned on too late to hold", async () => {
            expect.assertions(1);

            // Trim first with no bucket — seq 1..N are gone for good — then bind
            // one. The fallback must re-throw the original refusal rather than
            // treat an empty archive as an empty page, which would advance the
            // consumer's cursor past changes nobody has.
            //
            // The env object is held by reference and read on every sweep and
            // every page, so turning the archive on later is a plain mutation of
            // what was passed in — no test-only setter on the production class.
            const environment: Record<string, unknown> = { LUNORA_CDC_LOG_RETENTION: "5" };
            const shard = await sweepWithArchive(environment, 20);

            environment["LUNORA_CDC_ARCHIVE"] = createFakeR2Bucket();

            await expect(shard.syncCdcArchived(0)).rejects.toThrow(/trimmed/u);
        });
    });
});
