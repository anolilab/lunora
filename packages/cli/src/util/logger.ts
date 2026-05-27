/**
 * Logger used by all CLI commands. Backed by `@visulima/pail` which gives
 * us level-aware output, structured `success`/`warn`/`error` channels and
 * (importantly) the same Spinner / Reporter primitives we use elsewhere.
 *
 * Two reporters are wired:
 *  - `PrettyReporter` for interactive terminals
 *  - `JsonReporter` when `CIRRUS_LOG_JSON=1` (CI / machine-readable mode)
 *
 * The public surface stays the same `Logger` shape the existing commands
 * already program against so we don't have to touch every command.
 */
import { JsonReporter } from "@visulima/pail/reporter/json";
import { PrettyReporter } from "@visulima/pail/reporter/pretty";
import { createPail } from "@visulima/pail/server";

export interface Logger {
    debug?: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
    success: (message: string) => void;
    warn: (message: string) => void;
}

const wantJson = (): boolean => {
    const flag = process.env.CIRRUS_LOG_JSON;

    return flag === "1" || flag === "true";
};

const sharedPail: ReturnType<typeof createPail> = createPail({
    reporters: [wantJson() ? new JsonReporter() : new PrettyReporter()],
    scope: ["cirrus"],
    stderr: process.stderr,
    stdout: process.stdout,
});

export const createLogger = (): Logger => {
    return {
        debug: (message) => sharedPail.debug(message),
        error: (message) => sharedPail.error(message),
        info: (message) => sharedPail.info(message),
        success: (message) => sharedPail.success(message),
        warn: (message) => sharedPail.warn(message),
    };
};

/** Direct access to the underlying pail instance for advanced use-cases. */
export const pail: typeof sharedPail = sharedPail;
