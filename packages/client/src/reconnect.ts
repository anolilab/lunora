import type { ReconnectOptions } from "./types";

/**
 * Exponential backoff calculator with optional jitter.
 *
 * `next()` doubles the delay each call up to `maxDelayMs`. When `jitter` is
 * enabled the returned value is randomized in `[delay/2, delay]` so a fleet
 * of clients reconnecting at the same time spread out their retries.
 */
export interface ReconnectCalculator {
    /** Returns the delay to wait before the next reconnect attempt. */
    next: () => number;
    /** Resets the backoff to the initial delay (call on successful reconnect). */
    reset: () => void;
}

export const createReconnect = (options: ReconnectOptions = {}, random: () => number = Math.random): ReconnectCalculator => {
    const initialDelayMs = options.initialDelayMs ?? 250;
    const maxDelayMs = options.maxDelayMs ?? 30_000;
    const jitter = options.jitter ?? true;

    let attempt = 0;

    return {
        next() {
            const exponential = Math.min(maxDelayMs, initialDelayMs * 2 ** attempt);

            attempt += 1;

            if (!jitter) {
                return exponential;
            }

            // Equal jitter: pick a value in [exponential/2, exponential]
            const min = exponential / 2;

            return Math.floor(min + random() * (exponential - min));
        },
        reset() {
            attempt = 0;
        },
    };
};
