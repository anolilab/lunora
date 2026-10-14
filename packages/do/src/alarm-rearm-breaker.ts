/**
 * Runaway guard for a shard's own alarm re-arms.
 *
 * The shard's poll alarm re-arms itself on every tick while a tier still has
 * work: a subscribed global shape, a source, a TTL backlog. A source whose next
 * due time is always "now", or a tier that never drains, turns that into a loop
 * that re-arms as fast as the runtime wakes the DO, and the DO bills for every
 * wake-up.
 *
 * When the budget is spent, a re-arm is refused. The refusal arms exactly one
 * recovery wake one window out (`recoveryWakeAt`), and the shard logs one `error`
 * record and counts the refusal. The recovery wake runs the poll and sweep tiers
 * once, then re-arms only within the budget. So an idle shard resumes polling once
 * the window drains, and a shard whose tier never drains is throttled instead of
 * being stopped: it bursts to about the limit, then waits, and no window is empty. The breaker never refuses a write and
 * never drops a user job: the schedule outbox is exempt, because it holds jobs the
 * scheduler has not yet accepted. TTL rows and source updates are delayed by about a
 * window, never discarded.
 *
 * Arithmetic behind the default. Tiers coalesce into one alarm, so the
 * legitimate steady-state re-arm rate is set by the fastest recurring tier, the
 * 2 s global-shape floor: 60 000 / 2 000 = 30 re-arms per minute. The default
 * limit is 300 per 60 s, ten times that floor. A legitimate backlog only reaches
 * it by re-arming "due now" at 5 or more ticks per second, for example a large
 * TTL drain, and that is the case the knob exists for. The outbox retry starts at
 * 5 s, so it never approaches the limit at all.
 *
 * Tuning and disabling: `LUNORA_ALARM_REARM_LIMIT` (a positive integer), or `0`
 * to turn the breaker off. Unset or malformed values keep the default, matching
 * `envPositiveInt`'s strictness.
 *
 * Ceiling: the window is one row in the shard's own SQLite, so an eviction
 * between alarm ticks does not reset it. The read and write are fail-open: a
 * storage fault admits the re-arm rather than stalling the shard.
 */
import type { ShardSqlExec } from "@lunora/platform";

/** Length of the sliding window the re-arm count is taken over, in milliseconds. */
const ALARM_REARM_WINDOW_MS = 60_000;

/**
 * When the recovery wake for a refused re-arm is due: one window out, plus one
 * millisecond. A refusal at a window's first instant would otherwise be refused
 * again at the recovery instant, because the previous window still weighs in full,
 * and that would repeat forever under a frozen clock. One millisecond is enough for
 * the weight to start decaying.
 */
const recoveryWakeAt = (now: number): number => now + ALARM_REARM_WINDOW_MS + 1;

/** Re-arms one shard may make per window before the breaker trips. See the module doc for the arithmetic. */
const DEFAULT_ALARM_REARM_LIMIT = 300;

/** The deployment knob read off the worker `env`. */
const ALARM_REARM_LIMIT_KEY = "LUNORA_ALARM_REARM_LIMIT";

/** The one-row table holding the window. Created on the first alarm tick that needs it. */
const ALARM_REARM_WINDOW_TABLE = "__lunora_alarm_rearm_window";

/**
 * A sliding-window counter over two fixed buckets: the count in the current
 * window plus the previous window's count weighted by how much of it still
 * overlaps `now`. Two integers and a timestamp, so one row holds it.
 */
interface RearmWindow {
    currentCount: number;
    previousCount: number;
    windowStart: number;
}

/** Outcome of one re-arm request. A refused request is not counted. */
interface RearmAdmission {
    admitted: boolean;
    /** The window to persist: rolled forward to `now`, and incremented only when admitted. */
    window: RearmWindow;
}

/** Roll the window forward to contain `now`, carrying the last full window as `previousCount`. */
const rollWindow = (window: RearmWindow | undefined, now: number): RearmWindow => {
    if (window === undefined) {
        return { currentCount: 0, previousCount: 0, windowStart: now };
    }

    const elapsed = now - window.windowStart;

    if (elapsed < ALARM_REARM_WINDOW_MS) {
        return window;
    }

    const windowsPassed = Math.floor(elapsed / ALARM_REARM_WINDOW_MS);

    return {
        currentCount: 0,
        // Only the window immediately before `now` still overlaps the sliding span.
        previousCount: windowsPassed === 1 ? window.currentCount : 0,
        windowStart: window.windowStart + windowsPassed * ALARM_REARM_WINDOW_MS,
    };
};

