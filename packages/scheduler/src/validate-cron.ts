/**
 * Shared cron-expression validation used by both the imperative
 * `createCronTrigger` (see `./cron.ts`) and the code-first `cronJobs()` builder
 * (see `./jobs.ts`). Keeping the check in one place means the two surfaces can
 * never drift apart on what counts as a valid expression.
 *
 * Validation is `@visulima/cron-parser`'s `cloudflare` entry (which defaults to
 * that dialect): five fields of `*`, lists, ranges, steps, month/weekday names
 * and the `L`/`W`/`n#k` operators — the grammar Cloudflare Cron Triggers
 * actually run. `seconds: "optional"` is the one relaxation: a 6-field,
 * seconds-leading expression still parses here and only warns (see
 * {@link warnIfSecondsLeading}), because the raw `.cron()` escape hatch exists
 * so callers can hand-author grammar the platform will reject at `wrangler
 * deploy`.
 *
 * `@visulima/cron-parser` is a zero-dependency ESM parser, so this same module
 * backs both the runtime builder and `@lunora/scheduler/validate` (codegen, CLI)
 * — there is no second, looser hand-written grammar to keep in step.
 *
 * The ergonomic `crons.interval({ seconds })` form is rejected outright by
 * `compileInterval` in `./jobs.ts` before it ever reaches this validator.
 */
import { LunoraError } from "@lunora/errors";
import { parse } from "@visulima/cron-parser/cloudflare";

/** Splits a cron expression on whitespace to count its fields. */
const CRON_FIELD_SPLIT_PATTERN = /\s+/u;

/** The `cloudflare` entry already fixes the dialect; `seconds` keeps the 6-field escape hatch. */
const CRON_PARSE_OPTIONS = { seconds: "optional" } as const;

/** True when `schedule` is a Cloudflare Cron Trigger expression (or a 6-field escape-hatch one). */
const isValidCronExpression = (schedule: string): boolean => {
    if (typeof schedule !== "string") {
        return false;
    }

    const fields = schedule.trim().split(CRON_FIELD_SPLIT_PATTERN);

    // The parser pads a short expression into five fields, so the count is enforced
    // here: a Cloudflare Cron Trigger is exactly five fields, and the raw `.cron()`
    // escape hatch adds a sixth (seconds) it warns about.
    if (fields.length !== 5 && fields.length !== 6) {
        return false;
    }

    try {
        parse(fields.join(" "), CRON_PARSE_OPTIONS);

        return true;
    } catch {
        return false;
    }
};

/**
 * A 6-field (seconds-leading) cron expression is legal generic cron grammar but
 * not a Cloudflare Cron Trigger — the platform only understands the 5-field,
 * minute-granularity form and rejects the rest at `wrangler deploy` with a
 * message naming neither the job nor the file. Warn here instead of staying
 * silent, without throwing: unlike the ergonomic `.interval()` form, the raw
 * `.cron()` escape hatch is meant to accept cron grammar this module doesn't
 * otherwise second-guess.
 *
 * Exported (not module-private) because it is the ONE place this advisory is
 * written: the runtime `cronJobs()` builder reaches it via
 * {@link assertValidCronExpression}, and `@lunora/codegen`'s static
 * `discover/crons.ts` calls it directly after its own `isValidCronExpression`
 * check — so a hand-authored 6-field `.cron()` warns whether it's discovered
 * from source at build time or registered at runtime, with one shared message.
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

export { assertValidCronExpression, isValidCronExpression, warnIfSecondsLeading };
