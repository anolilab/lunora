/**
 * `createDispatchLogger` — a console-backed logger prefixed for correlation,
 * shared by the dispatch consumers (`@lunora/workflow` → `[workflow:<name>]`,
 * `@lunora/queue` → `[queue:<name>]`). The runtime routes the console output to
 * wrangler tail / Studio.
 */
import type { DispatchLogger } from "./types";

/** Build a {@link DispatchLogger} that prefixes every line with `prefix` (e.g. `[queue:email]`). */
// eslint-disable-next-line import/prefer-default-export -- named export by package convention; index.ts re-exports it
export const createDispatchLogger = (prefix: string): DispatchLogger => {
    /* eslint-disable no-console -- this logger's whole job is to write to the console; the runtime routes it to wrangler tail / Studio. */
    return {
        debug: (message, ...rest) => {
            console.debug(prefix, message, ...rest);
        },
        error: (message, ...rest) => {
            console.error(prefix, message, ...rest);
        },
        info: (message, ...rest) => {
            console.info(prefix, message, ...rest);
        },
        warn: (message, ...rest) => {
            console.warn(prefix, message, ...rest);
        },
    };
    /* eslint-enable no-console */
};
