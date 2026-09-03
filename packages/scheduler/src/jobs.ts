/**
 * Code-first cron definitions — the Lunora equivalent of Convex's `cronJobs()`.
 *
 * Instead of hand-pasting a wrangler.jsonc `triggers.crons` array, users declare
 * crons in a `lunora/crons.ts` file:
 *
 * ```ts
 * import { cronJobs } from "@lunora/scheduler";
 * import { internal } from "./_generated/api.js";
 *
 * const crons = cronJobs();
 * crons.interval("clear presence", { minutes: 30 }, internal.presence.clear, {});
 * crons.daily("send digest", { hourUTC: 9, minuteUTC: 0 }, internal.email.digest, {});
 * crons.cron("custom", "0 * * * *", internal.foo.bar, {});
 * export default crons;
 * ```
 *
 * A job's target may be a function reference (a one-shot dispatch, above) or a
 * durable workflow — passing the generated `workflows.<name>` reference starts a
 * fresh, multi-step, retried workflow INSTANCE on each fire, and the args are
 * type-checked against the workflow's `params`:
 *
 * ```ts
 * import { workflows } from "./_generated/api";
 * crons.daily("nightly digest", { hourUTC: 9, minuteUTC: 0 }, workflows.digestPipeline, { region: "eu" });
 * ```
 *
 * `@lunora/codegen` discovers the registered jobs and emits both the
 * wrangler.jsonc schedule array and a dispatcher map the runtime's
 * `scheduled()` handler consumes — the user never edits wrangler by hand.
 */
import { LunoraError } from "@lunora/errors";

import type { CronTarget, CronTargetArgs } from "./types";
import { isWorkflowReference } from "./types";
import { assertValidCronExpression } from "./validate-cron";

/** Sub-day recurrence. Exactly one unit must be provided. */
interface IntervalSchedule {
    /** 1–23, and must divide 24 (an interval repeats *within* a day). */
    hours?: number;
    /** 1–59, and must divide 60. */
    minutes?: number;

    /**
     * Accepted by the type, **rejected at definition time**: Cloudflare Cron
     * Triggers have a one-minute floor, so the 6-field expression this compiles
     * to would survive codegen and land in the committed `wrangler.jsonc`, then
     * fail at `wrangler deploy` naming neither the job nor the file. Declared so
     * the rejection can name the job instead. Use `ctx.scheduler.runAfter`/
     * `runAt` for sub-minute recurrence, or `{ minutes: 1 }`.
     */
    seconds?: number;
}

/** Daily recurrence at a fixed UTC wall-clock time. */
interface DailySchedule {
    /** 0–23. */
    hourUTC: number;
    /** 0–59. */
    minuteUTC: number;
}

/**
 * Hourly recurrence at a fixed minute past the hour.
 *
 * `crons.interval({ hours: 1 })` compiles to the same expression, but the
 * asymmetry of having `daily`/`weekly`/`monthly` and no `hourly` is its own
 * papercut — and unlike the interval form this one lets
 * the caller place the job off the hour boundary, which is how you stop a
 * dozen hourly jobs from stampeding at `:00`.
 */
interface HourlySchedule {
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
 * verbatim with `@lunora/codegen` (which lifts the same fields out of the AST)
 * and the runtime dispatcher — keep the shape stable across all three.
 */
interface CronJob {
    /** Args forwarded to the function (or, for a workflow target, used as its `params`) on each fire. */
    args: Record<string, unknown>;
    /** Compiled standard cron expression, e.g. `"0 9 * * *"`. */
    cron: string;

    /**
     * `__lunoraRef` of the target function. Present for a function target;
     * absent when the job targets a workflow ({@link CronJob.workflow} instead).
     */
    functionPath?: string;
    /** Human-readable identifier — must be unique within one `cronJobs()`. */
    name: string;

