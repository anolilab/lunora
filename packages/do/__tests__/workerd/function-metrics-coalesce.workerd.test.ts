/**
 * Real-workerd verification of the coalesced function/query metric writes.
 *
 * Drives successful, coalesced (interval 3), errored and statement-sampled
 * dispatches through a `ShardDO` running over a Durable Object's own SQLite and
 * asserts the persisted `__lunora_metrics*` rows, including the latency
 * percentile of a coalesced batch that mixes fast and slow dispatches.
 *
 * Like every file in this directory, this only runs with `LUNORA_WORKERD_TESTS=1`.
 */
import { readFunctionMetrics, readQueryInsights, readQueryMetrics } from "@lunora/observability";
import type { SqlExec } from "@lunora/shard-engine";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ShardDOState } from "../../src/shard-do";
import { ShardDO } from "../../src/shard-do";

const START = 700 * 60_000 + 1000;
const clock = { latency: 0, now: START };

class MetricsShard extends ShardDO {
    public override async handleRpc(functionPath: string): Promise<unknown> {
        if (functionPath === "probe:query") {
            (this.sql as SqlExec).exec("SELECT 1 AS x").toArray();
        }

        if (functionPath === "probe:boom") {
            throw new Error("boom");
        }

        return { ok: true };
    }
}

const rpc = (functionPath: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

/** Wraps the DO state so every `storage.sql.exec` first advances the fake clock by `clock.latency`. */
const timedState = (state: DurableObjectState): ShardDOState => {
    const sql = new Proxy(state.storage.sql, {
        get(target, property) {
            if (property === "exec") {
                return (query: string, ...params: unknown[]) => {
                    clock.now += clock.latency;

                    return target.exec(query, ...params);
                };
            }

            const value = Reflect.get(target, property, target) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    const storage = new Proxy(state.storage, {
        get(target, property) {
            if (property === "sql") {
                return sql;
            }

            const value = Reflect.get(target, property, target) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    });

    return new Proxy(state, {
        get(target, property) {
            if (property === "storage") {
                return storage;
            }

            const value = Reflect.get(target, property, target) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as unknown as ShardDOState;
};

describe("coalesced metric writes under real workerd", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("persists exact function rows and per-dispatch query latency across coalesced, errored and sampled dispatches", async () => {
        expect.assertions(6);

        clock.now = START;
        clock.latency = 0;
        vi.spyOn(Date, "now").mockImplementation(() => clock.now);

        const stub = env.COUNTER.get(env.COUNTER.idFromName(`metrics-coalesce-${crypto.randomUUID()}`));

        await runInDurableObject(stub, async (_instance, state) => {
            const shard = new MetricsShard(timedState(state), { LUNORA_METRICS_FLUSH_EVERY: "3" });
            const sql = state.storage.sql as unknown as SqlExec;

            // Two dispatches stay pending; the third flushes the interval.
            await shard.fetch(rpc("probe:ok"));
            await shard.fetch(rpc("probe:ok"));

            expect(readFunctionMetrics(sql)).toEqual([]);

            await shard.fetch(rpc("probe:ok"));

            expect(readFunctionMetrics(sql)).toMatchObject([{ calls: 3, errors: 0, path: "probe:ok" }]);

            // An errored dispatch flushes at once with the whole pending delta.
            await shard.fetch(rpc("probe:ok"));
            await shard.fetch(rpc("probe:boom"));

            const rows = readFunctionMetrics(sql);

            expect(rows.find((row) => row.path === "probe:ok")?.calls).toBe(4);
            expect(rows.find((row) => row.path === "probe:boom")).toMatchObject({ calls: 1, errors: 1, lastErrorMessage: "boom" });

            // Statement-sampled: 5 fast dispatches and 1 slow one, coalesced (interval 3 -> two flushes).
            for (let index = 0; index < 6; index += 1) {
                clock.latency = index === 5 ? 1000 : 1;
                // eslint-disable-next-line no-await-in-loop -- sequential dispatches
                await shard.fetch(rpc("probe:query"));
            }

            clock.latency = 0;

            const selects = readQueryMetrics(sql).filter((entry) => entry.normalizedSql === "SELECT ? AS x");

            expect(selects).toMatchObject([{ execCount: 6 }]);
            // The 1000ms execution stays in its own bucket: a flush averaging it with two 1ms ones would read p95 as 500.
            expect(readQueryInsights(sql, 3_600_000, clock.now).entries.find((entry) => entry.normalizedSql === "SELECT ? AS x")?.p95DurationMs).toBe(1000);
        });
    }, 30_000);
});
