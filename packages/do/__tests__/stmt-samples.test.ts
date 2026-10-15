/**
 * OBS-04: the per-dispatch SQL statement-sample buffer (`currentStmtSamples`,
 * backing the query-metrics leaderboard) folds repeats of the same statement
 * into a running entry rather than appending one array element per raw
 * execution, and bounds the number of DISTINCT statement shapes a single
 * dispatch can accumulate. Exercises the instrumented `sql` getter and
 * `flushStmtSamples` directly through a real `.fetch()` dispatch, backed by a
 * real SQLite handle so the durable `__lunora_metrics_queries` table can be
 * read back afterwards.
 */
import { readQueryInsights, readQueryMetrics } from "@lunora/observability";
import type { SqlExec } from "@lunora/shard-engine";
import { ADMIN_FUNCTIONS } from "@lunora/shard-engine";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

const ADMIN_TOKEN = "stmt-samples-admin-token-long-enough";

// Not re-exported from the `@lunora/observability` barrel (query-metrics.ts's
// table-name constant is package-internal); mirrors the reserved name in
// `packages/observability/src/query-metrics.ts`.
const QUERY_METRICS_TABLE = "__lunora_metrics_queries";

/** A shard state backed by a real in-memory SQLite, so the durable query-metrics path is exercised for real. */
const sqliteStateDouble = (database: ReturnType<typeof createSqliteExec>): ShardDOState => {
    return {
        acceptWebSocket() {},
        getWebSockets() {
            return [];
        },
        storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
    };
};

/**
 * Drives the instrumented `this.sql` getter directly from `handleRpc`,
 * bypassing the generated function-context wiring a real app would go
 * through — the same technique `tracing.test.ts`'s `TracingShard` uses for
 * `makeTracer`.
 *
 * `distinctQueries` issues that many UNIQUELY-texted `SELECT`s (each its own
 * statement shape); `repeatsOfFirst` issues that many MORE executions of the
 * exact same statement text as the first query, exercising the in-dispatch
 * fold. `attachSpan` mirrors what a handler using `ctx.span` does — forcing a
 * `SpanCollector` to exist for this dispatch so `recordDispatchRootSpan`
 * records an attributed root span the test can read back via `getTraces`.
 */
class StmtSampleShard extends ShardDO {
    public attachSpan = true;

    public distinctQueries = 0;

    /** Every object `this.sql` returned during the dispatch, in read order. */
    public handlesSeen: unknown[] = [];

    public repeatsOfFirst = 0;

    public throwAfterQueries = false;

    public override async handleRpc(): Promise<unknown> {
        if (this.attachSpan) {
            const anchor = this.getCurrentTrace();

            if (anchor !== undefined) {
                this.makeDispatchSpan(anchor).setAttribute("probe", true);
            }
        }

        const sql = this.sql as SqlExec;

        for (let index = 0; index < this.distinctQueries; index += 1) {
            sql.exec(`SELECT ${String(index)} AS x`).toArray();
        }

        for (let index = 0; index < this.repeatsOfFirst; index += 1) {
            sql.exec(`SELECT 0 AS x`).toArray();
        }

        if (this.throwAfterQueries) {
            throw new Error("boom");
        }

        this.handlesSeen.push(sql, this.sql, this.sql);

        return { ok: true };
    }
}

const userRequest = (functionPath: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

const adminRequest = (functionPath: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        method: "POST",
    });

