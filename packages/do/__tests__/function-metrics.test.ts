import { ConflictError,SCAN_DEP } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import {
    FUNCTION_METRICS_BUCKET_MS,
    FUNCTION_METRICS_BUCKETS_TABLE,
    FUNCTION_METRICS_INDEX_TABLE,
    FUNCTION_METRICS_MAX_PATHS,
    FUNCTION_METRICS_READ_LIMIT,
    FUNCTION_METRICS_SCANS_TABLE,
    FUNCTION_METRICS_TABLE,
    readFunctionMetricBuckets,
    readFunctionMetricIndexHits,
    readFunctionMetrics,
    readFunctionMetricScans,
    readFunctionMetricsTotals,
    recordFunctionMetric,
} from "../src/function-metrics";
import type { FunctionCallStat } from "../src/introspect";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

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

/**
 * A shard that simulates a full-table scan during dispatch by driving the base
 * class's ctx-db read hook with the `SCAN_DEP` sentinel — the same signal
 * `ctx-db.ts` emits for an unindexed read. `feed:list` scans `posts`; every
 * other path is treated as fully indexed (no scan stamped).
 */
class ScanningShard extends ShardDO {
    public override async handleRpc(functionPath: string): Promise<unknown> {
        if (functionPath === "feed:list") {
            const onRead = this.getCtxDbReadHook();

            // Stamp a full scan of `posts` with the explicit `SCAN_DEP` sentinel —
            // exactly what `ctx-db.ts` emits for an unindexed read.
            onRead("posts", SCAN_DEP);
            // A predicated (indexed) `findMany` stamps the table with NO id marker
            // before its per-row reads — this must NOT be attributed as a scan.
            onRead("comments");
            // An indexed point read of `users` must NOT count as a scan.
            onRead("users", "user-1");
        }

        return { ok: true };
    }
}

/**
 * A shard whose `handleRpc` raises a {@link ConflictError}: `occ:bump` throws an
 * optimistic-concurrency conflict (the contention signal counted as a write
 * conflict), `unique:insert` throws a unique-constraint breach (a 409 that is
 * NOT contention and must not advance the conflict counter).
 */
class ConflictingShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; routes by functionPath only
    public override async handleRpc(functionPath: string): Promise<unknown> {
        if (functionPath === "occ:bump") {
            throw new ConflictError(`optimistic concurrency conflict on "counters"`, "occ");
        }

        if (functionPath === "unique:insert") {
            throw new ConflictError(`unique constraint violation on "users"`, "unique");
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

    it("counts OCC write conflicts as a subset of errors", () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            recordFunctionMetric(database.sql, { durationMs: 5, errored: false, path: "counters:bump", ts: 1000 });
            recordFunctionMetric(database.sql, { conflicted: true, durationMs: 5, errored: true, errorMessage: "occ", path: "counters:bump", ts: 2000 });
            recordFunctionMetric(database.sql, { conflicted: true, durationMs: 5, errored: true, errorMessage: "occ", path: "counters:bump", ts: 3000 });

            const [row] = readFunctionMetrics(database.sql) as [FunctionCallStat];

            expect(row.calls).toBe(3);
            // Conflicts are a subset of errors (every conflict also threw).
            expect(row.errors).toBe(2);
            expect(row.conflicts).toBe(2);
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

    it("attributes full scans per (function, table) and folds the aggregate into the row", () => {
        expect.assertions(5);

        const database = createSqliteExec();

        try {
            // `feed:list` scans `posts` twice and `tags` once; `users:get` is fully indexed.
            recordFunctionMetric(database.sql, { durationMs: 50, errored: false, path: "feed:list", scannedTables: ["posts", "tags"], ts: 1000 });
            recordFunctionMetric(database.sql, { durationMs: 60, errored: false, path: "feed:list", scannedTables: ["posts"], ts: 2000 });
            recordFunctionMetric(database.sql, { durationMs: 5, errored: false, path: "users:get", ts: 3000 });

            const byPath = new Map(readFunctionMetrics(database.sql).map((stat) => [stat.path, stat]));

            // Aggregate scan total = 3 distinct (call, table) scans for feed:list, 0 for users:get.
            expect(byPath.get("feed:list")).toMatchObject({ scans: 3 });
            expect(byPath.get("users:get")).toMatchObject({ scannedTables: [], scans: 0 });

            // Per-table attribution, busiest scan first.
            expect(byPath.get("feed:list")?.scannedTables).toEqual([
                { scans: 2, table: "posts" },
                { scans: 1, table: "tags" },
            ]);

            // The grouped read mirrors the same shape.
            expect(readFunctionMetricScans(database.sql).get("feed:list")).toEqual([
                { scans: 2, table: "posts" },
                { scans: 1, table: "tags" },
            ]);

            // Physical upsert, not append: one row per (path, table).
            expect(database.raw(`SELECT path, table_name, scans FROM "${FUNCTION_METRICS_SCANS_TABLE}" ORDER BY table_name`)).toEqual([
                { path: "feed:list", scans: 2, table_name: "posts" },
                { path: "feed:list", scans: 1, table_name: "tags" },
            ]);
        } finally {
            database.close();
        }
    });

    it("dedupes a table scanned twice within one dispatch to a single attributed scan", () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            recordFunctionMetric(database.sql, { durationMs: 10, errored: false, path: "f:a", scannedTables: ["posts", "posts"], ts: 1000 });

            const [stat] = readFunctionMetrics(database.sql) as [FunctionCallStat];

            expect(stat.scans).toBe(1);
            expect(stat.scannedTables).toEqual([{ scans: 1, table: "posts" }]);
        } finally {
            database.close();
        }
    });

    it("counts per-(table, index) hits across dispatches and reads them back", () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            // `feed:list` uses messages.byChannel twice and users.byEmail once.
            recordFunctionMetric(database.sql, {
                durationMs: 5,
                errored: false,
                indexHits: [
                    { index: "byChannel", table: "messages" },
                    { index: "byEmail", table: "users" },
                ],
                path: "feed:list",
                ts: 1000,
            });
            recordFunctionMetric(database.sql, {
                durationMs: 5,
                errored: false,
                indexHits: [{ index: "byChannel", table: "messages" }],
                path: "feed:list",
                ts: 2000,
            });

            // Ordered by table then index; reads accumulate per (table, index).
            expect(readFunctionMetricIndexHits(database.sql)).toEqual([
                { index: "byChannel", reads: 2, table: "messages" },
                { index: "byEmail", reads: 1, table: "users" },
            ]);

            // Physical upsert: one row per (table, index).
            expect(database.raw(`SELECT table_name, index_name, reads FROM "${FUNCTION_METRICS_INDEX_TABLE}" ORDER BY table_name`)).toEqual([
                { index_name: "byChannel", reads: 2, table_name: "messages" },
                { index_name: "byEmail", reads: 1, table_name: "users" },
            ]);
        } finally {
            database.close();
        }
    });

    it("dedupes an index used twice within one dispatch to a single hit", () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            recordFunctionMetric(database.sql, {
                durationMs: 5,
                errored: false,
                indexHits: [
                    { index: "byChannel", table: "messages" },
                    { index: "byChannel", table: "messages" },
                ],
                path: "f:a",
                ts: 1000,
            });

            expect(readFunctionMetricIndexHits(database.sql)).toEqual([{ index: "byChannel", reads: 1, table: "messages" }]);
        } finally {
            database.close();
        }
    });

    it("returns empty reads on a never-called shard without throwing", () => {
        expect.assertions(5);

        const database = createSqliteExec();

        try {
            expect(readFunctionMetrics(database.sql)).toEqual([]);
            expect(readFunctionMetricBuckets(database.sql)).toEqual([]);
            expect(readFunctionMetricScans(database.sql).size).toBe(0);
            expect(readFunctionMetricIndexHits(database.sql)).toEqual([]);
            expect(readFunctionMetricsTotals(database.sql)).toEqual({ errors: 0, requests: 0 });
        } finally {
            database.close();
        }
    });

    it("caps distinct paths so an unregistered-path flood can't grow the table unbounded", () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            // Fill the accumulator to its distinct-path cap.
            for (let index = 0; index < FUNCTION_METRICS_MAX_PATHS; index += 1) {
                recordFunctionMetric(database.sql, { durationMs: 1, errored: false, path: `fn:${String(index)}`, ts: 1000 });
            }

            // A brand-new path past the cap is dropped; an already-tracked path
            // keeps accumulating.
            recordFunctionMetric(database.sql, { durationMs: 1, errored: false, path: "fn:flood-1", ts: 2000 });
            recordFunctionMetric(database.sql, { durationMs: 1, errored: false, path: "fn:0", ts: 2000 });

            const total = database.raw(`SELECT COUNT(*) AS c FROM "${FUNCTION_METRICS_TABLE}"`)[0] as { c: number };
            const tracked = database.raw(`SELECT calls AS c FROM "${FUNCTION_METRICS_TABLE}" WHERE path = 'fn:0'`)[0] as { c: number };

            expect(total.c).toBe(FUNCTION_METRICS_MAX_PATHS);
            expect(tracked.c).toBe(2);
        } finally {
            database.close();
        }
    });

    it("bounds readFunctionMetrics with a LIMIT so a bloated table can't blow up DO memory", () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            for (let index = 0; index < FUNCTION_METRICS_READ_LIMIT + 50; index += 1) {
                recordFunctionMetric(database.sql, { durationMs: 1, errored: false, path: `fn:${String(index)}`, ts: 1000 + index });
            }

            expect(readFunctionMetrics(database.sql)).toHaveLength(FUNCTION_METRICS_READ_LIMIT);
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
            const shard = new CountingShard(makeState(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

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

    it("counts only OCC conflicts through fetch — a unique-violation 409 is an error but not a conflict", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const shard = new ConflictingShard(makeState(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            // Two OCC conflicts and one unique-constraint breach — all 409s, all
            // errors; only the OCC pair is write contention.
            await shard.fetch(userRequest("occ:bump"));
            await shard.fetch(userRequest("occ:bump"));
            await shard.fetch(userRequest("unique:insert"));

            const response = await shard.fetch(adminRequest("__lunora_admin__:getFunctionStats"));
            const body = await response.json<{ result: { functions: FunctionCallStat[] } }>();
            const byPath = new Map(body.result.functions.map((s) => [s.path, s]));

            expect(byPath.get("occ:bump")).toMatchObject({ calls: 2, conflicts: 2, errors: 2 });
            // The unique-violation dispatch errored but is NOT counted as contention.
            expect(byPath.get("unique:insert")).toMatchObject({ calls: 1, conflicts: 0, errors: 1 });
        } finally {
            database.close();
        }
    });

    it("attributes a dispatch's full scans through fetch and surfaces them via getFunctionStats", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            const shard = new ScanningShard(makeState(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            // Two scanning dispatches of `feed:list`, one fully-indexed `users:get`.
            await shard.fetch(userRequest("feed:list"));
            await shard.fetch(userRequest("feed:list"));
            await shard.fetch(userRequest("users:get"));

            const response = await shard.fetch(adminRequest("__lunora_admin__:getFunctionStats"));
            const body = await response.json<{ result: { functions: FunctionCallStat[]; sinceMs: number } }>();
            const byPath = new Map(body.result.functions.map((s) => [s.path, s]));

            // feed:list full-scanned `posts` once per dispatch → 2 attributed scans;
            // the indexed `users` point read never counts.
            expect(byPath.get("feed:list")).toMatchObject({ calls: 2, scans: 2 });
            expect(byPath.get("feed:list")?.scannedTables).toEqual([{ scans: 2, table: "posts" }]);
            expect(byPath.get("users:get")).toMatchObject({ scannedTables: [], scans: 0 });
        } finally {
            database.close();
        }
    });

    it("counts success vs error and surfaces them through getFunctionStats", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const shard = new CountingShard(makeState(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            await shard.fetch(userRequest("messages:list"));
            await shard.fetch(userRequest("messages:list"));
            await shard.fetch(userRequest("boom:explode"));

            const response = await shard.fetch(adminRequest("__lunora_admin__:getFunctionStats"));
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
            const first = new CountingShard(makeState(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            await first.fetch(userRequest("messages:list"));
            await first.fetch(userRequest("boom:explode"));

            // A brand-new instance over the SAME storage — its in-memory counters
            // start at zero, so anything it reports must come from the durable table.
            const second = new CountingShard(makeState(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            const metricsResponse = await second.fetch(adminRequest("__lunora_admin__:getMetrics"));
            const metrics = await metricsResponse.json<{
                result: { errors: number; functions: FunctionCallStat[]; history: unknown[]; requests: number };
            }>();

            // Durable totals survived the restart.
            expect(metrics.result.requests).toBe(2);
            expect(metrics.result.errors).toBe(1);
            // Per-function rows + history are surfaced additively.
            expect(metrics.result.functions).toHaveLength(2);
            expect(metrics.result.history.length).toBeGreaterThan(0);

            const statsResponse = await second.fetch(adminRequest("__lunora_admin__:getFunctionStats"));
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
            const shard = new CountingShard(makeState(database), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            await shard.fetch(userRequest("messages:list"));
            await shard.fetch(userRequest("boom:explode"));

            const response = await shard.fetch(adminRequest("__lunora_admin__:getMetrics"));
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
