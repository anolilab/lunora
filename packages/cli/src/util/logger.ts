/**
 * Logger used by all CLI commands. Backed by `@visulima/pail` which gives
 * us level-aware output, structured `success`/`warn`/`error` channels and
 * (importantly) the same Spinner / Reporter primitives we use elsewhere.
 *
 * Two reporters are wired: `PrettyReporter` for interactive terminals and
 * `JsonReporter` when `LUNORA_LOG_JSON=1` (CI / machine-readable mode).
 *
 * The public surface stays the same `Logger` shape the existing commands
 * already program against so we don't have to touch every command.
 */
import { JsonReporter } from "@visulima/pail/reporter/json";
import { PrettyReporter } from "@visulima/pail/reporter/pretty";
import { createPail } from "@visulima/pail/server";

interface Logger {
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
    const flag = process.env.LUNORA_LOG_JSON;

    return flag === "1" || flag === "true";
};

const buildReporter = (): PailReporter => {
    const Reporter: PailReporterConstructor = (wantJson() ? JsonReporter : PrettyReporter) as PailReporterConstructor;

    return new Reporter();
};

/**
 * Lazily-constructed pail instance. Building it (plus its Pretty/Json reporter)
 * is deferred until the first `createLogger()` / `getPail()` call so that merely
 * importing this module stays side-effect-free (`package.json` declares
 * `sideEffects:false`) — `lunora --help` / `-v` never pay the construction cost.
 */
let sharedPail: PailLogger | undefined;

const getPail = (): PailLogger => {
    sharedPail ??= createPail({
        reporters: [buildReporter()],
        scope: ["lunora"],
        stderr: process.stderr,
        stdout: process.stdout,
    }) as PailLogger;

    return sharedPail;
};

const createLogger = (): Logger => {
    return {
        debug: (message) => {
            getPail().debug(message);
        },
        error: (message) => {
            getPail().error(message);
        },
        info: (message) => {
            getPail().info(message);
        },
        success: (message) => {
            getPail().success(message);
        },
        warn: (message) => {
            getPail().warn(message);
        },
    };
};

/**
 * Logger whose every channel writes to `process.stderr`. Used by commands in
 * `--format json` mode so all human/progress output stays off stdout — leaving
 * stdout for the single JSON document the command prints, so `… --format json`
 * stays cleanly pipeable (`| jq`). Each line carries a one-character level tag
 * so the stream is still readable when a human watches it.
 */
const createStderrLogger = (): Logger => {
    const write = (tag: string, message: string): void => {
        process.stderr.write(`${tag} ${message}\n`);
    };

    return {
        debug: (message) => {
            write("debug", message);
        },
        error: (message) => {
            write("error", message);
        },
        info: (message) => {
            write("info ", message);
        },
        success: (message) => {
            write("ok   ", message);
        },
        warn: (message) => {
            write("warn ", message);
        },
    };
};

/**
 * Direct access to the underlying pail instance for advanced use-cases.
 * A Proxy keeps the public `pail` binding lazy: the real pail is only
 * constructed on first property access, so importing this module (and thus
 * the package barrel) stays side-effect-free.
 */
const pail: PailLogger = new Proxy({} as PailLogger, {
    get(_target, property: keyof PailLogger) {
        const instance = getPail();
        const value = instance[property];

        return typeof value === "function" ? value.bind(instance) : value;
    },
});

export type { Logger };
export { createLogger, createStderrLogger, getPail, pail };