    /**
     * Set when the job targets a durable workflow rather than a function: the
     * workflow's stable name (`defineWorkflow({ name })`) when one was declared,
     * otherwise `""`. `@lunora/codegen` statically resolves the concrete
     * `lunora/workflows.ts` export + its `WORKFLOW_*` binding for the emitted
     * dispatch map, so this authoring-time value is informational only.
     */
    workflow?: string;
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

const HOURS_PER_DAY = 24;

/**
 * Appended to every interval error that a daily-or-longer schedule would fix.
 *
 * `{ hours: 24 }` is the ordinary Convex idiom for "once a day", and the
 * natural next guess once it is rejected — `{ days: 1 }` — is not a unit
 * either. An error that only restates the constraint therefore sends people in
 * a circle, so both messages name the method they actually want.
 */
const DAILY_SCHEDULE_HINT =
    " For a daily or longer schedule use crons.daily(name, { hourUTC, minuteUTC }, …), crons.weekly(name, { dayOfWeek, hourUTC, minuteUTC }, …) or crons.monthly(name, { day, hourUTC, minuteUTC }, …).";

/** Validate an integer in `[min, max]` and return it as a cron field string. */
const field = (value: number, label: string, min: number, max: number): string => {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/scheduler: cronJobs ${label} must be an integer in [${min.toFixed(0)}, ${max.toFixed(0)}], got ${String(value)}`,
        );
    }

    return value.toFixed(0);
};

/**
 * Validate an interval step value and render it as a cron step field (the
 * `star-slash-n` form). Beyond the `[1, period - 1]` range check, the value must
 * EVENLY DIVIDE the field's period (60 for seconds/minutes, 24 for hours). A
 * cron step means "at field values divisible by n", which is a fixed `every n`
 * recurrence ONLY for a divisor: a non-divisor like step 45 fires at :00 and :45
 * then wraps at the hour — a 45/15-minute sawtooth, not "every 45 minutes" — and
 * `hours: 7` fires at 00,07,14,21 then a 3-hour gap. We reject such values rather
 * than emit a silently-wrong schedule.
 */
const stepField = (value: number, label: string, period: number): string => {
    const rendered = field(value, label, 1, period - 1);

    if (period % value !== 0) {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/scheduler: ${label} must evenly divide ${period.toFixed(0)} for a fixed "every ${value.toFixed(0)}" interval — cron "*/${value.toFixed(0)}" means "at values divisible by ${value.toFixed(0)}", which wraps unevenly; pick a divisor of ${period.toFixed(0)}`,
        );
    }

    return rendered;
};

/**
 * Compile an `{ seconds | minutes | hours }` interval into a cron expression.
 * Exactly one unit is allowed; the value is rendered as a stepped wildcard
 * (`star-slash-n`) in the corresponding cron field and must evenly divide the
 * field's period so the recurrence is truly `every n` (see {@link stepField}).
 *
 * `jobName` is optional so `@lunora/codegen`'s static AST-based discovery (which
 * calls this without a resolved job name in scope) still gets a rejection — just
 * without the job name in the message; the `cronJobs()` builder below always has
 * a name and passes it.
 */
const compileInterval = (schedule: IntervalSchedule, jobName?: string): string => {
    const units = (["seconds", "minutes", "hours"] as const).filter((unit) => schedule[unit] !== undefined);

    if (units.length !== 1) {
        const supplied = Object.entries(schedule as Record<string, unknown>)
            .filter(([, value]) => value !== undefined)
            .map(([key]) => key);

        throw new LunoraError(
            "INTERNAL",
            `@lunora/scheduler: interval schedule must specify exactly one of { seconds, minutes, hours }, got { ${supplied.join(", ")} }.${DAILY_SCHEDULE_HINT}`,
        );
    }

    const unit = units[0] as "hours" | "minutes" | "seconds";
    const value = schedule[unit] as number;

    // An interval renders as a cron STEP within its field's period, so hours
    // tops out at 23: `*/24` in a 0–23 field would mean "every 24th hour of a
    // 24-hour day", which is not a recurrence. Named separately from the generic
    // range check because `{ hours: 24 }` is the ordinary Convex idiom for
    // "once a day" and deserves to be told where daily actually lives.
    if (unit === "hours" && value >= HOURS_PER_DAY) {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/scheduler: interval.hours is capped at 23, got ${String(value)} — an interval repeats WITHIN a day rather than spanning one.${DAILY_SCHEDULE_HINT}`,
        );
    }

    // Cloudflare Cron Triggers have a one-minute floor: the platform only
    // understands the standard 5-field (minute-granularity) grammar, so a
    // 6-field seconds-leading expression compiles cleanly, survives codegen,
    // and lands in the user's committed wrangler.jsonc — then fails only at
    // `wrangler deploy`, with an error naming neither the job nor the file.
    // Reject it here instead, where the job name is still in scope.
    if (unit === "seconds") {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/scheduler: cron job${jobName ? ` "${jobName}"` : ""} uses interval.seconds (${String(value)}) — Cloudflare Cron Triggers have a one-minute floor and cannot run sub-minute schedules; \`wrangler deploy\` would reject the resulting 6-field cron expression. Use ctx.scheduler.runAfter/runAt (optionally via a workpool for bounded concurrency) for sub-minute recurrence, or crons.interval(name, { minutes: 1 }, …) for the fastest cron-native cadence.`,
        );
    }

    if (unit === "minutes") {
        return `*/${stepField(value, "interval.minutes", 60)} * * * *`;
    }

    return `0 */${stepField(value, "interval.hours", 24)} * * *`;
};

