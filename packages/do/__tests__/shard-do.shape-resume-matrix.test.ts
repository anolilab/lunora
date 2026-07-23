/**
 * Characterization matrix for the `seedOpLogShape` resume-vs-reseed decision.
 *
 * `canResume` in `seedOpLogShape` (packages/do/src/shard-do.ts) is a five-clause
 * conjunction — every clause must hold for the server to send a lightweight diff
 * instead of a full membership snapshot:
 *
 * 1. `cdcEnabled()` — the `__cdc_log` table exists (CDC was on when the shard was migrated)
 * 2. `shape.sinceSeq !== undefined` — the client supplied a checkpoint hint
 * 3. `shape.sinceEpoch === epoch` — both sides are on the same CDC timeline
 * 4. `shape.sinceSeq &lt;= cursor` — the client is not ahead of the server
 * 5a. `shape.sinceSeq === cursor` — trivial: already at cursor, nothing missed; OR
 * 5b. `floor !== undefined &amp;&amp; floor &lt;= shape.sinceSeq + 1` — the oldest retained op still covers the client's gap
 *
 * **Observable distinction (wire protocol):**
 * - **Resume** — `pokeStart.baseCheckpoint` is a number (`=== shape.sinceSeq`); `rowsPatch` holds only the diff ops for `(sinceSeq, cursor]`.
 * - **Reseed** — `pokeStart.baseCheckpoint` is `undefined`; `rowsPatch` holds the full current membership as inserts.
 *
 * Each `it.each` row covers one cell of the matrix. This file pins CURRENT behaviour so plan-072's
 * `buildShapeDiff` optimisation has a safety-net before and after.
 */

import type { SocketAttachment } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { SqlExec } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, readCdcEpoch, runShardMigrations, trimCdcChanges } from "../src/ctx-db";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

// ---------------------------------------------------------------------------
// Wire-frame helpers
// ---------------------------------------------------------------------------

interface ParsedFrame {
    baseCheckpoint?: number;
    rowsPatch?: { key: string; op: string; value?: Record<string, unknown> }[];
    type: string;
}

/** Extract `baseCheckpoint` from the first `pokeStart` frame a socket received. */
const firstPokeStartBase = (sent: string[]): number | undefined => {
    for (const raw of sent) {
        const frame = JSON.parse(raw) as ParsedFrame;

        if (frame.type === "pokeStart") {
            return frame.baseCheckpoint;
        }
    }

    return undefined;
};

/** Collect all row-ops delivered across every `pokePart` frame. */
const allPokeOps = (sent: string[]): ParsedFrame["rowsPatch"] => {
    const ops: NonNullable<ParsedFrame["rowsPatch"]> = [];

    for (const raw of sent) {
        const frame = JSON.parse(raw) as ParsedFrame;

        if (frame.type === "pokePart") {
            ops.push(...(frame.rowsPatch ?? []));
        }
    }

    return ops;
};

/** Return `true` when the socket received a final `ack` frame (subscribe succeeded). */
const gotAck = (sent: string[]): boolean => sent.some((raw) => (JSON.parse(raw) as ParsedFrame).type === "ack");

// ---------------------------------------------------------------------------
// Fake socket and state factories (mirrors shard-do.shape-poke.test.ts)
// ---------------------------------------------------------------------------

interface FakeSocket {
    attachment: SocketAttachment | undefined;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

const createFakeSocket = (): FakeSocket => {
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

// ---------------------------------------------------------------------------
// Test shard: resolves `messagesByChannel(channelId)` shapes only.
// ---------------------------------------------------------------------------

/**
 * `ShardDO` subclass that resolves the single `messagesByChannel` shape used
 * across every matrix case. `handleRpc` is a required abstract stub that the
 * shape-subscribe path never calls (no write-flush in these seed-only tests).
 */
class MatrixShapeShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- required abstract implementation; shape-subscribe path never calls handleRpc
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve({ ok: true });
    }

    // eslint-disable-next-line class-methods-use-this -- test stub: resolves by shape name + args alone, no instance state
    protected override resolveShape(name: string, args: Record<string, unknown>): { effectiveWhere?: Record<string, unknown>; table: string } | undefined {
        if (name !== "messagesByChannel") {
            return undefined;
        }

        return { effectiveWhere: { channelId: args["channelId"] }, table: "messages" };
    }
}

// ---------------------------------------------------------------------------
// Matrix definition
// ---------------------------------------------------------------------------

type HarnessLike = ReturnType<typeof createSqliteExec>;

interface MatrixRow {
    /** Whether `runShardMigrations` is called with `{ cdc: true }` for this case. */
    cdcMigrate: boolean;
    /** Expected number of row-ops in `pokePart` frames (diff length or full-seed length). */
    expectedOpsLen: number;
    /** Whether the subscribe should trigger the resume (diff) path. */
    expectResume: boolean;
    /** Human-readable label used as the test description. */
    label: string;

