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
import { readQueryMetrics } from "@lunora/observability";
import type { SqlExec } from "@lunora/shard-engine";
import { ADMIN_FUNCTIONS } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

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

    public repeatsOfFirst = 0;

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