describe("statement sample buffer (OBS-04)", () => {
    it("coalesces statement samples across dispatches into one exact exec_count per flush", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            const shard = new StmtSampleShard(sqliteStateDouble(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, LUNORA_METRICS_FLUSH_EVERY: "3" });

            shard.attachSpan = false;
            shard.distinctQueries = 1;

            await shard.fetch(userRequest("probe:query"));
            await shard.fetch(userRequest("probe:query"));

            // Two dispatches in: nothing durable yet.
            expect(database.raw(`SELECT name FROM sqlite_master WHERE name = '${QUERY_METRICS_TABLE}'`)).toEqual([]);

            await shard.fetch(userRequest("probe:query"));

            expect(readQueryMetrics(database.sql)).toHaveLength(1);
            expect(readQueryMetrics(database.sql)[0]?.execCount).toBe(3);
        } finally {
            database.close();
        }
    });

    describe("with a controlled clock", () => {
        const NOW = 600 * 60_000 + 1000;
        const clock = { latency: 0, now: NOW };

        afterEach(() => {
            vi.restoreAllMocks();
        });

        /** A SQLite handle whose every exec advances the fake clock by `clock.latency`. */
        const timedDatabase = () => {
            clock.now = NOW;
            clock.latency = 0;
            vi.spyOn(Date, "now").mockImplementation(() => clock.now);

            const database = createSqliteExec();
            const realExec = database.sql.exec.bind(database.sql);

            database.sql.exec = (query: string, ...params: unknown[]) => {
                clock.now += clock.latency;

                return realExec(query, ...params);
            };

            return database;
        };

        it("keeps each dispatch's own latency in the histogram instead of averaging a coalesced batch", async () => {
            expect.assertions(2);

            const database = timedDatabase();

            try {
                const shard = new StmtSampleShard(sqliteStateDouble(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, LUNORA_METRICS_FLUSH_EVERY: "20" });

                shard.attachSpan = false;
                shard.repeatsOfFirst = 1;

                for (let index = 0; index < 20; index += 1) {
                    clock.latency = index === 19 ? 1000 : 1;
                    // eslint-disable-next-line no-await-in-loop -- sequential dispatches
                    await shard.fetch(userRequest("probe:query"));
                }

                clock.latency = 0;

                const insights = readQueryInsights(database.sql, 3_600_000, clock.now);

                expect(insights.entries).toHaveLength(1);
                // 19 of 20 executions took 1ms: the p95 is the 1ms bucket, not the 100ms one the batch average lands in.
                expect(insights.entries[0]?.p95DurationMs).toBe(1);
            } finally {
                database.close();
            }
        });

        it("writes one lifetime upsert for dispatches of the same statement in the same latency bucket", async () => {
            expect.assertions(2);

            const database = timedDatabase();

            try {
                const realExec = database.sql.exec.bind(database.sql);
                let lifetimeUpserts = 0;

                database.sql.exec = (query: string, ...params: unknown[]) => {
                    if (query.startsWith(`INSERT INTO "${QUERY_METRICS_TABLE}" `)) {
                        lifetimeUpserts += 1;
                    }

                    return realExec(query, ...params);
                };

                const shard = new StmtSampleShard(sqliteStateDouble(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, LUNORA_METRICS_FLUSH_EVERY: "5" });

                shard.attachSpan = false;
                shard.repeatsOfFirst = 1;
                clock.latency = 1;

                for (let index = 0; index < 5; index += 1) {
                    // eslint-disable-next-line no-await-in-loop -- sequential dispatches
                    await shard.fetch(userRequest("probe:query"));
                }

                clock.latency = 0;

                expect(lifetimeUpserts).toBe(1);
                expect(readQueryMetrics(database.sql)).toMatchObject([{ execCount: 5 }]);
            } finally {
                database.close();
            }
        });

        it("drops only the failed statement sample and still writes the rest of the batch", async () => {
            expect.assertions(3);

            const database = timedDatabase();
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

            try {
                const realExec = database.sql.exec.bind(database.sql);
                let failures = 1;

                database.sql.exec = (query: string, ...params: unknown[]) => {
                    if (failures > 0 && query.includes(QUERY_METRICS_TABLE)) {
                        failures -= 1;

                        throw new Error("storage hiccup");
                    }

                    return realExec(query, ...params);
                };

                const shard = new StmtSampleShard(sqliteStateDouble(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

                shard.attachSpan = false;
                // Two raw statement texts (two samples) that normalise to the same row.
                shard.distinctQueries = 2;

                await shard.fetch(userRequest("probe:query"));

                expect(readQueryMetrics(database.sql)).toMatchObject([{ execCount: 1 }]);
                expect(warn).toHaveBeenCalledTimes(1);
                expect(warn).toHaveBeenCalledWith("[@lunora/do] metric write failed, dropped 0 function deltas and 1 statement samples: storage hiccup");
            } finally {
                database.close();
            }
        });
    });

    it("flushes statement samples immediately when the dispatch errors", async () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            const shard = new StmtSampleShard(sqliteStateDouble(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, LUNORA_METRICS_FLUSH_EVERY: "50" });

            shard.attachSpan = false;
            shard.distinctQueries = 3;
            shard.throwAfterQueries = true;

            await shard.fetch(userRequest("probe:query"));

            // The three distinct literals normalise to one statement shape with exec_count 3.
            expect(readQueryMetrics(database.sql)).toMatchObject([{ execCount: 3 }]);
        } finally {
            database.close();
        }
    });

    it("folds many repeats of the same statement into one durable row with the real exec_count", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            const shard = new StmtSampleShard(sqliteStateDouble(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            shard.attachSpan = false;
            shard.repeatsOfFirst = 250;

            await shard.fetch(userRequest("probe:query"));

            // One statement shape → one physical row, not 250.
            expect(database.raw(`SELECT COUNT(*) AS c FROM "${QUERY_METRICS_TABLE}"`)).toEqual([{ c: 1 }]);

            const [row] = readQueryMetrics(database.sql);

            // Every real execution still counted — folding must not silently drop them.
            expect(row?.execCount).toBe(250);
            expect(row?.normalizedSql).toBe("SELECT ? AS x");
        } finally {
            database.close();
        }
    });

    it("bounds the per-dispatch buffer at the distinct-statement cap and sets db.stmt_samples_truncated on the wide event", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            const shard = new StmtSampleShard(sqliteStateDouble(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            // Comfortably past the 200-distinct-statement cap (see
            // `MAX_STMT_SAMPLES_PER_DISPATCH` in `shard-do.ts`) — each iteration is
            // its own statement shape, so none of these fold together.
            shard.distinctQueries = 250;

            await shard.fetch(userRequest("probe:query"));

            // The in-memory buffer dropped brand-new shapes past the cap, so the
            // durable table only ever saw the first 200 distinct statements.
            const rows = readQueryMetrics(database.sql);

            expect(rows.length).toBeLessThanOrEqual(200);
            expect(rows.length).toBeGreaterThan(0);

            const tracesResponse = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getTraces));
            const body = await tracesResponse.json<{
                result: { traces: { spans: { attributes?: Record<string, unknown>; depth: number }[] }[] };
            }>();
            const root = body.result.traces[0]?.spans.find((entry) => entry.depth === 0);

            expect(root?.attributes?.["db.stmt_samples_truncated"]).toBe(true);
        } finally {
            database.close();
        }
    });

    it("records rows SCANNED from the cursor's counters, not the size of the result set", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            // A cursor that returns one row but reports having scanned 200k —
            // the shape of a filter on an unindexed column, and the whole reason
            // the leaderboard cannot rank on result-set size. Only the probe
            // statement is decorated, so the DO's own internal SQL keeps running
            // against untouched cursors.
            const probe = "SELECT 0 AS x";
            const counted: ShardDOState = {
                acceptWebSocket() {},
                getWebSockets() {
                    return [];
                },
                storage: {
                    sql: {
                        exec: (query: string, ...parameters: unknown[]) => {
                            const cursor = database.sql.exec(query, ...parameters);

                            if (query !== probe) {
                                return cursor;
                            }

                            return { one: () => cursor.one(), rowsRead: 200_000, rowsWritten: 7, toArray: () => cursor.toArray() };
                        },
                    },
                },
            };

            const shard = new StmtSampleShard(counted, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            shard.attachSpan = false;
            shard.repeatsOfFirst = 1;

            await shard.fetch(userRequest("probe:query"));

            const row = readQueryMetrics(database.sql).find((entry) => entry.normalizedSql === "SELECT ? AS x");

            expect(row?.rowsRead).toBe(200_000);
            expect(row?.rowsWritten).toBe(7);
        } finally {
            database.close();
        }
    });

    it("does not set db.stmt_samples_truncated when the dispatch stays under the cap", async () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            const shard = new StmtSampleShard(sqliteStateDouble(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            shard.distinctQueries = 5;

            await shard.fetch(userRequest("probe:query"));

            const tracesResponse = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getTraces));
            const body = await tracesResponse.json<{
                result: { traces: { spans: { attributes?: Record<string, unknown>; depth: number }[] }[] };
            }>();
            const root = body.result.traces[0]?.spans.find((entry) => entry.depth === 0);

            expect(root?.attributes?.["db.stmt_samples_truncated"]).toBeUndefined();
        } finally {
            database.close();
        }
    });
});

