import { describe, expect, it } from "vitest";

import {
    FUNCTION_METRICS_BUCKET_MS,
    FUNCTION_METRICS_BUCKETS_TABLE,
    FUNCTION_METRICS_TABLE,
    readFunctionMetricBuckets,
    readFunctionMetrics,
    readFunctionMetricsTotals,
    recordFunctionMetric,
} from "../src/function-metrics.js";
import type { FunctionCallStat } from "../src/introspect.js";
import type { ShardDOState } from "../src/shard-do.js";
import { ShardDO } from "../src/shard-do.js";
import createSqliteExec from "./_helpers/node-sqlite.js";

const ADMIN_TOKEN = "metrics-admin";

/** A shard whose `handleRpc` fails for one marked path, driving success/error counters through `fetch`. */
class CountingShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; routes by functionPath only
    public override async handleRpc(functionPath: string): Promise<unknown> {
        if (functionPath === "boom:explode") {
            throw new Error("boom");
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

const adminRequest = (functionPath: string, token: string = ADMIN_TOKEN): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        method: "POST",
    });

describe("function-metrics module", () => {
    it("creates the metrics tables and accumulates an upsert per call", () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            recordFunctionMetric(database.sql, { durationMs: 10, errored: false, path: "messages:list", ts: 1000 });
            recordFunctionMetric(database.sql, { durationMs: 30, errored: false, path: "messages:list", ts: 2000 });

            const rows = readFunctionMetrics(database.sql);

            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                calls: 2,
                errors: 0,
                maxDurationMs: 30,
                path: "messages:list",
                totalDurationMs: 40,
            });

            // One physical row per path (it is a real upsert, not an append).
            expect(database.raw(`SELECT COUNT(*) AS c FROM "${FUNCTION_METRICS_TABLE}"`)[0]).toEqual({ c: 1 });
        } finally {
            database.close();
        }
    });

    it("counts errors separately and records the last error message", () => {
        expect.assertions(4);

        const database = createSqliteExec();

        try {
            recordFunctionMetric(database.sql, { durationMs: 5, errored: false, path: "f:a", ts: 1000 });
            recordFunctionMetric(database.sql, { durationMs: 5, errored: true, errorMessage: "kaboom", path: "f:a", ts: 2000 });
            // A later success must NOT clear the most recent error.
            recordFunctionMetric(database.sql, { durationMs: 5, errored: false, path: "f:a", ts: 3000 });

            const [row] = readFunctionMetrics(database.sql) as [FunctionCallStat];

            expect(row.calls).toBe(3);
            expect(row.errors).toBe(1);
            expect(row.lastErrorMessage).toBe("kaboom");
            expect(row.lastErrorAt).toBe(2000);
        } finally {
            database.close();
        }
    });

    it("buckets a coarse time series and reports lifetime totals", () => {
        expect.assertions(4);

        const database = createSqliteExec();

        try {
            const base = 5 * FUNCTION_METRICS_BUCKET_MS;

            recordFunctionMetric(database.sql, { durationMs: 1, errored: false, path: "f:a", ts: base });
            recordFunctionMetric(database.sql, { durationMs: 1, errored: true, errorMessage: "x", path: "f:a", ts: base + 1 });
            recordFunctionMetric(database.sql, { durationMs: 1, errored: false, path: "f:a", ts: base + FUNCTION_METRICS_BUCKET_MS });

            const buckets = readFunctionMetricBuckets(database.sql, "f:a");

            // Two distinct minute windows.
            expect(buckets).toHaveLength(2);
            expect(buckets[0]).toEqual({ bucketMs: base, calls: 2, errors: 1, path: "f:a" });
            expect(buckets[1]).toEqual({ bucketMs: base + FUNCTION_METRICS_BUCKET_MS, calls: 1, errors: 0, path: "f:a" });

            expect(readFunctionMetricsTotals(database.sql)).toEqual({ errors: 1, requests: 3 });
        } finally {
            database.close();
        }
    });

    it("returns empty reads on a never-called shard without throwing", () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            expect(readFunctionMetrics(database.sql)).toEqual([]);
            expect(readFunctionMetricBuckets(database.sql)).toEqual([]);
            expect(readFunctionMetricsTotals(database.sql)).toEqual({ errors: 0, requests: 0 });
        } finally {
            database.close();
        }
    });
});

