/**
 * Runaway guard for `ctx.scheduler` creations: the schedule-rate breaker.
 *
 * alarm-rearm-breaker.ts covers the shard's own poll alarm. A job that reschedules
 * itself through `ctx.scheduler.runAfter` never touches that alarm, so this guard
 * covers that path. Each run schedules the next, and nothing bounds how often that
 * happens.
 *
 * What is counted: one unit per (invocation, target). An invocation is one mutation or
 * action dispatch, and the target is the function the schedule runs. The facade
 * (`withDeferredSchedules` in `@lunora/server`) asks the shard once per target per
 * dispatch and remembers the answer for that dispatch. So a fan-out of many jobs to one
 * target from one invocation costs one unit, and a self-loop costs one unit per
 * iteration, because each iteration is its own invocation. A count of raw schedules
 * would trip on a legitimate import that schedules one job per row.
 *
 * Keying: per target, and per shard, since each shard has its own window in its own
 * SQLite. A fan-out spread across tenant shards does not add up. Keying by the
 * (scheduling function -> target) pair would need the calling function's path passed
 * into the facade, which the emitted `buildCtx` does not do. It would not catch more
 * either: in a chain A -> B -> A, each target still sees one unit per cycle.
 *
 * On a trip, the job is deferred and not dropped. Its due time is pushed to one window
 * out (`recoveryWakeAt`), and a job already due later than that keeps its time, because
 * deferral never brings a job forward. One `error` record and one counter are written per
 * trip per instance. Writes are never refused.
 *
 * Arithmetic behind the default. The default is 600 invocations per 60 s, which is 10
 * per second for one shard and one target. A self-loop runs at most one iteration per
 * round trip: a SchedulerDO alarm pass, the dispatch fetch, and the run. Assuming a
 * 100 ms round trip, that is 10 iterations per second, so the budget starts to hold at
 * the rate a loop of that speed reaches. Its daily ceiling is 600 * 1440 = 864 000
 * invocations per target per shard, which is a throttle and not a stop. The known false
 * positive is a steady workload above 10 invocations per second per shard and target,
 * such as one email job per request. Those jobs are delayed by one window and still run.
 * Raise the knob for such an app.
 *
 * Tuning and disabling: `LUNORA_SCHEDULE_RATE_LIMIT` (a positive integer), or `0` to turn
 * the breaker off. Unset or malformed values keep the default.
 *
 * Ceiling: the window is one row per target in the shard's SQLite, written inside the
 * invocation's transaction. A rolled-back invocation therefore does not count. The read
 * and write are fail-open: a storage fault admits the schedule rather than stalling it.
 */
import type { ShardSqlExec } from "@lunora/platform";

import type { RearmWindow } from "./alarm-rearm-breaker";
import { breakerLimitFrom } from "./alarm-rearm-breaker";

/** Invocations one shard may schedule for one target per window before the breaker trips. */
const DEFAULT_SCHEDULE_RATE_LIMIT = 600;

/** The deployment knob read off the worker `env`. */
const SCHEDULE_RATE_LIMIT_KEY = "LUNORA_SCHEDULE_RATE_LIMIT";

/** One row per target. Created on the first schedule that consults the breaker. */
const SCHEDULE_RATE_TABLE = "__lunora_schedule_rate_window";

/** The configured limit for this deployment: a positive integer, `undefined` when disabled. */
const scheduleRateLimitFrom = (env: unknown): number | undefined => breakerLimitFrom(env, SCHEDULE_RATE_LIMIT_KEY, DEFAULT_SCHEDULE_RATE_LIMIT);

/** Create the window table if it is missing. Idempotent. */
const ensureScheduleRateTable = (sql: ShardSqlExec): void => {
    sql.exec(
        `CREATE TABLE IF NOT EXISTS "${SCHEDULE_RATE_TABLE}" (target TEXT PRIMARY KEY, window_start INTEGER NOT NULL, current_count INTEGER NOT NULL, previous_count INTEGER NOT NULL)`,
    ).toArray();
};

/** The persisted window for `target`, or `undefined` before its first schedule. */
const readScheduleRateWindow = (sql: ShardSqlExec, target: string): RearmWindow | undefined => {
    const [row] = sql
        .exec<{ current_count: number; previous_count: number; window_start: number }>(
            `SELECT window_start, current_count, previous_count FROM "${SCHEDULE_RATE_TABLE}" WHERE target = ?`,
            target,
        )
        .toArray();

    if (row === undefined) {
        return undefined;
    }

    return { currentCount: row.current_count, previousCount: row.previous_count, windowStart: row.window_start };
};

/** Persist the window for `target`. */
const writeScheduleRateWindow = (sql: ShardSqlExec, target: string, window: RearmWindow): void => {
    sql.exec(
        `INSERT INTO "${SCHEDULE_RATE_TABLE}" (target, window_start, current_count, previous_count) VALUES (?, ?, ?, ?) ON CONFLICT(target) DO UPDATE SET window_start = excluded.window_start, current_count = excluded.current_count, previous_count = excluded.previous_count`,
        target,
        window.windowStart,
        window.currentCount,
        window.previousCount,
    ).toArray();
};

export {
    DEFAULT_SCHEDULE_RATE_LIMIT,
    ensureScheduleRateTable,
    readScheduleRateWindow,
    SCHEDULE_RATE_LIMIT_KEY,
    SCHEDULE_RATE_TABLE,
    scheduleRateLimitFrom,
    writeScheduleRateWindow,
};
