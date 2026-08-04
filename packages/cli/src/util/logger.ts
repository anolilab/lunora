/**
 * Logger used by all CLI commands. Backed by `@visulima/pail` which gives
 * us level-aware output, structured `success`/`warn`/`error` channels and
 * (importantly) the same Spinner / Reporter primitives we use elsewhere.
 *
 * Two reporters are wired: `LunoraReporter` for normal runs (it paints the
 * create-astro-style step badges of the `init` flow and renders the standard
 * levels itself — log types without a badge print plain) and `JsonReporter` when
 * `LUNORA_LOG_JSON=1` (CI / machine-readable mode).
 *
 * The public surface stays the same `Logger` shape the existing commands
 * already program against so we don't have to touch every command; the badged
 * step output is reached through the separate `logStep` helper.
 */
import type { StepBadgeName } from "@lunora/config";
import { LunoraReporter, STEP_BADGE_NAMES } from "@lunora/config";
import { JsonReporter } from "@visulima/pail/reporter/json";
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

/**
 * Lazily-constructed pail instance. Building it (plus its Pretty/Json reporter)
 * is deferred until the first `createLogger()` / `getPail()` call so that merely
 * importing this module stays side-effect-free (`package.json` declares
 * `sideEffects:false`) — `lunora --help` / `-v` never pay the construction cost.
 */
let sharedPail: PailLogger | undefined;

/**
 * Programmatically forced JSON mode (`lunora dev --json` / agent auto-detect),
 * OR-ed with the `LUNORA_LOG_JSON` env flag. Module-level because the pail
 * instance is a lazily-built singleton.
 */
let jsonForced = false;

/** Reporters installed via {@link configureLogHandlers}; `undefined` = default selection. */
let configuredReporters: PailReporter[] | undefined;

const wantJson = (): boolean => {
    if (jsonForced) {
        return true;
    }

    const flag = process.env.LUNORA_LOG_JSON;

    return flag === "1" || flag === "true";
};

/** Instantiate a reporter class through the local {@link PailReporterConstructor} typing (see its packaging-bug note). */
const constructReporter = (Reporter: unknown): PailReporter => new (Reporter as PailReporterConstructor)();

const buildReporters = (): PailReporter[] => {
    // Forced JSON (`--json` / agent auto-detect) is a machine-readability
    // contract — it must win even over an explicitly configured reporter set,
    // or automation parsing stdout breaks.
    if (jsonForced) {
        return [constructReporter(JsonReporter)];
    }

    if (configuredReporters !== undefined && configuredReporters.length > 0) {
        return configuredReporters;
    }

    return [constructReporter(wantJson() ? JsonReporter : LunoraReporter)];
};

/**
 * Switch every subsequent log line to machine-readable JSON (pail's
 * `JsonReporter`), equivalent to `LUNORA_LOG_JSON=1`. Safe to call at any
 * point: the shared pail is dropped so the next log call rebuilds it with the
 * JSON reporter. Used by `lunora dev --json` and the AI-agent auto-detection.
 */
const forceJsonLogging = (): void => {
    if (jsonForced) {
        return;
    }

    jsonForced = true;
    sharedPail = undefined;
};

/**
 * Composable log handlers, mirroring the reporter primitives the logger is
 * built from. `compose` maps directly onto pail's `reporters: [...]` array, so
 * e.g. `configureLogHandlers(logHandlers.compose(logHandlers.console(), logHandlers.json()))`
 * keeps human-readable output while also emitting structured JSON lines.
 */
const logHandlers = {
    compose: (...reporters: PailReporter[]): PailReporter[] => reporters,
    console: (): PailReporter => constructReporter(LunoraReporter),
    json: (): PailReporter => constructReporter(JsonReporter),
};

/**
 * Install a custom reporter set (see {@link logHandlers}). Replaces the
 * default console-or-JSON selection; the shared pail is rebuilt on next use.
 */
const configureLogHandlers = (reporters: PailReporter | PailReporter[]): void => {
    configuredReporters = Array.isArray(reporters) ? reporters : [reporters];
    sharedPail = undefined;
};

/**
 * Custom pail log types backing the `init` flow's step badges. Each becomes a
 * `pail.<name>(message)` method; `LunoraReporter` paints them as badge boxes
 * (off-TTY fallback) while the colors live in `@lunora/config`'s theme. The
 * `informational` RFC5424 level keeps them on stdout and visible at the default
 * verbosity (pail rejects the `"info"` shorthand).
 */
const STEP_LOG_TYPES = Object.fromEntries(STEP_BADGE_NAMES.map((name) => [name, { label: name, logLevel: "informational" }])) as Record<
    StepBadgeName,
    { label: string; logLevel: "informational" }
>;

const getPail = (): PailLogger => {
    sharedPail ??= createPail({
        reporters: buildReporters(),
        scope: ["lunora"],
        stderr: process.stderr,
        stdout: process.stdout,
        types: STEP_LOG_TYPES,
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

/**
 * Emit a badged step line through the shared pail (the `init` flow's off-TTY
 * fallback for the create-astro-style transcript). The `message` may contain
 * newlines — `LunoraReporter` indents continuation lines under the badge so a
 * dimmed answer sits below its question.
 */
const logStep = (type: StepBadgeName, message: string): void => {
    (getPail() as unknown as Record<StepBadgeName, (message: string) => void>)[type](message);
};

export type { Logger, PailReporter };
export { configureLogHandlers, createLogger, createStderrLogger, forceJsonLogging, getPail, logHandlers, logStep, pail };
