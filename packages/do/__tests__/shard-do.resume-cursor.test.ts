import type { SqlExec } from "@lunora/shard-engine";
import { CDC_LOG_TABLE, readCdcEpoch, runShardMigrations } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { ShardDOState, SubscriptionOutcome } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Subscription resume cursor (Pillar 1b) over the real dispatch path
 * (`webSocketMessage` → `subscribe` → `seedSubscription`), driven through a
 * real SQLite engine and a fake hibernatable socket. Proves the three wire
 * outcomes a reconnecting subscriber can observe. A first-time subscribe gets a
 * full `data` frame stamped with the current `__cdc_log` cursor. A reconnect
 * whose read-set is untouched since `sinceSeq` gets a lightweight `resume`
 * frame and keeps its cached value. A reconnect whose read-set changed (or
 * whose cursor fell off the retention floor) gets a fresh full `data` snapshot.
 */

interface Frame {
    cursor?: number;
    data?: unknown;
    epoch?: string;
    id?: string;
    type: string;
}

/** Records every frame the shard sends, and round-trips the hibernation attachment. */
class FakeSocket {
    public readonly frames: Frame[] = [];

    private attachment: unknown;

    public deserializeAttachment(): unknown {
        return this.attachment;
    }

    public send(data: string): void {
        this.frames.push(JSON.parse(data) as Frame);
    }

    public serializeAttachment(value: unknown): void {
        this.attachment = value;
    }
}

/** A shard whose subscription read-set + result are fixed by the test. */
class FixedSubscriptionShard extends ShardDO {
    public result: unknown = [{ _id: "m-1", text: "hi" }];

    public tables = new Set<string>(["messages"]);

    // Required by the abstract base; the resume path never dispatches an RPC.
    // eslint-disable-next-line class-methods-use-this -- abstract stub; the resume tests never call it
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve({});
    }

    protected override executeSubscription(): Promise<SubscriptionOutcome | null> {
        return Promise.resolve({ result: this.result, tables: this.tables });
    }
}

const makeState = (database: ReturnType<typeof createSqliteExec>): ShardDOState => {
    return {
        acceptWebSocket() {},
        getWebSockets() {
            return [];
        },
        storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
    };
};

const append = (sql: SqlExec, table: string): void => {
    sql.exec(`INSERT INTO "${CDC_LOG_TABLE}" (ts, "table", id, op, doc) VALUES (?, ?, ?, ?, ?)`, 1, table, "row", "insert", null);
};

const subscribeEnvelope = (sinceSeq?: number, sinceEpoch?: string): string =>
    JSON.stringify({
        id: "s1",
        query: {
            functionPath: "messages:list",
            ...(sinceSeq === undefined ? {} : { sinceSeq }),
            ...(sinceEpoch === undefined ? {} : { sinceEpoch }),
        },
        type: "subscribe",
    });

