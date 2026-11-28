/** The background dev server's capture log, read back by `dev logs`, `status` and a failed start. */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import type { DevServerState } from "@lunora/config";
import { DEV_LOG_FILE } from "@lunora/config";

/** Upper bound on how much of the capture log is read back — a long-lived run's log can grow unbounded. */
const LOG_TAIL_MAX_BYTES = 256 * 1024;

/**
 * Read the trailing window of a log file as text, capped at
 * {@link LOG_TAIL_MAX_BYTES} so a giant long-running capture log is never
 * slurped whole; `undefined` when unreadable. When capped, the first
 * (likely partial) line of the window is dropped.
 */
const readLogWindow = (path: string): string | undefined => {
    try {
        const { size } = statSync(path);

        if (size <= LOG_TAIL_MAX_BYTES) {
            return readFileSync(path, "utf8");
        }

        const fd = openSync(path, "r");

        try {
            const buffer = Buffer.alloc(LOG_TAIL_MAX_BYTES);
            const read = readSync(fd, buffer, 0, LOG_TAIL_MAX_BYTES, size - LOG_TAIL_MAX_BYTES);
            const text = buffer.toString("utf8", 0, read);

            return text.slice(text.indexOf("\n") + 1);
        } finally {
            closeSync(fd);
        }
    } catch {
        return undefined;
    }
};

/** Read the last `count` lines of a log file (all lines when `count` <= 0, bounded by {@link LOG_TAIL_MAX_BYTES}); `[]` when unreadable. */
const readLogTail = (path: string, count: number): string[] => {
    const text = readLogWindow(path);

    if (text === undefined) {
        return [];
    }

    const lines = text.split("\n");

    // A trailing newline yields one empty final element — not a real line.
    if (lines.at(-1) === "") {
        lines.pop();
    }

    return count > 0 ? lines.slice(-count) : lines;
};

/** The absolute capture-log path for a project, honouring the state record when present. */
const resolveLogPath = (cwd: string, state: DevServerState | undefined): string => state?.logFile ?? join(cwd, DEV_LOG_FILE);

export { LOG_TAIL_MAX_BYTES, readLogTail, resolveLogPath };
