/**
 * Code-first cron definitions — the Cirrus equivalent of Convex's `cronJobs()`.
 *
 * Instead of hand-pasting a wrangler.jsonc `triggers.crons` array, users declare
 * crons in a `cirrus/crons.ts` file:
 *
 * ```ts
 * import { cronJobs } from "@cirrus/scheduler";
 * import { internal } from "./_generated/api.js";
 *
 * const crons = cronJobs();
 * crons.interval("clear presence", { minutes: 30 }, internal.presence.clear, {});
 * crons.daily("send digest", { hourUTC: 9, minuteUTC: 0 }, internal.email.digest, {});
 * crons.cron("custom", "0 * * * *", internal.foo.bar, {});
 * export default crons;
 * ```
 *
 * `@cirrus/codegen` discovers the registered jobs and emits both the
 * wrangler.jsonc schedule array and a dispatcher map the runtime's
 * `scheduled()` handler consumes — the user never edits wrangler by hand.
 */
import type { FunctionReference } from "./types.js";
import { assertValidCronExpression } from "./validate-cron.js";

/** Sub-day recurrence. Exactly one unit must be provided. */
interface IntervalSchedule {
    hours?: number;
    minutes?: number;
    seconds?: number;
}

/** Daily recurrence at a fixed UTC wall-clock time. */
interface DailySchedule {
    /** 0–23. */
    hourUTC: number;
    /** 0–59. */
    minuteUTC: number;
}

/** Weekly recurrence at a fixed UTC time on a given weekday. */
interface WeeklySchedule extends DailySchedule {
    /** Long weekday name, case-insensitive (e.g. `"monday"`). */
    dayOfWeek: "friday" | "monday" | "saturday" | "sunday" | "thursday" | "tuesday" | "wednesday";
}

/** Monthly recurrence at a fixed UTC time on a given day-of-month. */
interface MonthlySchedule extends DailySchedule {
    /** 1–31. */
    day: number;
}

/**
 * One registered cron job, normalized to a compiled cron expression. Shared
 * verbatim with `@cirrus/codegen` (which lifts the same fields out of the AST)
 * and the runtime dispatcher — keep the shape stable across all three.
 */
interface CronJob {
    /** Args forwarded to the function on each fire. */
    args: Record<string, unknown>;
    /** Compiled standard cron expression, e.g. `"0 9 * * *"`. */
    cron: string;
    /** `__cirrusRef` of the target function. */
    functionPath: string;
    /** Human-readable identifier — must be unique within one `cronJobs()`. */
    name: string;
}

const WEEKDAY_INDEX: Record<WeeklySchedule["dayOfWeek"], number> = {
    friday: 5,
    monday: 1,
    saturday: 6,
    sunday: 0,
    thursday: 4,
    tuesday: 2,
    wednesday: 3,
};

/** Validate an integer in `[min, max]` and return it as a cron field string. */
const field = (value: number, label: string, min: number, max: number): string => {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`@cirrus/scheduler: cronJobs ${label} must be an integer in [${min.toFixed(0)}, ${max.toFixed(0)}], got ${String(value)}`);
    }

    return value.toFixed(0);
};

/**
 * Compile an `{ seconds | minutes | hours }` interval into a cron expression.
 * Exactly one unit is allowed; the value is rendered as a stepped wildcard
 * (`star-slash-n`) in the corresponding cron field.
 */
const compileInterval = (schedule: IntervalSchedule): string => {
    const units = (["seconds", "minutes", "hours"] as const).filter((unit) => schedule[unit] !== undefined);

    if (units.length !== 1) {
        throw new Error(`@cirrus/scheduler: interval schedule must specify exactly one of { seconds, minutes, hours }`);
    }

    const unit = units[0] as "hours" | "minutes" | "seconds";
    const value = schedule[unit] as number;

    if (unit === "seconds") {
        return `*/${field(value, "interval.seconds", 1, 59)} * * * * *`;
    }

    if (unit === "minutes") {
        return `*/${field(value, "interval.minutes", 1, 59)} * * * *`;
    }

    return `0 */${field(value, "interval.hours", 1, 23)} * * *`;
};

const compileDaily = (schedule: DailySchedule): string => {
    const minute = field(schedule.minuteUTC, "daily.minuteUTC", 0, 59);
    const hour = field(schedule.hourUTC, "daily.hourUTC", 0, 23);

    return `${minute} ${hour} * * *`;
};

const compileWeekly = (schedule: WeeklySchedule): string => {
    const index = WEEKDAY_INDEX[schedule.dayOfWeek] as number | undefined;

    if (index === undefined) {
        throw new Error(`@cirrus/scheduler: weekly schedule has invalid dayOfWeek "${schedule.dayOfWeek}"`);
    }

    const minute = field(schedule.minuteUTC, "weekly.minuteUTC", 0, 59);
    const hour = field(schedule.hourUTC, "weekly.hourUTC", 0, 23);

    return `${minute} ${hour} * * ${index.toFixed(0)}`;
};

