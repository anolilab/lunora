/**
 * Real-workerd check of the alarm re-arm breaker's durable window
 * (alarm-rearm-breaker.ts). The mocks suite proves the window math and the alarm
 * loop against `node:sqlite`, which is not workerd's SQLite (it builds without
 * the same double-quote handling). This file runs the window's DDL, read and
 * upsert on the real `state.storage.sql`, and the budget loop on top of it.
 *
 * Like every file in this directory it only runs with `LUNORA_WORKERD_TESTS=1`.
 */
import type { ShardSqlExec } from "@lunora/platform";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { RearmWindow } from "../../src/alarm-rearm-breaker";
import { admitRearm, ensureRearmWindowTable, readRearmWindow, writeRearmWindow } from "../../src/alarm-rearm-breaker";

const NOW = 1_700_000_000_000;
const LIMIT = 300;

describe("alarm re-arm breaker window on real workerd SQLite", () => {
    it("persists the window and admits exactly the limit across wakes", async () => {
        expect.assertions(3);

        const stub = env.SHARD.get(env.SHARD.idFromName("alarm-rearm-breaker"));

        await runInDurableObject(stub, async (_instance, state) => {
            const sql = state.storage.sql as unknown as ShardSqlExec;

            ensureRearmWindowTable(sql);
            ensureRearmWindowTable(sql);

            expect(readRearmWindow(sql)).toBeUndefined();

            let window: RearmWindow | undefined;
            let admitted = 0;

            // Each wake reads the persisted window and writes it back, as the shard does.
            for (let wake = 0; wake < LIMIT + 50; wake += 1) {
                const result = admitRearm(readRearmWindow(sql), NOW, LIMIT);

                writeRearmWindow(sql, result.window);

                if (result.admitted) {
                    admitted += 1;
                }

                window = result.window;
            }

            expect(admitted).toBe(LIMIT);
            expect(readRearmWindow(sql)).toStrictEqual(window);
        });
    });

    it("counts one engine row written per window upsert, on the first insert and every conflict-update after", async () => {
        expect.assertions(3);

        const stub = env.SHARD.get(env.SHARD.idFromName("alarm-rearm-breaker-cost"));

        await runInDurableObject(stub, async (_instance, state) => {
            const sql = state.storage.sql as unknown as ShardSqlExec;

            ensureRearmWindowTable(sql);

            // The first write inserts the row; each later one is an ON CONFLICT update of that same row.
            const first = writeRearmWindow(sql, { currentCount: 1, previousCount: 0, windowStart: NOW });
            const second = writeRearmWindow(sql, { currentCount: 2, previousCount: 0, windowStart: NOW });

            let tenHealthy = 0;

            for (let rearm = 3; rearm <= 12; rearm += 1) {
                tenHealthy += writeRearmWindow(sql, { currentCount: rearm, previousCount: 0, windowStart: NOW }) ?? 0;
            }

            expect(first).toBe(1);
            expect(second).toBe(1);
            expect(tenHealthy).toBe(10);
        });
    });
});
