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

/**
 * Narrowed view over the pail instance. `createPail` returns an intersection
 * type that includes a constructor signature and `(...args: any[])` logger
 * overloads, which the type-aware linter cannot safely resolve. We only ever
 * call the level methods with a string, so we describe exactly that surface.
 */
interface PailLogger {
    debug: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
    success: (message: string) => void;
    warn: (message: string) => void;
}

/**
 * Minimal reporter shape consumed by `createPail`. We re-declare it locally
 * because `@visulima/pail`'s `reporter/*` entrypoints ship a packaging bug:
 * their `index.d.ts` re-exports `./json-reporter.d.ts` / `./pretty-reporter.d.ts`,
 * but the real declaration files are suffixed (`*.server.d.ts`). `tsc` tolerates
 * the dangling re-export, but the type-aware linter resolves `JsonReporter` /
 * `PrettyReporter` to an unresolved type. Constructing them through this typed
 * factory keeps every call site safe.
 */
interface PailReporter {
    log: (meta: unknown) => void;
}

type PailReporterConstructor = new () => PailReporter;

const wantJson = (): boolean => {
    const flag = process.env.CIRRUS_LOG_JSON;

    return flag === "1" || flag === "true";
};

const buildReporter = (): PailReporter => {
    const Reporter: PailReporterConstructor = (wantJson() ? JsonReporter : PrettyReporter) as unknown as PailReporterConstructor;

    return new Reporter();
};

const sharedPail: PailLogger = createPail({
    reporters: [buildReporter()],
    scope: ["cirrus"],
    stderr: process.stderr,
    stdout: process.stdout,
}) as unknown as PailLogger;

export const createLogger = (): Logger => {
    return {
        debug: (message) => { sharedPail.debug(message); },
        error: (message) => { sharedPail.error(message); },
        info: (message) => { sharedPail.info(message); },
        success: (message) => { sharedPail.success(message); },
        warn: (message) => { sharedPail.warn(message); },
    };
};

/** Direct access to the underlying pail instance for advanced use-cases. */
export const pail: PailLogger = sharedPail;
