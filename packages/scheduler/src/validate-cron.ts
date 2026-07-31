/**
 * Shared cron-expression validation used by both the imperative
 * `createCronTrigger` (see `./cron.ts`) and the code-first `cronJobs()` builder
 * (see `./jobs.ts`). Keeping the check in one place means the two surfaces can
 * never drift apart on what counts as a valid expression.
 *
 * Validation is delegated to `cron-parser`, so the full standard cron grammar is
 * accepted — wildcards, lists, ranges, steps, the 3-letter month/weekday names,
 * the Quartz-style `L`/`W`/`#`/`?` operators, the `@hourly`/`@daily`/… macros,
 * and both 5-field (minute…dow) and 6-field (seconds-leading) forms. We only
 * decide *well-formedness* here; out-of-platform values (Cloudflare caps the
 * number of triggers, doesn't run seconds, etc.) are still rejected downstream
 * by wrangler/Cloudflare at deploy time.
 *
 * `cron-parser` is a Node/codegen-time dependency: this module is pulled in by
 * the `cronJobs()` builder (authoring) and `@lunora/codegen` (build), never by
 * the `SchedulerDO` runtime path — so with `sideEffects: false` it tree-shakes
 * out of the Worker bundle.
 *
 * The ergonomic `crons.interval({ seconds })` form is rejected outright by
 * `compileInterval` in `./jobs.ts` before it ever reaches this validator. The
 * raw `.cron()` escape hatch is different: a 6-field, seconds-leading
 * expression is well-formed cron grammar (`cron-parser` accepts it), so it
 * passes here — but Cloudflare Cron Triggers only understand the standard
 * 5-field form and reject 6-field expressions at `wrangler deploy`. We warn
 * rather than throw for that case (see {@link warnIfSecondsLeading}): the
 * escape hatch exists precisely so callers can hand-author cron grammar this
 * module doesn't otherwise validate against a specific platform.
 */
import { LunoraError } from "@lunora/errors";
import { CronExpressionParser } from "cron-parser";

/** Standard cron expression (5- or 6-field) or a supported `@macro`, per `cron-parser`. */
const isValidCronExpression = (schedule: string): boolean => {
    if (typeof schedule !== "string" || schedule.trim() === "") {
        return false;
    }

    try {
        CronExpressionParser.parse(schedule.trim());

        return true;
    } catch {
        return false;
    }
};

/** Splits a cron expression on whitespace to count its fields. */
const CRON_FIELD_SPLIT_PATTERN = /\s+/u;

/**
 * A 6-field (seconds-leading) cron expression is legal generic cron grammar
 * but not a Cloudflare Cron Trigger — the platform only understands the
 * 5-field, minute-granularity form and rejects the rest at `wrangler deploy`
 * with a message naming neither the job nor the file. Warn here instead of
 * staying silent, without throwing: unlike the ergonomic `.interval()` form,
 * the raw `.cron()` escape hatch is meant to accept cron grammar this module
 * doesn't otherwise second-guess.
 */
const warnIfSecondsLeading = (schedule: string, context: string): void => {
    if (schedule.trim().split(CRON_FIELD_SPLIT_PATTERN).length === 6) {
        // eslint-disable-next-line no-console -- deliberate authoring-time warning; no logger is available in this Node/codegen-time module
        console.warn(
            `@lunora/scheduler: ${context} "${schedule}" is a 6-field (seconds-leading) cron expression — Cloudflare Cron Triggers only support the standard 5-field form and will reject this at \`wrangler deploy\`. Drop the seconds field, or use ctx.scheduler.runAfter/runAt for sub-minute work.`,
        );
    }
};

/**
 * Assert a raw cron expression is well-formed, throwing the same shaped error
 * both cron surfaces use. The `context` prefix lets callers name the offending
 * job (`cron job "send digest"`) vs. the bare trigger. Well-formed but
 * Cloudflare-incompatible (6-field) expressions pass but log a warning — see
 * {@link warnIfSecondsLeading}.
 */
const assertValidCronExpression = (schedule: string, context = "cron expression"): void => {
    if (!isValidCronExpression(schedule)) {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/scheduler: invalid ${context} "${schedule}" — expected a standard 5- or 6-field cron expression (e.g. "0 * * * *")`,
        );
    }

    warnIfSecondsLeading(schedule, context);
};

export { assertValidCronExpression, isValidCronExpression };
