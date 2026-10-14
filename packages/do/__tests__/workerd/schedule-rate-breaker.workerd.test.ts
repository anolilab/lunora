/**
 * Real-workerd check of the schedule-rate breaker (schedule-rate-breaker.ts). The mocks
 * suite proves the per-target window and the loop against `node:sqlite`, which is not
 * workerd's SQLite. This file runs the window's DDL, per-target read and upsert on the real
 * `state.storage.sql`, and the shard's own admission hook on top of it, with the default
 * budget.
 *
 * Like every file in this directory it only runs with `LUNORA_WORKERD_TESTS=1`.
 */
import type { ShardSqlExec } from "@lunora/platform";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { admitRearm } from "../../src/alarm-rearm-breaker";
import { DEFAULT_SCHEDULE_RATE_LIMIT, ensureScheduleRateTable, readScheduleRateWindow, writeScheduleRateWindow } from "../../src/schedule-rate-breaker";

const NOW = 1_700_000_000_000;

describe("schedule-rate window on real workerd SQLite", () => {
    it("keeps one window per target and persists each across reads", async () => {
        expect.assertions(3);

        const stub = env.SHARD.get(env.SHARD.idFromName("schedule-rate-window"));

        await runInDurableObject(stub, async (_instance, state) => {
            const sql = state.storage.sql as unknown as ShardSqlExec;

            ensureScheduleRateTable(sql);
            ensureScheduleRateTable(sql);

            expect(readScheduleRateWindow(sql, "messages:send")).toBeUndefined();

            writeScheduleRateWindow(sql, "messages:send", { currentCount: 7, previousCount: 2, windowStart: NOW });
            writeScheduleRateWindow(sql, "reports:build", { currentCount: 1, previousCount: 0, windowStart: NOW });
            writeScheduleRateWindow(sql, "messages:send", { currentCount: 9, previousCount: 2, windowStart: NOW });

            expect(readScheduleRateWindow(sql, "messages:send")).toStrictEqual({ currentCount: 9, previousCount: 2, windowStart: NOW });
            expect(readScheduleRateWindow(sql, "reports:build")).toStrictEqual({ currentCount: 1, previousCount: 0, windowStart: NOW });
        });
    });

    it("admits the default budget per target on the real engine, then defers", async () => {
        expect.assertions(2);

        const stub = env.SHARD.get(env.SHARD.idFromName("schedule-rate-admit"));

        await runInDurableObject(stub, async (_instance, state) => {
            const sql = state.storage.sql as unknown as ShardSqlExec;

            ensureScheduleRateTable(sql);

            // Every call lands in the one window, since `NOW` does not move.
            let admitted = 0;

            for (let call = 0; call < DEFAULT_SCHEDULE_RATE_LIMIT + 5; call += 1) {
                const result = admitRearm(readScheduleRateWindow(sql, "loop:self"), NOW, DEFAULT_SCHEDULE_RATE_LIMIT);

                writeScheduleRateWindow(sql, "loop:self", result.window);

                if (result.admitted) {
                    admitted += 1;
                }
            }

            // The budget of the window, then every further invocation is refused.
            expect(admitted).toBe(DEFAULT_SCHEDULE_RATE_LIMIT);

            // A second target starts with its own full budget.
            const other = admitRearm(readScheduleRateWindow(sql, "reports:build"), NOW, DEFAULT_SCHEDULE_RATE_LIMIT);

            expect(other.admitted).toBe(true);
        });
    });
});
