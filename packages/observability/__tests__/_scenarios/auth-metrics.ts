import { describe, expect, it, vi } from "vitest";

import {
    AUTH_METRICS_BUCKET_MS,
    AUTH_METRICS_BUCKET_RETENTION,
    AUTH_METRICS_BUCKETS_TABLE,
    AUTH_METRICS_TABLE,
    ensureAuthMetricsTables,
    readAuthMetrics,
    recordAuthEvent,
} from "../../src/auth-metrics";
import { readFunctionMetricBuckets, recordFunctionMetric } from "../../src/function-metrics";
import type { SqlHarness } from "../_helpers/sql-harness";

/** The harness factory of the project running this scenario — see {@link runAuthMetricsScenarios}. */
let createHarness: () => SqlHarness;

/**
 * The `auth-metrics` suite, over whichever SQLite the caller's harness opens:
 * `node:sqlite` from `../auth-metrics.test.ts`, a Durable Object's `state.storage.sql`
 * from `../workerd/auth-metrics.workerd.test.ts`.
 */
const runAuthMetricsScenarios = (factory: () => SqlHarness): void => {
    createHarness = factory;

    describe("auth-metrics module", () => {
        it("creates the tables and accumulates attempts and failures in one row", () => {
            expect.assertions(4);

            const database = createHarness();

            try {
                recordAuthEvent(database.sql, { outcome: "ok", ts: 1000 });
                recordAuthEvent(database.sql, { outcome: "fail", ts: 2000 });
                recordAuthEvent(database.sql, { outcome: "ok", ts: 3000 });

                const metrics = readAuthMetrics(database.sql);

                expect(metrics.attempts).toBe(3);
                expect(metrics.failures).toBe(1);
                // `since_ms` pins to the first attempt and never moves.
                expect(metrics.sinceMs).toBe(1000);

                // One physical accumulator row (a real upsert, not an append).
                expect(database.raw(`SELECT COUNT(*) AS c FROM "${AUTH_METRICS_TABLE}"`)[0]).toEqual({ c: 1 });
            } finally {
                database.close();
            }
        });

        it("derives failureRate as failures / attempts", () => {
            expect.assertions(2);

            const database = createHarness();

            try {
                // 1 failure out of 4 attempts ⇒ 0.25.
                recordAuthEvent(database.sql, { outcome: "ok", ts: 1000 });
                recordAuthEvent(database.sql, { outcome: "fail", ts: 1001 });
                recordAuthEvent(database.sql, { outcome: "ok", ts: 1002 });
                recordAuthEvent(database.sql, { outcome: "ok", ts: 1003 });

                const metrics = readAuthMetrics(database.sql);

                expect(metrics.attempts).toBe(4);
                expect(metrics.failureRate).toBe(0.25);
            } finally {
                database.close();
            }
        });

        it("buckets a coarse minute-resolution time series", () => {
            expect.assertions(4);

            const database = createHarness();

            try {
                const base = 5 * AUTH_METRICS_BUCKET_MS;

                recordAuthEvent(database.sql, { outcome: "ok", ts: base });
                recordAuthEvent(database.sql, { outcome: "fail", ts: base + 1 });
                recordAuthEvent(database.sql, { outcome: "ok", ts: base + AUTH_METRICS_BUCKET_MS });

                const { history } = readAuthMetrics(database.sql);

                // Two distinct minute windows, oldest first.
                expect(history).toHaveLength(2);
                expect(history[0]).toEqual({ attempts: 2, bucketMs: base, failures: 1 });
                expect(history[1]).toEqual({ attempts: 1, bucketMs: base + AUTH_METRICS_BUCKET_MS, failures: 0 });

                // Physical upsert, one row per bucket.
                expect(database.raw(`SELECT COUNT(*) AS c FROM "${AUTH_METRICS_BUCKETS_TABLE}"`)[0]).toEqual({ c: 2 });
            } finally {
                database.close();
            }
        });

        it("issues the retention delete once per bucket window", () => {
            expect.assertions(2);

            const database = createHarness();

            try {
                const execSpy = vi.spyOn(database.sql, "exec");
                const deletes = () => execSpy.mock.calls.filter(([query]) => typeof query === "string" && query.includes("DELETE")).length;

                recordAuthEvent(database.sql, { outcome: "ok", ts: 1000 });
                recordAuthEvent(database.sql, { outcome: "fail", ts: 2000 });

                // Same minute window: the second attempt skips the prune entirely.
                expect(deletes()).toBe(1);

                recordAuthEvent(database.sql, { outcome: "ok", ts: 1000 + AUTH_METRICS_BUCKET_MS });

                // An attempt in a later window prunes again.
                expect(deletes()).toBe(2);
            } finally {
                database.close();
            }
        });

        it("returns an all-zero shape on a never-authenticated app without throwing", () => {
            expect.assertions(1);

            const database = createHarness();

            try {
                expect(readAuthMetrics(database.sql)).toEqual({
                    attempts: 0,
                    failureRate: 0,
                    failures: 0,
                    history: [],
                    sinceMs: 0,
                });
            } finally {
                database.close();
            }
        });

        it("is idempotent: ensureAuthMetricsTables can run repeatedly", () => {
            expect.assertions(1);

            const database = createHarness();

            try {
                ensureAuthMetricsTables(database.sql);
                ensureAuthMetricsTables(database.sql);
                recordAuthEvent(database.sql, { outcome: "fail", ts: 1000 });

                expect(readAuthMetrics(database.sql).failures).toBe(1);
            } finally {
                database.close();
            }
        });

        it("a function path that is the empty string does not skip the auth trim", () => {
            expect.assertions(2);

            const database = createHarness();

            try {
                const stale = 0;
                const recent = AUTH_METRICS_BUCKET_MS * (AUTH_METRICS_BUCKET_RETENTION + 10);

                // Both recorders accumulate a stale bucket at the start of time.
                recordAuthEvent(database.sql, { outcome: "ok", ts: stale });
                recordFunctionMetric(database.sql, { durationMs: 10, errored: false, path: "", ts: stale });

                // The function recorder claims the recent window first. A shared empty-string key would make the auth trim skip.
                recordFunctionMetric(database.sql, { durationMs: 10, errored: false, path: "", ts: recent });
                recordAuthEvent(database.sql, { outcome: "ok", ts: recent });

                expect(readAuthMetrics(database.sql).history.map((bucket) => bucket.bucketMs)).toStrictEqual([recent]);
                expect(readFunctionMetricBuckets(database.sql, "").buckets.map((bucket) => bucket.bucketMs)).toStrictEqual([recent]);
            } finally {
                database.close();
            }
        });
    });
};

export default runAuthMetricsScenarios;
