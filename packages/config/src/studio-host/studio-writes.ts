/**
 * Writes a studio handler has made, so the source watcher can skip the event
 * for its own write. The handler regenerates right after it writes, so the
 * watcher's regeneration would only repeat that work.
 *
 * A skip is granted only while the file still holds exactly the text the handler
 * wrote, and each write is granted once: an edit made after it, or a second
 * event for the same write, regenerates as usual.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** How long a recorded write can still be matched by the watcher's event. */
const WINDOW_MS = 5000;

const pending = new Map<string, { expiresAt: number; text: string }>();

/** Record a write the studio handler has just made to `path`. */
export const recordStudioWrite = (path: string, text: string, now: number = Date.now()): void => {
    for (const [key, write] of pending) {
        if (write.expiresAt < now) {
            pending.delete(key);
        }
    }

    pending.set(resolve(path), { expiresAt: now + WINDOW_MS, text });
};

/**
 * Whether a watcher event for `path` is the echo of a studio write. Returns true,
 * and spends the record, only when the file still holds the text that was written.
 */
export const consumeStudioWrite = (path: string, now: number = Date.now()): boolean => {
    const key = resolve(path);
    const write = pending.get(key);

    if (write === undefined) {
        return false;
    }

    pending.delete(key);

    if (write.expiresAt < now) {
        return false;
    }

    try {
        return readFileSync(key, "utf8") === write.text;
    } catch {
        // A file that cannot be read is not an echo of anything we wrote.
        return false;
    }
};
