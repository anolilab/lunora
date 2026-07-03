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

/**
 * Assert a raw cron expression is well-formed, throwing the same shaped error
 * both cron surfaces use. The `context` prefix lets callers name the offending
 * job (`cron job "send digest"`) vs. the bare trigger.
 */
const assertValidCronExpression = (schedule: string, context = "cron expression"): void => {
    if (!isValidCronExpression(schedule)) {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/scheduler: invalid ${context} "${schedule}" — expected a standard 5- or 6-field cron expression (e.g. "0 * * * *")`,
        );
    }
};

export { assertValidCronExpression, isValidCronExpression };