describe("shardDO persisted metrics", () => {
    const makeState = (database: ReturnType<typeof createSqliteExec>): ShardDOState => {
        const state: ShardDOState = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };

        return state;
    };

    it("persists a metrics row on each RPC completion", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const shard = new CountingShard(makeState(database), { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

            await shard.fetch(userRequest("messages:list"));

            // The durable table holds the row even though we read raw SQL, not the DO.
            const rows = database.raw(`SELECT path, calls, errors FROM "${FUNCTION_METRICS_TABLE}"`);

            expect(rows).toEqual([{ calls: 1, errors: 0, path: "messages:list" }]);

            const buckets = database.raw(`SELECT COUNT(*) AS c FROM "${FUNCTION_METRICS_BUCKETS_TABLE}"`);

            expect(buckets[0]).toEqual({ c: 1 });
        } finally {
            database.close();
        }
    });

    it("counts success vs error and surfaces them through getFunctionStats", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const shard = new CountingShard(makeState(database), { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

            await shard.fetch(userRequest("messages:list"));
            await shard.fetch(userRequest("messages:list"));
            await shard.fetch(userRequest("boom:explode"));

            const response = await shard.fetch(adminRequest("__cirrus_admin__:getFunctionStats"));
            const body = await response.json<{ result: { functions: FunctionCallStat[]; sinceMs: number } }>();
            const byPath = new Map(body.result.functions.map((s) => [s.path, s]));

            expect(byPath.get("messages:list")).toMatchObject({ calls: 2, errors: 0, lastErrorMessage: null });
            expect(byPath.get("boom:explode")).toMatchObject({ calls: 1, errors: 1, lastErrorMessage: "boom" });
        } finally {
            database.close();
        }
    });

    it("survives a simulated restart: a fresh DO instance over the same storage sees prior counts", async () => {
        expect.assertions(6);

        const database = createSqliteExec();

        try {
            // First instance records two calls, then is "lost" (hibernation/restart).
            const first = new CountingShard(makeState(database), { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

            await first.fetch(userRequest("messages:list"));
            await first.fetch(userRequest("boom:explode"));

            // A brand-new instance over the SAME storage — its in-memory counters
            // start at zero, so anything it reports must come from the durable table.
            const second = new CountingShard(makeState(database), { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

            const metricsResponse = await second.fetch(adminRequest("__cirrus_admin__:getMetrics"));
            const metrics = await metricsResponse.json<{
                result: { errors: number; functions: FunctionCallStat[]; history: unknown[]; requests: number };
            }>();

            // Durable totals survived the restart.
            expect(metrics.result.requests).toBe(2);
            expect(metrics.result.errors).toBe(1);
            // Per-function rows + history are surfaced additively.
            expect(metrics.result.functions).toHaveLength(2);
            expect(metrics.result.history.length).toBeGreaterThan(0);

            const statsResponse = await second.fetch(adminRequest("__cirrus_admin__:getFunctionStats"));
            const stats = await statsResponse.json<{ result: { functions: FunctionCallStat[] } }>();
            const byPath = new Map(stats.result.functions.map((s) => [s.path, s]));

            expect(byPath.get("messages:list")).toMatchObject({ calls: 1, errors: 0 });
            expect(byPath.get("boom:explode")).toMatchObject({ calls: 1, errors: 1, lastErrorMessage: "boom" });
        } finally {
            database.close();
        }
    });

    it("keeps getMetrics backward-compatible (requests/errors still present)", async () => {
        expect.assertions(4);

        const database = createSqliteExec();

        try {
            const shard = new CountingShard(makeState(database), { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

            await shard.fetch(userRequest("messages:list"));
            await shard.fetch(userRequest("boom:explode"));

            const response = await shard.fetch(adminRequest("__cirrus_admin__:getMetrics"));
            const body = await response.json<{ result: { cache: unknown; errors: number; requests: number; shard: string } }>();

            expect(body.result.requests).toBe(2);
            expect(body.result.errors).toBe(1);
            expect(body.result.cache).toBeNull();
            expect(body.result.shard).toBeTypeOf("string");
        } finally {
            database.close();
        }
    });
});
