import type { FunctionReference } from "./types.js";

interface CronTriggerOptions {
    /** Args passed to the function. */
    args?: Record<string, unknown>;
    /** The Cirrus function to invoke on each trigger fire. */
    fn: FunctionReference;
    /** Standard cron expression, e.g. `"0 * * * *"`. */
    schedule: string;
}

interface CronTriggerSnippet {
    /** Paste these into `wrangler.jsonc` under `triggers.crons`. */
    crons: string[];
    /** Routes the Worker should mount to receive the trigger dispatch. */
    dispatcher: {
        args: Record<string, unknown>;
        functionPath: string;
    };
    /** Human-readable wrangler.jsonc snippet developers can copy/paste. */
    wranglerJsonc: string;
}

// Single cron-piece: `*`, `*` followed by a step, a digit, a range, or a
// range with a step. Also accepts the standard 3-letter named tokens for
// months (JAN..DEC) and weekdays (SUN..SAT), case-insensitively and in
// ranges/lists (e.g. `MON`, `MON-FRI`, `JAN-MAR`), which both standard cron
// and Cloudflare's parser support. Intentionally permissive on numeric values
// (we don't enforce minute < 60 etc.) — wrangler/Cloudflare will reject
// out-of-range values — but strict enough to refuse free-form prose like
// "every minute" that would otherwise silently no-op.
const CRON_PIECE = /^(?:\*|\*\/\d+|\d+(?:-\d+)?(?:\/\d+)?|[A-Za-z]{3}(?:-[A-Za-z]{3})?(?:\/\d+)?)$/u;

const CRON_FIELD_SEPARATOR = /\s+/u;

const isValidCronField = (field: string): boolean => field.split(",").every((piece) => CRON_PIECE.test(piece));

/** Standard 5-field (minute hour day month dow) or 6-field (with seconds) cron. */
const isValidCronExpression = (schedule: string): boolean => {
    const tokens = schedule.trim().split(CRON_FIELD_SEPARATOR);

    if (tokens.length !== 5 && tokens.length !== 6) {
        return false;
    }

    return tokens.every((token) => isValidCronField(token));
};

/**
 * Produces the wrangler.jsonc fragment + dispatcher metadata for a recurring
 * function. The actual cron handler is mounted by `@cirrus/runtime` — we only
 * emit the configuration here.
 */
const createCronTrigger = (options: CronTriggerOptions): CronTriggerSnippet => {
    // Defensive runtime guard: both are required by the type, but JS callers can omit them.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards untrusted JS callers despite the required type
    if (!options.schedule || !options.fn) {
        throw new Error("@cirrus/scheduler: createCronTrigger() requires `schedule` and `fn`");
    }

    if (!isValidCronExpression(options.schedule)) {
        throw new Error(`@cirrus/scheduler: invalid cron expression "${options.schedule}" — expected 5 or 6 space-separated fields (e.g. "0 * * * *")`);
    }

    const snippet = JSON.stringify(
        {
            triggers: {
                crons: [options.schedule],
            },
        },
        undefined,
        2,
    );

    return {
        crons: [options.schedule],
        dispatcher: {
            args: options.args ?? {},
            functionPath: options.fn.__cirrusRef,
        },
        wranglerJsonc: snippet,
    };
};

export { createCronTrigger };
export type { CronTriggerOptions, CronTriggerSnippet };