/** Estimated re-arms in the last window ending at `now`. A clock that steps backwards reads as the window's start. */
const estimateRearms = (window: RearmWindow, now: number): number => {
    const intoWindow = Math.min(Math.max(now - window.windowStart, 0), ALARM_REARM_WINDOW_MS);

    return window.currentCount + window.previousCount * (1 - intoWindow / ALARM_REARM_WINDOW_MS);
};

/**
 * Admit or refuse one alarm re-arm against `limit`. Pass `Number.POSITIVE_INFINITY`
 * to always admit while still counting the request, which is how the exempt
 * outbox re-arm is recorded.
 */
const admitRearm = (window: RearmWindow | undefined, now: number, limit: number): RearmAdmission => {
    const rolled = rollWindow(window, now);

    if (estimateRearms(rolled, now) >= limit) {
        return { admitted: false, window: rolled };
    }

    return { admitted: true, window: { ...rolled, currentCount: rolled.currentCount + 1 } };
};

/**
 * The configured limit: a positive integer, `undefined` when the breaker is
 * disabled (`0`), and the default when the variable is unset or malformed.
 */
const WHOLE_NUMBER_PATTERN = /^\d+$/u;

const alarmRearmLimitFrom = (env: unknown): number | undefined => {
    const raw: unknown = (env as Record<string, unknown> | undefined)?.[ALARM_REARM_LIMIT_KEY];
    let value = Number.NaN;

    if (typeof raw === "number") {
        value = raw;
    } else if (typeof raw === "string" && WHOLE_NUMBER_PATTERN.test(raw.trim())) {
        value = Number(raw.trim());
    }

    if (!Number.isSafeInteger(value) || value < 0) {
        return DEFAULT_ALARM_REARM_LIMIT;
    }

    return value === 0 ? undefined : value;
};

/** Create the window table if it is missing. Idempotent, so it runs on every tick that consults the breaker. */
const ensureRearmWindowTable = (sql: ShardSqlExec): void => {
    sql.exec(
        `CREATE TABLE IF NOT EXISTS "${ALARM_REARM_WINDOW_TABLE}" (id INTEGER PRIMARY KEY CHECK (id = 0), window_start INTEGER NOT NULL, current_count INTEGER NOT NULL, previous_count INTEGER NOT NULL)`,
    ).toArray();
};

/** The persisted window, or `undefined` before the first re-arm has been recorded. */
const readRearmWindow = (sql: ShardSqlExec): RearmWindow | undefined => {
    const [row] = sql
        .exec<{ current_count: number; previous_count: number; window_start: number }>(
            `SELECT window_start, current_count, previous_count FROM "${ALARM_REARM_WINDOW_TABLE}" WHERE id = 0`,
        )
        .toArray();

    if (row === undefined) {
        return undefined;
    }

    return { currentCount: row.current_count, previousCount: row.previous_count, windowStart: row.window_start };
};

/**
 * Persist the window as the single row. Returns the rows the engine counts as written
 * by this statement (`undefined` where the cursor carries no counter). The shard
 * ignores it; the workerd test reads it to pin the cost in the engine's own terms.
 */
const writeRearmWindow = (sql: ShardSqlExec, window: RearmWindow): number | undefined => {
    const cursor = sql.exec(
        `INSERT INTO "${ALARM_REARM_WINDOW_TABLE}" (id, window_start, current_count, previous_count) VALUES (0, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET window_start = excluded.window_start, current_count = excluded.current_count, previous_count = excluded.previous_count`,
        window.windowStart,
        window.currentCount,
        window.previousCount,
    );

    cursor.toArray();

    const { rowsWritten } = cursor as { rowsWritten?: number };

    return typeof rowsWritten === "number" ? rowsWritten : undefined;
};

export type { RearmAdmission, RearmWindow };
export {
    admitRearm,
    ALARM_REARM_LIMIT_KEY,
    ALARM_REARM_WINDOW_MS,
    ALARM_REARM_WINDOW_TABLE,
    alarmRearmLimitFrom,
    DEFAULT_ALARM_REARM_LIMIT,
    ensureRearmWindowTable,
    estimateRearms,
    readRearmWindow,
    recoveryWakeAt,
    writeRearmWindow,
};
