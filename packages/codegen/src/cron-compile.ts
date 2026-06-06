/**
 * Static mirror of `@cirrus/scheduler`'s `compileCronSchedule`. Codegen runs
 * before the user's project is built and cannot execute the `cronJobs()`
 * builder, so it re-derives the cron expression from the AST-lifted schedule
 * object. This MUST stay byte-for-byte in lockstep with
 * `packages/scheduler/src/cron-jobs.ts` — the two are exercised against the
 * same expectations in their respective test suites.
 *
 * It is kept here (rather than importing `@cirrus/scheduler`) so codegen — a
 * foundational, dependency-light package — does not gain a runtime dependency
 * on the scheduler just to compute four arithmetic templates.
 */

const WEEKDAY_INDEX: Record<string, number> = {
    friday: 5,
    monday: 1,
    saturday: 6,
    sunday: 0,
    thursday: 4,
    tuesday: 2,
    wednesday: 3,
};

/** Validate an integer field in `[min, max]` and render it as a cron token. */
const field = (value: unknown, label: string, min: number, max: number): string => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        throw new Error(`@cirrus/codegen: cron ${label} must be an integer in [${min.toFixed(0)}, ${max.toFixed(0)}], got ${String(value)}`);
    }

    return value.toFixed(0);
};

const compileInterval = (schedule: Record<string, unknown>): string => {
    const units = (["seconds", "minutes", "hours"] as const).filter((unit) => schedule[unit] !== undefined);

    if (units.length !== 1) {
        throw new Error(`@cirrus/codegen: cron interval schedule must specify exactly one of { seconds, minutes, hours }`);
    }

    const unit = units[0] as "hours" | "minutes" | "seconds";

    if (unit === "seconds") {
        return `*/${field(schedule.seconds, "interval.seconds", 1, 59)} * * * * *`;
    }

    if (unit === "minutes") {
        return `*/${field(schedule.minutes, "interval.minutes", 1, 59)} * * * *`;
    }

    return `0 */${field(schedule.hours, "interval.hours", 1, 23)} * * *`;
};

const compileDaily = (schedule: Record<string, unknown>): string => {
    const minute = field(schedule.minuteUTC, "daily.minuteUTC", 0, 59);
    const hour = field(schedule.hourUTC, "daily.hourUTC", 0, 23);

    return `${minute} ${hour} * * *`;
};

const compileWeekly = (schedule: Record<string, unknown>): string => {
    const dayOfWeek = String(schedule.dayOfWeek);
    const index = WEEKDAY_INDEX[dayOfWeek];

    if (index === undefined) {
        throw new Error(`@cirrus/codegen: cron weekly schedule has invalid dayOfWeek "${dayOfWeek}"`);
    }

    const minute = field(schedule.minuteUTC, "weekly.minuteUTC", 0, 59);
    const hour = field(schedule.hourUTC, "weekly.hourUTC", 0, 23);

    return `${minute} ${hour} * * ${index.toFixed(0)}`;
};

const compileMonthly = (schedule: Record<string, unknown>): string => {
    const day = field(schedule.day, "monthly.day", 1, 31);
    const minute = field(schedule.minuteUTC, "monthly.minuteUTC", 0, 59);
    const hour = field(schedule.hourUTC, "monthly.hourUTC", 0, 23);

    return `${minute} ${hour} ${day} * *`;
};

/** Builder methods that take a structured schedule object (not a raw string). */
type CronScheduleKind = "daily" | "interval" | "monthly" | "weekly";

const CRON_SCHEDULE_KINDS = new Set<CronScheduleKind>(["daily", "interval", "monthly", "weekly"]);

// Cron-field validators — a static mirror of `@cirrus/scheduler`'s cron-core,
// used to reject malformed raw `.cron("…")` expressions at codegen time.
const CRON_WILDCARD = /^\*(?:\/\d+)?$/u;
const CRON_NUMERIC = /^\d+(?:-\d+)?(?:\/\d+)?$/u;
const CRON_NAMED = /^[A-Za-z]{3}(?:-[A-Za-z]{3})?(?:\/\d+)?$/u;
const CRON_FIELD_SEPARATOR = /\s+/u;

const isValidCronPiece = (piece: string): boolean => CRON_WILDCARD.test(piece) || CRON_NUMERIC.test(piece) || CRON_NAMED.test(piece);

/** Standard 5-field or 6-field (with seconds) cron expression. */
const isValidCronExpression = (schedule: string): boolean => {
    const tokens = schedule.trim().split(CRON_FIELD_SEPARATOR);

    if (tokens.length !== 5 && tokens.length !== 6) {
        return false;
    }

    return tokens.every((token) => token.split(",").every((piece) => isValidCronPiece(piece)));
};

/** Compile one of the ergonomic schedule forms into a standard cron expression. */
const compileCronSchedule = (kind: CronScheduleKind, schedule: Record<string, unknown>): string => {
    switch (kind) {
        case "daily": {
            return compileDaily(schedule);
        }
        case "interval": {
            return compileInterval(schedule);
        }
        case "monthly": {
            return compileMonthly(schedule);
        }
        case "weekly": {
            return compileWeekly(schedule);
        }
        default: {
            throw new Error(`@cirrus/codegen: unknown cron schedule kind "${String(kind)}"`);
        }
    }
};

export { compileCronSchedule, CRON_SCHEDULE_KINDS, isValidCronExpression };
export type { CronScheduleKind };