const compileHourly = (schedule: HourlySchedule): string => `${field(schedule.minuteUTC, "hourly.minuteUTC", 0, 59)} * * * *`;

const compileDaily = (schedule: DailySchedule): string => {
    const minute = field(schedule.minuteUTC, "daily.minuteUTC", 0, 59);
    const hour = field(schedule.hourUTC, "daily.hourUTC", 0, 23);

    return `${minute} ${hour} * * *`;
};

const compileWeekly = (schedule: WeeklySchedule): string => {
    const index = WEEKDAY_INDEX[schedule.dayOfWeek] as number | undefined;

    if (index === undefined) {
        throw new LunoraError("INTERNAL", `@lunora/scheduler: weekly schedule has invalid dayOfWeek "${schedule.dayOfWeek}"`);
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
type CronScheduleKind = "daily" | "hourly" | "interval" | "monthly" | "weekly";

/** The ergonomic schedule kinds as a runtime set (codegen reads this to detect cron builder methods). */
const CRON_SCHEDULE_KINDS: ReadonlySet<CronScheduleKind> = new Set<CronScheduleKind>(["daily", "hourly", "interval", "monthly", "weekly"]);

/**
 * Compile one of the ergonomic schedule forms into a standard cron expression.
 * Exposed as a pure function so `@lunora/codegen` can reuse the exact same
 * compilation when it statically lifts a `crons.{kind}(...)` call out of the
 * AST — codegen imports this directly (no duplicated mirror). `jobName` is
 * optional (see {@link compileInterval}) so codegen's existing 2-arg call site
 * keeps working unchanged.
 */
const compileCronSchedule = (
    kind: CronScheduleKind,
    schedule: DailySchedule | HourlySchedule | IntervalSchedule | MonthlySchedule | WeeklySchedule,
    jobName?: string,
): string => {
    switch (kind) {
        case "daily": {
            return compileDaily(schedule as DailySchedule);
        }
        case "hourly": {
            return compileHourly(schedule as HourlySchedule);
        }
        case "interval": {
            return compileInterval(schedule as IntervalSchedule, jobName);
        }
        case "monthly": {
            return compileMonthly(schedule as MonthlySchedule);
        }
        case "weekly": {
            return compileWeekly(schedule as WeeklySchedule);
        }
        default: {
            throw new LunoraError("INTERNAL", `@lunora/scheduler: unknown cron schedule kind "${String(kind)}"`);
        }
    }
};

/**
 * Builder returned by {@link cronJobs}. Each method registers one recurring
 * job; the compiled expression is validated immediately so authoring mistakes
 * surface at definition time rather than at codegen.
 */
interface CronJobsBuilder {
    /**
     * Raw cron expression escape hatch (5- or 6-field, full cron-parser grammar).
     * The target may be a function (`internal.file.fn`) or a durable workflow
     * (`workflows.<name>`); a workflow's `args` are inferred from its `params`.
     */
    cron: <T extends CronTarget>(name: string, cronExpr: string, target: T, args?: CronTargetArgs<T>) => CronJobsBuilder;
    /** Daily at `hourUTC:minuteUTC` (UTC). The target may be a function or a durable workflow (`workflows.<name>`). */
    daily: <T extends CronTarget>(name: string, schedule: DailySchedule, target: T, args?: CronTargetArgs<T>) => CronJobsBuilder;
    /** Hourly at `minuteUTC` past the hour. The target may be a function or a durable workflow (`workflows.<name>`). */
    hourly: <T extends CronTarget>(name: string, schedule: HourlySchedule, target: T, args?: CronTargetArgs<T>) => CronJobsBuilder;
    /** Every `{ minutes | hours }` — `{ seconds }` throws (Cron Triggers have a one-minute floor). The target may be a function or a durable workflow (`workflows.<name>`). */
    interval: <T extends CronTarget>(name: string, schedule: IntervalSchedule, target: T, args?: CronTargetArgs<T>) => CronJobsBuilder;
    /** Snapshot of the registered jobs, in declaration order. */
    jobs: () => ReadonlyArray<CronJob>;
    /** Monthly on `day` at `hourUTC:minuteUTC` (UTC). The target may be a function or a durable workflow (`workflows.<name>`). */
    monthly: <T extends CronTarget>(name: string, schedule: MonthlySchedule, target: T, args?: CronTargetArgs<T>) => CronJobsBuilder;
    /** Weekly on `dayOfWeek` at `hourUTC:minuteUTC` (UTC). The target may be a function or a durable workflow (`workflows.<name>`). */
    weekly: <T extends CronTarget>(name: string, schedule: WeeklySchedule, target: T, args?: CronTargetArgs<T>) => CronJobsBuilder;
}

/**
 * Create a code-first cron registry. The returned builder is chainable;
 * codegen discovers a `lunora/crons.ts` default export by AST, not a runtime
 * brand.
 */
const cronJobs = (): CronJobsBuilder => {
    const jobs: CronJob[] = [];
    const seen = new Set<string>();

    const register = (name: string, cron: string, target: CronTarget, args: Record<string, unknown> | undefined): void => {
        if (typeof name !== "string" || name.trim() === "") {
            throw new LunoraError("INTERNAL", `@lunora/scheduler: cron job name must be a non-empty string`);
        }

        if (seen.has(name)) {
            throw new LunoraError("INTERNAL", `@lunora/scheduler: duplicate cron job name "${name}" — names must be unique within one cronJobs()`);
        }

        // Workflow target — starts a durable workflow INSTANCE per fire (args ⇒
        // its `params`). The concrete `lunora/workflows.ts` export + `WORKFLOW_*`
        // binding is resolved statically by `@lunora/codegen`; the builder only
        // records the optional stable-name override for `.jobs()` introspection.
        let dispatchTarget: { functionPath: string } | { workflow: string };

        if (isWorkflowReference(target)) {
            dispatchTarget = { workflow: typeof target.name === "string" ? target.name : "" };
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards untrusted JS callers despite the required type
        } else if (target && typeof target.__lunoraRef === "string") {
            dispatchTarget = { functionPath: target.__lunoraRef };
        } else {
            throw new LunoraError(
                "INTERNAL",
                `@lunora/scheduler: cron job "${name}" requires a function reference (e.g. internal.email.digest) or a workflow reference`,
            );
        }

        assertValidCronExpression(cron, `cron expression for job "${name}"`);

        seen.add(name);
        jobs.push({ args: args ?? {}, cron, name, ...dispatchTarget });
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
        hourly(name, schedule, function_, args) {
            register(name, compileCronSchedule("hourly", schedule), function_, args);

            return builder;
        },
        interval(name, schedule, function_, args) {
            register(name, compileCronSchedule("interval", schedule, name), function_, args);

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

    return builder;
};

export { compileCronSchedule, CRON_SCHEDULE_KINDS, cronJobs };
export type { CronJob, CronJobsBuilder, CronScheduleKind, DailySchedule, HourlySchedule, IntervalSchedule, MonthlySchedule, WeeklySchedule };
