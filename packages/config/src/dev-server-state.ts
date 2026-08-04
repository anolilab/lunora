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

/**
 * Env carrying the PID of a parent that holds a *provisional* state record it
 * expects the child dev server to supersede. The CLI claims `.lunora/dev.json`
 * with its own PID before spawning the real server (closing the duplicate-start
 * race for the vite flavor and the wrangler daemon), then hands its PID down
 * via this variable; the child's claim (see {@link claimDevServerState}'s
 * `supersedePid`) may replace exactly that record with the authoritative
 * URL + PID.
 */
const DEV_HANDOFF_ENV = "LUNORA_DEV_HANDOFF_PID";

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
 * True when a process with `pid` is currently alive AND signalable by this
 * user. Signal `0` performs the existence check without delivering anything.
 *
 * `EPERM` ("alive but another user's process") deliberately counts as NOT
 * alive here: every dev server this module tracks was spawned by the current
 * user, so a PID we cannot signal is by definition a recycled PID — treating
 * it as running would wedge the lockfile permanently and aim `dev stop`'s
 * kill escalation at an innocent process.
 */
const isProcessAlive = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
};

/** Tolerated skew between a process's start time and the record it wrote (spawn → listen → write can take seconds). */
const START_TIME_SKEW_MS = 10_000;

/**
 * Kernel clock-tick rate backing `/proc/<pid>/stat`'s `starttime` field.
 * Linux fixes `USER_HZ` at 100 for userspace on every mainstream platform,
 * independent of the kernel's internal HZ.
 */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

/**
 * Wall-clock start time of `pid` in epoch ms, or `undefined` where the
 * platform doesn't expose it cheaply (non-Linux) or the read fails. Combines
 * `/proc/<pid>/stat` field 22 (`starttime`, in clock ticks since boot) with
 * `/proc/stat`'s `btime` (boot time, epoch seconds).
 */
const processStartTimeMs = (pid: number): number | undefined => {
    if (process.platform !== "linux") {
        return undefined;
    }

    try {
        const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
        // The comm field is parenthesized and may itself contain spaces or
        // parens — split after the LAST `)`, then `starttime` (field 22
        // overall) is the 20th of the remaining space-separated fields.
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const startTicks = Number(fields[19]);
        const bootLine = readFileSync("/proc/stat", "utf8")
            .split("\n")
            .find((line) => line.startsWith("btime "));
        const bootSeconds = Number(bootLine?.slice("btime ".length));

        if (!Number.isFinite(startTicks) || !Number.isFinite(bootSeconds)) {
            return undefined;
        }

        return bootSeconds * 1000 + (startTicks / LINUX_CLOCK_TICKS_PER_SECOND) * 1000;
    } catch {
        return undefined;
    }
};

/**
 * True when the record's PID verifiably still refers to the dev server that
 * wrote the record — not merely "some process exists with that number".
 * Guards against PID reuse: a server process necessarily starts BEFORE its
 * record is written, so a process that started after `startedAt` (+ skew) is
 * a recycled PID wearing the corpse's number. The start-time check runs only
 * where the platform exposes it (Linux); elsewhere liveness alone decides.
 */
const isRecordedProcessCurrent = (state: DevServerState): boolean => {
    if (!isProcessAlive(state.pid)) {
        return false;
    }

    const recordedAtMs = state.startedAt === undefined ? Number.NaN : Date.parse(state.startedAt);

    if (Number.isNaN(recordedAtMs)) {
        return true;
    }

    const actualStartMs = processStartTimeMs(state.pid);

    return actualStartMs === undefined || actualStartMs <= recordedAtMs + START_TIME_SKEW_MS;
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
 * `undefined`. A record whose PID is dead — or recycled onto a different
 * process (see {@link isRecordedProcessCurrent}) — is stale: it is cleared on
 * the spot so subsequent starts don't keep re-reading a corpse.
 */
const readLiveDevServerState = (projectRoot: string): DevServerState | undefined => {
    const state = readDevServerState(projectRoot);

    if (state === undefined) {
        return undefined;
    }

    if (isRecordedProcessCurrent(state)) {
        return state;
    }

    clearDevServerState(projectRoot, state.pid);

    return undefined;
};

/** Result of {@link claimDevServerState}: claimed, or lost to the live server already recorded. */
interface ClaimDevServerStateResult {
    /** The live record that won the race, when `ok` is `false`. */
    existing?: DevServerState;
    /** Whether this process now owns the record. */
    ok: boolean;
}

/**
 * Atomically claim `.lunora/dev.json` for a starting dev server. Unlike
 * {@link writeDevServerState}, the create is exclusive (`wx`), which closes
 * the check-then-write race where two near-simultaneous starts both read "no
 * server", both spawn, and the second silently clobbers the first's record —
 * leaving `dev stop` blind to the survivor. On losing the race to a LIVE
 * server the claim fails with that record; a stale incumbent is cleared and
 * the claim retried. Still best-effort on I/O errors: an unwritable checkout
 * degrades to the plain (non-exclusive) write, never a crash.
 *
 * `supersedePid` names ONE live record this claim may replace instead of
 * losing to: the provisional record a parent CLI wrote before spawning this
 * server (handed down via {@link DEV_HANDOFF_ENV}). Any other live record
 * still wins.
 */

/**
 * Resolve an exclusive-create conflict for {@link claimDevServerState}:
 * someone holds the file. Live (and not us) → they won — unless it is the
 * provisional record this claim was spawned to supersede. `undefined` means
 * the incumbent was stale (readLive cleared it) and the exclusive create
 * should be retried.
 */
const resolveClaimConflict = (projectRoot: string, state: DevServerState, supersedePid: number | undefined): ClaimDevServerStateResult | undefined => {
    const existing = readLiveDevServerState(projectRoot);

    if (existing === undefined) {
        return undefined;
    }

    if (supersedePid !== undefined && existing.pid === supersedePid) {
        return { ok: writeDevServerState(projectRoot, state) !== undefined };
    }

    if (existing.pid !== state.pid) {
        return { existing, ok: false };
    }

    // Our own pid already owns the record (restart in-process) — refresh it.
    return { ok: writeDevServerState(projectRoot, state) !== undefined };
};

const claimDevServerState = (projectRoot: string, state: DevServerState, options?: { supersedePid?: number }): ClaimDevServerStateResult => {
    const path = join(projectRoot, DEV_STATE_FILE);
    const payload = `${JSON.stringify(state, undefined, 2)}\n`;

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            mkdirSync(join(projectRoot, DEV_STATE_DIR), { recursive: true });
            writeFileSync(path, payload, { encoding: "utf8", flag: "wx" });

            return { ok: true };
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                // Permission/IO problem, not a race — fall back to the
                // best-effort write so a read-only checkout behaves as before.
                return { ok: writeDevServerState(projectRoot, state) !== undefined };
            }

            const resolved = resolveClaimConflict(projectRoot, state, options?.supersedePid);

            if (resolved !== undefined) {
                return resolved;
            }
        }
    }

    return { ok: writeDevServerState(projectRoot, state) !== undefined };
};

export type { ClaimDevServerStateResult, DevServerMode, DevServerState };
export {
    claimDevServerState,
    clearDevServerState,
    DEV_DAEMON_ENV,
    DEV_HANDOFF_ENV,
    DEV_LOG_FILE,
    DEV_LOG_FILE_ENV,
    DEV_STATE_DIR,
    DEV_STATE_FILE,
    isProcessAlive,
    isRecordedProcessCurrent,
    readDevServerState,
    readLiveDevServerState,
    updateDevServerState,
    writeDevServerState,
};