describe("shardDO subscription resume cursor", () => {
    it("seeds a first-time subscribe with a full data frame stamped with the cursor", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });
            append(database.sql, "messages");
            append(database.sql, "messages");

            const shard = new FixedSubscriptionShard(makeState(database), {});
            const ws = new FakeSocket();

            await shard.webSocketMessage(ws as unknown as WebSocket, subscribeEnvelope());

            expect(ws.frames[0]).toEqual({ id: "s1", type: "ack" });

            const seed = ws.frames[1];

            expect(seed?.type).toBe("data");
            expect(seed?.cursor).toBe(2);
        } finally {
            database.close();
        }
    });

    it("sends a resume frame (no snapshot) when the client is already at the high-watermark", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });
            append(database.sql, "messages");
            append(database.sql, "messages");
            // Mint the shard's epoch so the client can present a matching one.
            const epoch = readCdcEpoch(database.sql);

            const shard = new FixedSubscriptionShard(makeState(database), {});
            const ws = new FakeSocket();

            await shard.webSocketMessage(ws as unknown as WebSocket, subscribeEnvelope(2, epoch));

            expect(ws.frames[0]).toEqual({ id: "s1", type: "ack" });
            expect(ws.frames[1]).toEqual({ cursor: 2, epoch, id: "s1", type: "resume" });
            // No data frame — the client keeps its cached value.
            expect(ws.frames).toHaveLength(2);
        } finally {
            database.close();
        }
    });

    it("resumes when changes since the cursor miss the subscription's read-set", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });
            append(database.sql, "messages");
            append(database.sql, "messages");
            // A change to an unrelated table the query never reads.
            append(database.sql, "other");
            const epoch = readCdcEpoch(database.sql);

            const shard = new FixedSubscriptionShard(makeState(database), {});
            const ws = new FakeSocket();

            await shard.webSocketMessage(ws as unknown as WebSocket, subscribeEnvelope(2, epoch));

            // Resumable: the read-set ({messages}) is untouched in (2, 3].
            expect(ws.frames[1]).toEqual({ cursor: 3, epoch, id: "s1", type: "resume" });
            expect(ws.frames).toHaveLength(2);
        } finally {
            database.close();
        }
    });

    it("re-snapshots when a read-set table changed since the cursor", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });
            append(database.sql, "messages");
            append(database.sql, "messages");
            // A change to a table the query reads → the cached value is stale.
            append(database.sql, "messages");

            const shard = new FixedSubscriptionShard(makeState(database), {});
            const ws = new FakeSocket();

            await shard.webSocketMessage(ws as unknown as WebSocket, subscribeEnvelope(2));

            const seed = ws.frames[1];

            expect(seed?.type).toBe("data");
            expect(seed?.cursor).toBe(3);
        } finally {
            database.close();
        }
    });

    it("re-snapshots when the log was fully compacted but the watermark moved on", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });
            append(database.sql, "messages");
            append(database.sql, "messages");
            append(database.sql, "messages");
            // Total compaction: every row is gone, but `sqlite_sequence` keeps the
            // watermark at 3, so `cursor (3) > sinceSeq (1)` with an empty log and
            // no retention floor. We have zero evidence the read-set is untouched.
            database.sql.exec(`DELETE FROM "${CDC_LOG_TABLE}"`);

            const shard = new FixedSubscriptionShard(makeState(database), {});
            const ws = new FakeSocket();

            await shard.webSocketMessage(ws as unknown as WebSocket, subscribeEnvelope(1));

            const seed = ws.frames[1];

            expect(seed?.type).toBe("data");
            expect(seed?.cursor).toBe(3);
        } finally {
            database.close();
        }
    });

    it("re-snapshots when more than the scan cap changed since the cursor", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });

            // 10_001 changes to an UNRELATED table the query never reads. Were the
            // scan uncapped this would resume (read-set untouched), but the cap
            // (10_000) means a touching change could hide beyond the scanned page,
            // so the server must conservatively re-snapshot.
            database.sql.exec("BEGIN");

            for (let index = 0; index < 10_001; index += 1) {
                append(database.sql, "other");
            }

            database.sql.exec("COMMIT");

            const shard = new FixedSubscriptionShard(makeState(database), {});
            const ws = new FakeSocket();

            await shard.webSocketMessage(ws as unknown as WebSocket, subscribeEnvelope(0));

            const seed = ws.frames[1];

            expect(seed?.type).toBe("data");
            expect(seed?.cursor).toBe(10_001);
        } finally {
            database.close();
        }
    });

    it("re-snapshots when the client's cursor fell below the retention floor", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema, { cdc: true });
            append(database.sql, "messages");
            append(database.sql, "messages");
            append(database.sql, "messages");
            // Compact everything at or below seq 2 → retention floor is now 3.
            database.sql.exec(`DELETE FROM "${CDC_LOG_TABLE}" WHERE seq <= ?`, 2);

            const shard = new FixedSubscriptionShard(makeState(database), {});
            const ws = new FakeSocket();

            // Client last saw seq 1 — the gap (1, 3) was compacted away.
            await shard.webSocketMessage(ws as unknown as WebSocket, subscribeEnvelope(1));

            const seed = ws.frames[1];

            expect(seed?.type).toBe("data");
            expect(seed?.cursor).toBe(3);
        } finally {
            database.close();
        }
    });
});
