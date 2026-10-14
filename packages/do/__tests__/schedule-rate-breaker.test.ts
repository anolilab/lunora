import type { ShardSqlExec } from "@lunora/platform";
import type { SchemaLike } from "@lunora/shard-engine";
import { runShardMigrations } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ALARM_REARM_WINDOW_MS, recoveryWakeAt } from "../src/alarm-rearm-breaker";
import { DEFAULT_SCHEDULE_RATE_LIMIT, SCHEDULE_RATE_LIMIT_KEY, SCHEDULE_RATE_TABLE, scheduleRateLimitFrom } from "../src/schedule-rate-breaker";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The schedule-rate breaker (schedule-rate-breaker.ts), driven through the shard's own
 * `scheduleOutbox().admit` hook: the same object the codegen facade receives, so these
 * tests cover the production wiring for the shard half. The facade half (one decision per
 * target per dispatch, deferral applied to the due time) lives in `@lunora/server`'s
 * deferred-schedules suite.
 */

const NOW = 1_700_000_000_000;
const WINDOW = ALARM_REARM_WINDOW_MS;
const SMALL_LIMIT = 20;

const schema: SchemaLike = { tables: { notes: { indexes: [], shape: { body: { kind: "string" } } } } };

let harness: ReturnType<typeof createSqliteExec>;

const makeState = (): ShardDOState =>
    ({
        acceptWebSocket() {
            /* no sockets in this test */
        },
        getWebSockets() {
            return [];
        },
        storage: {
            getAlarm: () => null,
            setAlarm: () => Promise.resolve(),
            sql: harness.sql,
        },
    }) as unknown as ShardDOState;

/** A bare shard. Only the schedule path is exercised, so RPC is unused. */
class TestShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- this shard exercises only the schedule-admission path; RPC is unused.
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve({ ok: true });
    }
}

type Admit = (target: string) => number | undefined;

/** The production outbox the codegen facade is handed, read through the same accessor the generated `buildCtx` uses. */
const admitOf = (shard: TestShard): Admit => {
    const outbox = (shard as unknown as { scheduleOutbox: () => { admit: Admit } }).scheduleOutbox();

    return (target) => outbox.admit(target);
};

const newShard = (env: Record<string, unknown> = {}): TestShard => new TestShard(makeState(), env);

describe("scheduleRateLimitFrom", () => {
    it("keeps the default when the variable is unset", () => {
        expect.assertions(1);

        expect(scheduleRateLimitFrom({})).toBe(DEFAULT_SCHEDULE_RATE_LIMIT);
    });

    it("disables the breaker on 0", () => {
        expect.assertions(1);

        expect(scheduleRateLimitFrom({ [SCHEDULE_RATE_LIMIT_KEY]: "0" })).toBeUndefined();
    });

    it("reads a positive integer, trimmed", () => {
        expect.assertions(1);

        expect(scheduleRateLimitFrom({ [SCHEDULE_RATE_LIMIT_KEY]: " 25 " })).toBe(25);
    });

    it.each(["abc", "-1", "1.5", ""])("keeps the default for a malformed value %j", (raw) => {
        expect.assertions(1);

        expect(scheduleRateLimitFrom({ [SCHEDULE_RATE_LIMIT_KEY]: raw })).toBe(DEFAULT_SCHEDULE_RATE_LIMIT);
    });
});

