import { LunoraError } from "@lunora/errors";

import type { FunctionReference } from "./types";
import { assertValidCronExpression } from "./validate-cron";

interface CronTriggerOptions {
    /** Args passed to the function. */
    args?: Record<string, unknown>;
    /** The Lunora function to invoke on each trigger fire. */
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

/**
 * Produces the wrangler.jsonc fragment + dispatcher metadata for a recurring
 * function. The actual cron handler is mounted by `@lunora/runtime` — we only
 * emit the configuration here.
 */
const createCronTrigger = (options: CronTriggerOptions): CronTriggerSnippet => {
    // Defensive runtime guard: both are required by the type, but JS callers can omit them.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards untrusted JS callers despite the required type
    if (!options.schedule || !options.fn) {
        throw new LunoraError("INTERNAL", "@lunora/scheduler: createCronTrigger() requires `schedule` and `fn`");
    }

    assertValidCronExpression(options.schedule);

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
            functionPath: options.fn.__lunoraRef,
        },
        wranglerJsonc: snippet,
    };
};

export { createCronTrigger };
export type { CronTriggerOptions, CronTriggerSnippet };
