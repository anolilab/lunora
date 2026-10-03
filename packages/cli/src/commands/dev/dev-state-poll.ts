import { setTimeout as sleep } from "node:timers/promises";

import type { DevServerState } from "@lunora/config";
import { readLiveDevServerState } from "@lunora/config";

/**
 * Re-read the live `.lunora/dev.json` record every `intervalMs` until `pick`
 * returns a value, the deadline passes, or `signal` aborts — `undefined` for the
 * last two. For facts another process writes into the record later (the URL
 * Vite resolves, the tunnel URL cloudflared is assigned).
 *
 * The sleep keeps the event loop alive on purpose: a `--background` parent has
 * nothing else holding it open while it waits, and an unref'd timer would let
 * it exit mid-wait. Long-lived callers pass `signal` so shutdown cancels it.
 */
const pollDevServerState = async <T>(
    cwd: string,
    pick: (state: DevServerState | undefined) => T | undefined,
    options: { intervalMs?: number; signal?: AbortSignal; timeoutMs: number },
): Promise<T | undefined> => {
    const deadline = Date.now() + options.timeoutMs;

    while (options.signal?.aborted !== true) {
        const picked = pick(readLiveDevServerState(cwd));

        if (picked !== undefined) {
            return picked;
        }

        if (Date.now() >= deadline) {
            return undefined;
        }

        try {
            // eslint-disable-next-line no-await-in-loop -- polling: each read follows the previous wait
            await sleep(options.intervalMs ?? 500, undefined, { signal: options.signal });
        } catch {
            // Aborted: the caller is shutting down.
            return undefined;
        }
    }

    return undefined;
};

export default pollDevServerState;