describe("schedule-rate admission on the shard", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    });

    afterEach(() => {
        vi.useRealTimers();
        harness.close();
        vi.restoreAllMocks();
    });

    it("admits up to the limit per target within a window, then defers to one window out", () => {
        // 20 admissions (SMALL_LIMIT) plus the two refusals.
        expect.assertions(22);

        const admit = admitOf(newShard({ [SCHEDULE_RATE_LIMIT_KEY]: String(SMALL_LIMIT) }));

        for (let index = 0; index < SMALL_LIMIT; index += 1) {
            expect(admit("messages:send")).toBeUndefined();
        }

        expect(admit("messages:send")).toBe(recoveryWakeAt(NOW));
        expect(admit("messages:send")).toBe(recoveryWakeAt(NOW));
    });

    it("keeps each target's budget separate", () => {
        expect.assertions(2);

        const admit = admitOf(newShard({ [SCHEDULE_RATE_LIMIT_KEY]: String(SMALL_LIMIT) }));

        for (let index = 0; index < SMALL_LIMIT; index += 1) {
            admit("messages:send");
        }

        expect(admit("messages:send")).toBeDefined();
        expect(admit("reports:build")).toBeUndefined();
    });

    it("admits again once the window has drained", () => {
        expect.assertions(2);

        const admit = admitOf(newShard({ [SCHEDULE_RATE_LIMIT_KEY]: String(SMALL_LIMIT) }));

        for (let index = 0; index < SMALL_LIMIT; index += 1) {
            admit("messages:send");
        }

        expect(admit("messages:send")).toBeDefined();

        vi.setSystemTime(NOW + 2 * WINDOW);

        expect(admit("messages:send")).toBeUndefined();
    });

    it("is a no-op when disabled, and writes no window row", () => {
        expect.assertions(2);

        const admit = admitOf(newShard({ [SCHEDULE_RATE_LIMIT_KEY]: "0" }));
        const answers = Array.from({ length: 1000 }, () => admit("messages:send"));

        expect(answers.filter((answer) => answer !== undefined)).toHaveLength(0);

        const rows = (harness.sql as unknown as ShardSqlExec)
            .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE name = '${SCHEDULE_RATE_TABLE}'`)
            .toArray();

        expect(rows).toHaveLength(0);
    });

    it("fails open when the window cannot be read", () => {
        expect.assertions(1);

        const shard = newShard({ [SCHEDULE_RATE_LIMIT_KEY]: String(SMALL_LIMIT) });
        const sql = shard as unknown as { shardHost: { sql: ShardSqlExec } };

        vi.spyOn(sql.shardHost.sql, "exec").mockImplementation(() => {
            throw new Error("storage fault");
        });

        expect(admitOf(shard)("messages:send")).toBeUndefined();
    });

    it("logs one error per trip and counts each deferral", () => {
        expect.assertions(3);

        const shard = newShard({ [SCHEDULE_RATE_LIMIT_KEY]: String(SMALL_LIMIT) });
        const spies = shard as unknown as {
            recordMetric: (...args: unknown[]) => unknown;
            recordUserLog: (...args: unknown[]) => unknown;
        };
        const log = vi.spyOn(spies, "recordUserLog");
        const metric = vi.spyOn(spies, "recordMetric");
        const admit = admitOf(shard);

        for (let index = 0; index < SMALL_LIMIT; index += 1) {
            admit("messages:send");
        }

        admit("messages:send");
        admit("messages:send");

        expect(log).toHaveBeenCalledTimes(1);
        expect(metric).toHaveBeenCalledTimes(2);
        expect(metric).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "counter", name: "shard.schedule_rate.deferred", value: 1 }), undefined);
    });

    it("logs at most once per window while steady load alternates admits and refusals", () => {
        expect.assertions(5);

        const shard = newShard({ [SCHEDULE_RATE_LIMIT_KEY]: String(SMALL_LIMIT) });
        const spies = shard as unknown as {
            recordMetric: (...args: unknown[]) => unknown;
            recordUserLog: (...args: unknown[]) => unknown;
        };
        const log = vi.spyOn(spies, "recordUserLog");
        const metric = vi.spyOn(spies, "recordMetric");
        const admit = admitOf(shard);
        const WINDOWS = 3;

        // One invocation every 2 s is 30 a minute, 1.5 times the limit. The sliding estimate then hovers at the limit, so
        // admits and refusals interleave: a flag cleared on every admit would log on each refusal that follows an admit.
        const answers: string[] = [];

        for (let at = NOW; at < NOW + WINDOWS * WINDOW; at += 2000) {
            vi.setSystemTime(at);
            answers.push(admit("steady:job") === undefined ? "admit" : "refuse");
        }

        const transitions = answers.filter((answer, index) => index > 0 && answer !== answers[index - 1]).length;

        expect(answers).toContain("admit");
        expect(answers).toContain("refuse");
        expect(transitions).toBeGreaterThan(WINDOWS + 1);
        expect(metric).toHaveBeenCalledWith(expect.objectContaining({ name: "shard.schedule_rate.deferred" }), undefined);
        // At most one record per window per target, not one per refusal.
        expect(log.mock.calls.length).toBeLessThanOrEqual(WINDOWS + 1);
    });

    /**
     * The loop this breaker exists for: a job whose run schedules its own next run with
     * `runAfter(0)`. Each iteration is one invocation, so one admit call. A round trip of
     * 100 ms means an unthrottled loop would run 3000 iterations in five windows. The
     * deferred due time is the loop's next wake.
     *
     * The guard is what holds the count down. With it removed, every iteration is admitted
     * and the count reaches 3000, which fails the bound.
     */
    it("holds a self-rescheduling loop to the budget per window", () => {
        expect.assertions(2);

        const ROUND_TRIP = 100;
        const WINDOWS = 5;
        const admit = admitOf(newShard({ [SCHEDULE_RATE_LIMIT_KEY]: String(SMALL_LIMIT) }));
        const horizon = NOW + WINDOWS * WINDOW;

        let due = NOW;
        let admitted = 0;
        let iterations = 0;

        while (due < horizon) {
            vi.setSystemTime(due);
            iterations += 1;

            const deferredTo = admit("loop:self");

            if (deferredTo === undefined) {
                admitted += 1;
                due += ROUND_TRIP;
            } else {
                due = Math.max(due + ROUND_TRIP, deferredTo);
            }
        }

        // Each window admits at most the limit, plus the one boundary instant a window can share.
        expect(admitted).toBeLessThanOrEqual(SMALL_LIMIT * WINDOWS + 1);
        // It is throttled, not stopped: the loop keeps making progress.
        expect(admitted).toBeGreaterThan(SMALL_LIMIT);
    });
});