    /**
     * Populate the SQLite database before the subscribe. Receives the live harness so
     * setup functions can use the writer, trim the CDC log, or insert raw rows (for the
     * CDC-disabled case where no `__cdc_log` table exists).
     */
    setup: (harness: HarnessLike) => Promise<void>;

    /**
     * Derive the `sinceEpoch` string to embed in the subscribe envelope. Receives the
     * live SQL handle so callers can read the real epoch (`readCdcEpoch`) or return a
     * hard-coded stale value to trigger a mismatch.
     */
    sinceEpochFn: (sql: SqlExec) => string | undefined;
    /** `sinceCheckpoint` value placed in the subscribe envelope; `undefined` = no hint (fresh sub). */
    sinceSeq: number | undefined;
}

/** Convenience: create a CDC-enabled writer over the test harness's SQL handle. */
const makeWriter = (sql: SqlExec) =>
    createShardContextDatabase({
        broadcast: () => undefined,
        cdc: true,
        clock: () => 1_700_000_000_000,
        schema: messagesSchema,
        sql,
    });

const matrix: MatrixRow[] = [
    {
        label: "1 — happy path: CDC on, epoch match, log covers sinceSeq → diff resume",
        cdcMigrate: true,
        setup: async (harness) => {
            const writer = makeWriter(harness.sql);

            // seq=1: m1 in c1; seq=2: m2 in c1. sinceSeq=1 diffs only (1, 2] = m2.
            await writer.insert("messages", { _id: "m1", authorId: "u1", channelId: "c1", text: "alpha" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m2", authorId: "u1", channelId: "c1", text: "beta" }, { allowExplicitId: true });
        },
        sinceSeq: 1,
        sinceEpochFn: (sql) => readCdcEpoch(sql),
        expectResume: true,
        expectedOpsLen: 1, // only m2 is in (sinceSeq=1, cursor=2]
    },
    {
        label: "2 — epoch mismatch: sinceEpoch differs from server epoch → full reseed",
        cdcMigrate: true,
        setup: async (harness) => {
            const writer = makeWriter(harness.sql);

            await writer.insert("messages", { _id: "m1", authorId: "u1", channelId: "c1", text: "alpha" }, { allowExplicitId: true });
        },
        sinceSeq: 1,
        sinceEpochFn: () => "stale-epoch-00000000-0000-0000-0000-000000000000",
        expectResume: false,
        expectedOpsLen: 1, // full seed: m1 is the only c1 member
    },
    {
        label: "3 — client ahead: sinceSeq > cursor (rollback guard) → full reseed",
        cdcMigrate: true,
        setup: async (harness) => {
            const writer = makeWriter(harness.sql);

            await writer.insert("messages", { _id: "m1", authorId: "u1", channelId: "c1", text: "alpha" }, { allowExplicitId: true });
        },
        sinceSeq: 99, // far beyond cursor=1
        sinceEpochFn: (sql) => readCdcEpoch(sql),
        expectResume: false,
        expectedOpsLen: 1, // full seed: m1
    },
    {
        label: "4 — retention gap: floor > sinceSeq + 1 (compacted past client) → full reseed",
        cdcMigrate: true,
        setup: async (harness) => {
            const writer = makeWriter(harness.sql);

            // seq=1 (m1), seq=2 (m2). Trim seq≤1 → floor=2. sinceSeq=0 → gap.
            await writer.insert("messages", { _id: "m1", authorId: "u1", channelId: "c1", text: "alpha" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m2", authorId: "u1", channelId: "c1", text: "beta" }, { allowExplicitId: true });
            // Delete CDC rows ≤ 1; cursor stays at 2 (AUTOINCREMENT); floor becomes 2.
            trimCdcChanges(harness.sql, 1);
        },
        sinceSeq: 0, // floor(2) > sinceSeq+1(1) → gap
        sinceEpochFn: (sql) => readCdcEpoch(sql),
        expectResume: false,
        expectedOpsLen: 2, // full seed: m1 + m2 both in c1
    },
    {
        label: "5a — fully-compacted log, client at cursor → trivial resume (empty diff)",
        cdcMigrate: true,
        setup: async (harness) => {
            const writer = makeWriter(harness.sql);

            // seq=1 (m1). Trim all CDC rows; floor becomes undefined; cursor stays at 1.
            await writer.insert("messages", { _id: "m1", authorId: "u1", channelId: "c1", text: "alpha" }, { allowExplicitId: true });
            trimCdcChanges(harness.sql, 1);
        },
        sinceSeq: 1, // === cursor=1 → sinceSeq === cursor branch fires
        sinceEpochFn: (sql) => readCdcEpoch(sql),
        expectResume: true,
        expectedOpsLen: 0, // already at cursor — diff range (1,1] is empty
    },
    {
        label: "5b — fully-compacted log, client lagging → full reseed (gap unprovable)",
        cdcMigrate: true,
        setup: async (harness) => {
            const writer = makeWriter(harness.sql);

            // seq=1 (m1), seq=2 (m2). Trim all; floor=undefined; cursor=2.
            await writer.insert("messages", { _id: "m1", authorId: "u1", channelId: "c1", text: "alpha" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m2", authorId: "u1", channelId: "c1", text: "beta" }, { allowExplicitId: true });
            trimCdcChanges(harness.sql, 2);
        },
        sinceSeq: 1, // < cursor=2; floor=undefined → can't prove (1, 2] was gap-free
        sinceEpochFn: (sql) => readCdcEpoch(sql),
        expectResume: false,
        expectedOpsLen: 2, // full seed: m1 + m2
    },
    {
        label: "6 — CDC disabled: cdcEnabled()=false → full reseed regardless of hint",
        cdcMigrate: false, // no __cdc_log table → cdcEnabled() returns false
        setup: async (harness) => {
            // No CDC-enabled writer available; insert the row directly so the
            // shape seed (which reads the main table, not the log) still finds it.
            harness.raw(
                "INSERT INTO messages (id, _creationTime, __doc__) VALUES (?, ?, ?)",
                "m1",
                1_700_000_000_000,
                JSON.stringify({ authorId: "u1", channelId: "c1", text: "alpha" }),
            );
        },
        sinceSeq: 0,
        sinceEpochFn: () => "any-epoch",
        expectResume: false,
        expectedOpsLen: 1, // full seed: m1 (read from main table via buildShapeSeed)
    },
    {
        label: "7 — fresh sub: no sinceSeq supplied → full reseed (first-time subscribe)",
        cdcMigrate: true,
        setup: async (harness) => {
            const writer = makeWriter(harness.sql);

            await writer.insert("messages", { _id: "m1", authorId: "u1", channelId: "c1", text: "alpha" }, { allowExplicitId: true });
        },
        sinceSeq: undefined, // no hint → sinceSeq === undefined branch → canResume=false
        sinceEpochFn: () => undefined,
        expectResume: false,
        expectedOpsLen: 1, // full seed: m1
    },
];

// ---------------------------------------------------------------------------
// Matrix tests
// ---------------------------------------------------------------------------

describe("seedOpLogShape resume-vs-reseed decision matrix", () => {
    it.each(matrix)("$label", async ({ cdcMigrate, expectedOpsLen, expectResume, setup, sinceEpochFn, sinceSeq }) => {
        expect.assertions(3);

        // Each case gets its own in-memory SQLite database so there is no state bleed.
        const testHarness = createSqliteExec();

        try {
            runShardMigrations(testHarness.sql, messagesSchema, { cdc: cdcMigrate });

            await setup(testHarness);

            // Build the shard over the same SQL handle so `cdcEnabled()`, `currentCdcCursor()`,
            // `currentCdcEpoch()`, and the shape seed/diff all read the same database.
            const sockets: FakeSocket[] = [];
            const state: ShardDOState = {
                acceptWebSocket(ws: WebSocket) {
                    sockets.push(ws as unknown as FakeSocket);
                },
                getWebSockets(): WebSocket[] {
                    return sockets as unknown as WebSocket[];
                },
                storage: { sql: testHarness.sql as unknown as ShardDOState["storage"]["sql"] },
            };
            const shard = new MatrixShapeShard(state, {});
            const ws = createFakeSocket();
            sockets.push(ws);

            // Derive the epoch string AFTER setup so it reflects the real DB state.
            const epoch = sinceEpochFn(testHarness.sql);

            // Send the shape_subscribe envelope. `sinceCheckpoint`/`sinceEpoch` are
            // omitted when undefined so the server treats it as a fresh subscription.
            await shard.webSocketMessage(
                ws as unknown as WebSocket,
                JSON.stringify({
                    id: "shape-1",
                    shape: { args: { channelId: "c1" }, name: "messagesByChannel" },
                    type: "shape_subscribe",
                    ...(sinceSeq !== undefined && { sinceCheckpoint: sinceSeq }),
                    ...(epoch !== undefined && { sinceEpoch: epoch }),
                }),
            );

            const baseCheckpoint = firstPokeStartBase(ws.sent);
            const ops = allPokeOps(ws.sent);
            const acked = gotAck(ws.sent);

            // Primary: resume path stamps baseCheckpoint; reseed leaves it undefined.
            expect(baseCheckpoint !== undefined).toBe(expectResume);
            // Secondary: diff length (resume) or full-membership count (reseed).
            expect(ops).toHaveLength(expectedOpsLen);
            // Sanity: subscription completed successfully (no error frame, got ack).
            expect(acked).toBe(true);
        } finally {
            testHarness.close();
        }
    });
});
