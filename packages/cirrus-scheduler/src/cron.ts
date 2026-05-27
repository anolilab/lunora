import type { FunctionReference } from "./types.js";

export interface CronTriggerOptions {
    /** Standard cron expression, e.g. `"0 * * * *"`. */
    schedule: string;
    /** The Cirrus function to invoke on each trigger fire. */
    fn: FunctionReference;
    /** Args passed to the function. */
    args?: Record<string, unknown>;
}

export interface CronTriggerSnippet {
    /** Paste these into `wrangler.jsonc` under `triggers.crons`. */
    crons: string[];
    /** Routes the Worker should mount to receive the trigger dispatch. */
    dispatcher: {
        functionPath: string;
        args: Record<string, unknown>;
    };
    /** Human-readable wrangler.jsonc snippet developers can copy/paste. */
    wranglerJsonc: string;
}

/**
 * Produces the wrangler.jsonc fragment + dispatcher metadata for a recurring
 * function. The actual cron handler is mounted by `@cirrus/runtime` — we only
 * emit the configuration here.
 */
export const createCronTrigger = (options: CronTriggerOptions): CronTriggerSnippet => {
    if (!options.schedule || !options.fn) {
        throw new Error("@cirrus/scheduler: createCronTrigger() requires `schedule` and `fn`");
    }

    const snippet = JSON.stringify(
        {
            triggers: {
                crons: [options.schedule],
            },
        },
        null,
        2,
    );

    return {
        crons: [options.schedule],
        dispatcher: {
            functionPath: options.fn.__cirrusRef,
            args: options.args ?? {},
        },
        wranglerJsonc: snippet,
    };
};
