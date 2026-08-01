import type { DatabaseWriterLike, SchemaLike, TransactionHeadroomTracker, TransactionLimits, TtlSweepSpec } from "@lunora/shard-engine";
import { ADMIN_FUNCTIONS, createShardCtxDb as createShardContextDatabase, runShardMigrations, selectExpiredIds } from "@lunora/shard-engine";
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

    describe("alarm-path headroom (plan 207 step 2)", () => {
        const ADMIN_TOKEN = "s3cret-admin";

        const adminRequest = (functionPath: string, args: Record<string, unknown>, token?: string): Request => {
            const headers: Record<string, string> = { "content-type": "application/json" };

            if (token !== undefined) {
                headers.authorization = `Bearer ${token}`;
            }

            return new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args, functionPath }),
                headers,
                method: "POST",
            });
        };

        /**
         * Unlike `TtlShard` above, this variant actually forwards the `headroom`
         * `pollTtlSweeps` threads through `deleteRowThroughWriter` into a REAL
         * metered writer — proving the value-threading, not just the plumbing.
         * `transactionLimits()` is overridden tiny so a sweep can be driven past
         * it deterministically.
         */
        class MeteredTtlShard extends ShardDO {
            // eslint-disable-next-line class-methods-use-this -- override stub; RPCs never dispatch in this test
            public override handleRpc(): Promise<unknown> {
                return Promise.reject(new Error("handleRpc must not run"));
            }

            /** Test-only: `pollTtlSweeps` is protected; drive it directly rather than through the whole `alarm()` tick. */
            public runPollTtlSweeps(): Promise<number | undefined> {
                return this.pollTtlSweeps();
            }

            protected override deleteRowThroughWriter(table: string, id: string, headroom?: TransactionHeadroomTracker): Promise<void> {
                const writer = createShardContextDatabase({
                    broadcast: (delta) => {
                        this.recordChangedTable(delta.table);
                    },
                    headroom,
                    schema: ttlSchema,
                    sql: this.sql as never,
                });

                return writer.delete(id, table);
            }

            // eslint-disable-next-line class-methods-use-this -- resolved TTL policies for this schema
            protected override ttlSweeps(): ReadonlyArray<TtlSweepSpec> {
                return [{ field: "expiresAt", table: "sessions" }];
            }

            // eslint-disable-next-line class-methods-use-this -- deliberately tiny so a sweep pass can be driven past the ceiling
            protected override transactionLimits(): Partial<TransactionLimits> {
                return { maxWrittenRows: 3 };
            }
        }

        it("stops a sweep pass at the transaction limit, keeps the rows it already deleted, and re-arms near-immediately instead of throwing", async () => {
            expect.assertions(6);

            const writer = setupWriter();
            const past = NOW - 1000;

            for (let index = 0; index < 10; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- deterministic seed order
                await writer.insert("sessions", { _id: `s${String(index)}`, expiresAt: past, token: `t${String(index)}` }, { allowExplicitId: true });
            }

            const state: ShardDOState = {
                acceptWebSocket() {},
                getWebSockets() {
                    return [];
                },
                storage: { sql: harness.sql as unknown as ShardDOState["storage"]["sql"] },
            };
            const shard = new MeteredTtlShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            const before = Date.now();

            // Must NOT throw — the limit is caught and handled inside pollTtlSweeps.
            const nextDueAt = await shard.runPollTtlSweeps();

            // Partial progress: the tiny ceiling stopped the pass well short of
            // all 10 rows, but the rows deleted before the trip STAY deleted —
            // `selectExpiredIds` never re-selects them, so that IS the resumable
            // checkpoint (no separate cursor needed).
            const remaining = await writer.query("sessions").collect();

            expect(remaining.length).toBeGreaterThan(0);
            expect(remaining.length).toBeLessThan(10);

            // Near-immediate re-arm — NOT the normal 30 s TTL_SWEEP_INTERVAL_MS
            // cadence a completed pass would report.
            expect(nextDueAt).toBeDefined();
            expect((nextDueAt ?? 0) - before).toBeLessThan(5000);

            // Warned (batch full), not recorded as a genuine shape/source failure.
            const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getLogs, {}, ADMIN_TOKEN));
            const body = await response.json<{ result: { entries: { functionPath?: string; level: string; message: string }[] } }>();

            expect(response.status).toBe(200);
            expect(body.result.entries).toContainEqual(expect.objectContaining({ functionPath: "ttl:sweep", level: "warn" }));
        });
    });
});