const compileMonthly = (schedule: MonthlySchedule): string => {
    const day = field(schedule.day, "monthly.day", 1, 31);
    const minute = field(schedule.minuteUTC, "monthly.minuteUTC", 0, 59);
    const hour = field(schedule.hourUTC, "monthly.hourUTC", 0, 23);

    return `${minute} ${hour} ${day} * *`;
};

/** The ergonomic builder methods, excluding the raw `.cron` escape hatch. */
type CronScheduleKind = "daily" | "interval" | "monthly" | "weekly";

/**
 * Compile one of the ergonomic schedule forms into a standard cron expression.
 * Exposed as a pure function so `@cirrus/codegen` can reuse the exact same
 * compilation (and thus stay byte-for-byte in sync with the runtime builder)
 * when it statically lifts a `crons.{kind}(...)` call out of the AST.
 */
const compileCronSchedule = (kind: CronScheduleKind, schedule: DailySchedule | IntervalSchedule | MonthlySchedule | WeeklySchedule): string => {
    switch (kind) {
        case "daily": {
            return compileDaily(schedule as DailySchedule);
        }
        case "interval": {
            return compileInterval(schedule as IntervalSchedule);
        }
        case "monthly": {
            return compileMonthly(schedule as MonthlySchedule);
        }
        case "weekly": {
            return compileWeekly(schedule as WeeklySchedule);
        }
        default: {
            throw new Error(`@cirrus/scheduler: unknown cron schedule kind "${String(kind)}"`);
        }
    }
};

/**
 * Builder returned by {@link cronJobs}. Each method registers one recurring
 * job; the compiled expression is validated immediately so authoring mistakes
 * surface at definition time rather than at codegen.
 */
interface CronJobsBuilder {
    /** Raw cron expression escape hatch (5- or 6-field). */
    cron: (name: string, cronExpr: string, function_: FunctionReference, args?: Record<string, unknown>) => CronJobsBuilder;
    /** Daily at `hourUTC:minuteUTC` (UTC). */
    daily: (name: string, schedule: DailySchedule, function_: FunctionReference, args?: Record<string, unknown>) => CronJobsBuilder;
    /** Every `{ seconds | minutes | hours }`. */
    interval: (name: string, schedule: IntervalSchedule, function_: FunctionReference, args?: Record<string, unknown>) => CronJobsBuilder;
    /** Snapshot of the registered jobs, in declaration order. */
    jobs: () => ReadonlyArray<CronJob>;
    /** Monthly on `day` at `hourUTC:minuteUTC` (UTC). */
    monthly: (name: string, schedule: MonthlySchedule, function_: FunctionReference, args?: Record<string, unknown>) => CronJobsBuilder;
    /** Weekly on `dayOfWeek` at `hourUTC:minuteUTC` (UTC). */
    weekly: (name: string, schedule: WeeklySchedule, function_: FunctionReference, args?: Record<string, unknown>) => CronJobsBuilder;
}

/** Marker so codegen/runtime can recognise a `cronJobs()` default export. */
const CRON_JOBS_BRAND = "__cirrusCronJobs" as const;

/**
 * Create a code-first cron registry. The returned builder is chainable and
 * carries a `__cirrusCronJobs` brand so the discovery/runtime layers can detect
 * a `cirrus/crons.ts` default export.
 */
const cronJobs = (): CronJobsBuilder => {
    const jobs: CronJob[] = [];
    const seen = new Set<string>();

    const register = (name: string, cron: string, function_: FunctionReference, args: Record<string, unknown> | undefined): void => {
        if (typeof name !== "string" || name.trim() === "") {
            throw new Error(`@cirrus/scheduler: cron job name must be a non-empty string`);
        }

        if (seen.has(name)) {
            throw new Error(`@cirrus/scheduler: duplicate cron job name "${name}" — names must be unique within one cronJobs()`);
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards untrusted JS callers despite the required type
        if (!function_ || typeof function_.__cirrusRef !== "string") {
            throw new Error(`@cirrus/scheduler: cron job "${name}" requires a function reference (e.g. internal.email.digest)`);
        }

        assertValidCronExpression(cron, `cron expression for job "${name}"`);

        seen.add(name);
        jobs.push({ args: args ?? {}, cron, functionPath: function_.__cirrusRef, name });
    };

    const builder: CronJobsBuilder = {
        cron(name, cronExpr, function_, args) {
            register(name, cronExpr, function_, args);

            return builder;
        },
        daily(name, schedule, function_, args) {
            register(name, compileCronSchedule("daily", schedule), function_, args);

            return builder;
        },
        interval(name, schedule, function_, args) {
            register(name, compileCronSchedule("interval", schedule), function_, args);

            return builder;
        },
        jobs: () => [...jobs],
        monthly(name, schedule, function_, args) {
            register(name, compileCronSchedule("monthly", schedule), function_, args);

            return builder;
        },
        weekly(name, schedule, function_, args) {
            register(name, compileCronSchedule("weekly", schedule), function_, args);

            return builder;
        },
    };

    return Object.assign(builder, { [CRON_JOBS_BRAND]: true as const });
};

export { compileCronSchedule, CRON_JOBS_BRAND, cronJobs };
export type { CronJob, CronJobsBuilder, CronScheduleKind, DailySchedule, IntervalSchedule, MonthlySchedule, WeeklySchedule };
