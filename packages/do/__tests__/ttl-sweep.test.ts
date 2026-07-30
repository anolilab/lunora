import type { DatabaseWriterLike, SchemaLike, TtlSweepSpec } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations, selectExpiredIds } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Declarative table-level TTL (`.ttl(field, { after })`). Covers the pure
 * `selectExpiredIds` scan (expiry math, `after` offset, soft-delete exclusion)
 * and the DO alarm-driven sweep end to end: an expired row is physically removed
 * on a plain table and soft-deleted on a `.softDelete()` table, verified after
 * `alarm()` advances.
 */

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

const ttlSchema: SchemaLike = {
    tables: {
        // Soft-delete + TTL: expiry flips the marker instead of removing the row.
        otps: {
            indexes: [],
            shape: { code: { kind: "string" }, deletedAt: { kind: "number" }, expiresAt: { kind: "number" } },
            softDeleteMode: { field: "deletedAt" },
            ttlPolicy: { field: "expiresAt" },
        },
        // Plain TTL: expiry physically removes the row.
        sessions: {
            indexes: [],
            shape: { expiresAt: { kind: "number" }, token: { kind: "string" } },
            ttlPolicy: { field: "expiresAt" },
        },
    },
};

/** A `ShardDO` whose TTL tier is driven off `ttlSchema` and whose per-row delete routes through a real writer. */
class TtlShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; RPCs never dispatch in this test
    public override handleRpc(): Promise<unknown> {
        return Promise.reject(new Error("handleRpc must not run"));
    }

    protected override deleteRowThroughWriter(table: string, id: string): Promise<void> {
        const writer = createShardContextDatabase({
            broadcast: (delta) => {
                this.recordChangedTable(delta.table);
            },
            schema: ttlSchema,
            sql: this.sql as never,
        });

        return writer.delete(id, table);
    }

    // eslint-disable-next-line class-methods-use-this -- resolved TTL policies for this schema (the codegen subclass reads them off the imported schema)
    protected override ttlSweeps(): ReadonlyArray<TtlSweepSpec> {
        return [
            { field: "expiresAt", table: "sessions" },
            { field: "expiresAt", softDeleteField: "deletedAt", table: "otps" },
        ];
    }
}

let harness: ReturnType<typeof createSqliteExec>;

const setupWriter = (): DatabaseWriterLike => {
    runShardMigrations(harness.sql, ttlSchema);

    return createShardContextDatabase({ clock: () => NOW, schema: ttlSchema, sql: harness.sql });
};

describe("ttl sweep", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("selectExpiredIds", () => {
        it("selects only rows whose expiry has passed", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await writer.insert("sessions", { _id: "s1", expiresAt: NOW - 1000, token: "past" }, { allowExplicitId: true });
            await writer.insert("sessions", { _id: "s2", expiresAt: NOW + HOUR, token: "future" }, { allowExplicitId: true });

            const { ids } = selectExpiredIds(harness.sql, { field: "expiresAt", table: "sessions" }, NOW, 100);

            expect(ids).toStrictEqual(["s1"]);
        });

        it("applies the `after` offset (expiry = field + after)", async () => {
            expect.assertions(2);

            const writer = setupWriter();

            // Base timestamp two hours ago; expires one hour after it — already past at NOW.
            await writer.insert("sessions", { _id: "old", expiresAt: NOW - 2 * HOUR, token: "old" }, { allowExplicitId: true });
            // Base timestamp one minute ago; +1h expiry is still in the future.
            await writer.insert("sessions", { _id: "fresh", expiresAt: NOW - 60_000, token: "fresh" }, { allowExplicitId: true });

            const withAfter = selectExpiredIds(harness.sql, { after: HOUR, field: "expiresAt", table: "sessions" }, NOW, 100);
            const withoutAfter = selectExpiredIds(harness.sql, { field: "expiresAt", table: "sessions" }, NOW, 100);

            expect(withAfter.ids).toStrictEqual(["old"]);
            // Without the offset both base timestamps are already past.
            expect(withoutAfter.ids.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["fresh", "old"]);
        });

        it("excludes already soft-deleted rows", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await writer.insert("otps", { _id: "o1", code: "a", expiresAt: NOW - 1000 }, { allowExplicitId: true });
            await writer.insert("otps", { _id: "o2", code: "b", expiresAt: NOW - 1000 }, { allowExplicitId: true });
            // Soft-delete o1: it must NOT be re-selected by the sweep.
            await writer.delete("o1", "otps");

            const { ids } = selectExpiredIds(harness.sql, { field: "expiresAt", softDeleteField: "deletedAt", table: "otps" }, NOW, 100);

            expect(ids).toStrictEqual(["o2"]);
        });
    });

    describe("alarm-driven sweep", () => {
        it("physically deletes expired rows on a plain table and soft-deletes them on a soft-delete table", async () => {
            expect.assertions(4);

            const writer = setupWriter();

            const past = Date.now() - HOUR;
            const future = Date.now() + HOUR;

            await writer.insert("sessions", { _id: "s_past", expiresAt: past, token: "past" }, { allowExplicitId: true });
            await writer.insert("sessions", { _id: "s_future", expiresAt: future, token: "future" }, { allowExplicitId: true });
            await writer.insert("otps", { _id: "o_past", code: "past", expiresAt: past }, { allowExplicitId: true });
            await writer.insert("otps", { _id: "o_future", code: "future", expiresAt: future }, { allowExplicitId: true });

            const state: ShardDOState = {
                acceptWebSocket() {},
                getWebSockets() {
                    return [];
                },
                storage: { sql: harness.sql as unknown as ShardDOState["storage"]["sql"] },
            };
            const shard = new TtlShard(state, {});

            // Advance the alarm — the shared poll alarm runs the TTL tier.
            await shard.alarm();

            const sessions = await writer.query("sessions").collect();
            const liveOtps = await writer.query("otps").collect();

            // Plain table: the past session is gone, the future one remains.
            expect(sessions.map((row) => row["_id"])).toStrictEqual(["s_future"]);
            // Soft-delete table: list reads hide the expired (now soft-deleted) row.
            expect(liveOtps.map((row) => row["_id"])).toStrictEqual(["o_future"]);

            // …but the expired otp is only soft-deleted — still physically present with its marker set.
            const softDeleted = await writer.get("o_past");

            expect(softDeleted).not.toBeNull();
            expect(softDeleted?.["deletedAt"]).toStrictEqual(expect.any(Number));
        });
    });
});
