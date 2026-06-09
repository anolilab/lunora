import { describe, expect, it } from "vitest";

import {
    AUTH_METRICS_BUCKET_MS,
    AUTH_METRICS_BUCKETS_TABLE,
    AUTH_METRICS_TABLE,
    ensureAuthMetricsTables,
    readAuthMetrics,
    recordAuthEvent,
} from "../src/auth-metrics";
import createSqliteExec from "./_helpers/node-sqlite";

describe("auth-metrics module", () => {
    it("creates the tables and accumulates attempts and failures in one row", () => {
        expect.assertions(4);

        const database = createSqliteExec();

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

        const database = createSqliteExec();

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

        const database = createSqliteExec();

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

    it("returns an all-zero shape on a never-authenticated app without throwing", () => {
        expect.assertions(1);

        const database = createSqliteExec();

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

        const database = createSqliteExec();

        try {
            ensureAuthMetricsTables(database.sql);
            ensureAuthMetricsTables(database.sql);
            recordAuthEvent(database.sql, { outcome: "fail", ts: 1000 });

            expect(readAuthMetrics(database.sql).failures).toBe(1);
        } finally {
            database.close();
        }
    });
});
