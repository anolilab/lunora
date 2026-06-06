/**
 * Shared cron-expression validation + ergonomic-form compilation used by both
 * the imperative `createCronTrigger` (see `./cron.ts`) and the code-first
 * `cronJobs()` builder (see `./jobs.ts`). Keeping the regexes in one place
 * means the two surfaces can never drift apart on what counts as a valid
 * expression.
 */

// Single cron-piece: `*`, `*` followed by a step, a digit, a range, or a
// range with a step. Also accepts the standard 3-letter named tokens for
// months (JAN..DEC) and weekdays (SUN..SAT), case-insensitively and in
// ranges/lists (e.g. `MON`, `MON-FRI`, `JAN-MAR`), which both standard cron
// and Cloudflare's parser support. Intentionally permissive on numeric values
// (we don't enforce minute < 60 etc.) — wrangler/Cloudflare will reject
// out-of-range values — but strict enough to refuse free-form prose like
// "every minute" that would otherwise silently no-op.
// `*` optionally followed by a step (`*/5`).
const CRON_WILDCARD = /^\*(?:\/\d+)?$/u;

// A numeric value or range, optionally followed by a step (`5`, `1-3`, `1-3/2`).
const CRON_NUMERIC = /^\d+(?:-\d+)?(?:\/\d+)?$/u;

// A 3-letter named token (month/weekday), optionally as a range, with a step
// (`MON`, `MON-FRI`, `JAN-MAR/2`).
const CRON_NAMED = /^[A-Za-z]{3}(?:-[A-Za-z]{3})?(?:\/\d+)?$/u;

const CRON_FIELD_SEPARATOR = /\s+/u;

const isValidCronPiece = (piece: string): boolean => CRON_WILDCARD.test(piece) || CRON_NUMERIC.test(piece) || CRON_NAMED.test(piece);

const isValidCronField = (field: string): boolean => field.split(",").every((piece) => isValidCronPiece(piece));

/** Standard 5-field (minute hour day month dow) or 6-field (with seconds) cron. */
const isValidCronExpression = (schedule: string): boolean => {
    const tokens = schedule.trim().split(CRON_FIELD_SEPARATOR);

    if (tokens.length !== 5 && tokens.length !== 6) {
        return false;
    }

    return tokens.every((token) => isValidCronField(token));
};

/**
 * Assert a raw cron expression is well-formed, throwing the same shaped error
 * both cron surfaces use. The `context` prefix lets callers name the offending
 * job (`cron job "send digest"`) vs. the bare trigger.
 */
const assertValidCronExpression = (schedule: string, context = "cron expression"): void => {
    if (!isValidCronExpression(schedule)) {
        throw new Error(`@cirrus/scheduler: invalid ${context} "${schedule}" — expected 5 or 6 space-separated fields (e.g. "0 * * * *")`);
    }
};

export { assertValidCronExpression, isValidCronExpression };
