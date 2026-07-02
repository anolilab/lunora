/**
 * `.lunora/dev.json` — the running dev server's state record.
 *
 * Written when a dev server starts (by `lunora dev` for the wrangler
 * orchestration, or by `@lunora/vite`'s dev-state plugin when the project runs
 * through Vite) and removed on shutdown. It doubles as a lockfile: a second
 * `lunora dev` finds a live record and reports the existing instance instead of
 * spawning a conflicting server, and `lunora dev stop|status|logs` resolve the
 * running instance from it. This is what lets AI agents manage a long-running
 * dev server without parsing terminal output or tracking PIDs themselves.
 *
 * Lives next to `.lunora/project.json` (see `linked-project.ts`) — per-checkout,
 * machine-specific, gitignored by convention, and secret-free.
 *
 * Every read is best-effort: a missing file, malformed JSON, or unexpected
 * shape collapses to `undefined`. A record whose PID is no longer alive is
 * stale* — `readLiveDevServerState` clears it and reports "not running", so a
 * crashed or SIGKILLed server never wedges the next start.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import join from "./path";

/** Directory holding per-checkout Lunora state (gitignored by convention). */
const DEV_STATE_DIR = ".lunora";

/** The dev-server state filename, relative to the project root. */
const DEV_STATE_FILE: string = join(DEV_STATE_DIR, "dev.json");

/** Log file a backgrounded dev server's output is captured to, relative to the project root. */
const DEV_LOG_FILE: string = join(DEV_STATE_DIR, "dev.log");

/**
 * Marker env `lunora dev --background` sets on the detached server process
 * (the daemon `lunora dev` or `vite dev`), so it records itself as
 * `background: true` — and, for the CLI daemon, never re-detects an agent and
 * recurses into background mode again.
 */
const DEV_DAEMON_ENV = "LUNORA_DEV_DAEMON";

/** Env carrying the capture-log path into the detached server, recorded in the state file. */
const DEV_LOG_FILE_ENV = "LUNORA_DEV_LOG_FILE";

/** How the recorded dev server runs. */
type DevServerMode = "cli" | "vite";

/** The state record persisted to `.lunora/dev.json`. */
interface DevServerState {
    /** Whether the server was detached into the background (`lunora dev --background`). */
    background?: boolean;
    /** Absolute path of the log file capturing the server's output, when captured. */
    logFile?: string;
    /** `"cli"` for the `lunora dev` wrangler orchestration, `"vite"` for a Vite dev server. */
    mode: DevServerMode;
    /** PID of the process to signal for shutdown (the orchestrating CLI or the Vite process). */
    pid: number;
    /** ISO-8601 stamp written at startup, purely informational (drives `status` uptime). */
    startedAt?: string;
    /** The embedded studio server's URL, when it runs. */
    studioUrl?: string;
    /** The primary URL serving the worker/app. */
    url: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";

/** Read a string field, returning `undefined` for absent/empty/non-string. */
const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
    const value = record[key];

    return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * True when a process with `pid` is currently alive. Signal `0` performs the
 * existence check without delivering anything; `EPERM` means "alive but not
 * ours", so it still counts as running.
 */
const isProcessAlive = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);

        return true;
    } catch (error: unknown) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

/**
 * Read the state record from `.lunora/dev.json`, or `undefined` when there is
 * no usable record. Best-effort; performs NO liveness check — use
 * {@link readLiveDevServerState} for "is a dev server actually running".
 */
const readDevServerState = (projectRoot: string): DevServerState | undefined => {
    const path = join(projectRoot, DEV_STATE_FILE);

    if (!existsSync(path)) {
        return undefined;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }

    if (!isObject(parsed) || typeof parsed["pid"] !== "number") {
        return undefined;
    }

    const url = stringField(parsed, "url");

    if (url === undefined) {
        return undefined;
    }

    return {
        background: parsed["background"] === true,
        logFile: stringField(parsed, "logFile"),
        mode: parsed["mode"] === "vite" ? "vite" : "cli",
        pid: parsed["pid"],
        startedAt: stringField(parsed, "startedAt"),
        studioUrl: stringField(parsed, "studioUrl"),
        url,
    };
};

/**
 * Write the state record to `.lunora/dev.json`, creating the `.lunora/`
 * directory when absent. Returns the absolute path written, or `undefined`
 * when the write failed (state is convenience metadata — a read-only checkout
 * must never crash dev startup).
 */
const writeDevServerState = (projectRoot: string, state: DevServerState): string | undefined => {
    try {
        mkdirSync(join(projectRoot, DEV_STATE_DIR), { recursive: true });

        const path = join(projectRoot, DEV_STATE_FILE);

        writeFileSync(path, `${JSON.stringify(state, undefined, 2)}\n`, "utf8");

        return path;
    } catch {
        return undefined;
    }
};

/**
 * Merge `patch` into the existing state record, when one exists. Used by the
 * CLI to stamp `background`/`logFile` onto the record the Vite plugin wrote.
 * Returns the merged record, or `undefined` when there was nothing to update.
 */
const updateDevServerState = (projectRoot: string, patch: Partial<DevServerState>): DevServerState | undefined => {
    const existing = readDevServerState(projectRoot);

    if (existing === undefined) {
        return undefined;
    }

    const merged = { ...existing, ...patch };

    writeDevServerState(projectRoot, merged);

    return merged;
};

/**
 * Remove `.lunora/dev.json`. Idempotent and never throws. When `expectedPid`
 * is given, the file is only removed while it still records that PID — so a
 * shutting-down server can't clobber the record a newer server just wrote.
 */
const clearDevServerState = (projectRoot: string, expectedPid?: number): void => {
    try {
        if (expectedPid !== undefined) {
            const current = readDevServerState(projectRoot);

            if (current !== undefined && current.pid !== expectedPid) {
                return;
            }
        }

        rmSync(join(projectRoot, DEV_STATE_FILE), { force: true });
    } catch {
        /* best-effort */
    }
};

/**
 * The state record of a dev server that is verifiably running right now, or
 * `undefined`. A record whose PID is dead is stale: it is cleared on the spot
 * so subsequent starts don't keep re-reading a corpse.
 */
const readLiveDevServerState = (projectRoot: string): DevServerState | undefined => {
    const state = readDevServerState(projectRoot);

    if (state === undefined) {
        return undefined;
    }

    if (isProcessAlive(state.pid)) {
        return state;
    }

    clearDevServerState(projectRoot, state.pid);

    return undefined;
};

export type { DevServerMode, DevServerState };
export {
    clearDevServerState,
    DEV_DAEMON_ENV,
    DEV_LOG_FILE,
    DEV_LOG_FILE_ENV,
    DEV_STATE_DIR,
    DEV_STATE_FILE,
    isProcessAlive,
    readDevServerState,
    readLiveDevServerState,
    updateDevServerState,
    writeDevServerState,
};