/**
 * The instrumented `sql` getter must return ONE object per dispatch.
 *
 * This is not a micro-optimisation, and it is not local to this file:
 * `@lunora/shard-engine`'s `cdcCanVouchFor` memoizes the shard's table catalog in
 * a `WeakMap` keyed by the handle it is called with, because re-scanning
 * `sqlite_master` on every resume evaluation measured ~18% of `evaluateResume`.
 * A getter that builds a fresh `Proxy` per read makes that memo miss every single
 * time — silently, with no test failing and no type breaking. Anyone adding
 * another wrapper layer here (tracing, an RLS guard, a retry shim) has to keep
 * the identity stable, so it is pinned rather than left to a comment.
 */
describe("instrumented sql handle identity", () => {
    it("returns the same handle for every read within one dispatch, and a fresh one for the next", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            const shard = new StmtSampleShard(sqliteStateDouble(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            shard.attachSpan = false;
            // At least one execution, so instrumentation is genuinely active
            // (an uninstrumented dispatch returns the raw handle and would pass
            // this assertion for the wrong reason).
            shard.repeatsOfFirst = 1;

            await shard.fetch(userRequest("probe:query"));

            const first = [...shard.handlesSeen];

            expect(first).toHaveLength(3);
            expect(new Set(first).size).toBe(1);

            shard.handlesSeen = [];
            await shard.fetch(userRequest("probe:query"));

            // A new dispatch folds into a new samples map, so it gets its own
            // handle — the memo re-reads the catalog once per dispatch, not once
            // per storage call.
            expect(shard.handlesSeen[0]).not.toBe(first[0]);
        } finally {
            database.close();
        }
    });
});
