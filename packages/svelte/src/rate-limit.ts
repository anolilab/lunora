import type { RateLimitConfig, RateLimitStatus, RateLimitValue } from "@lunora/ratelimit";
import { evaluate } from "@lunora/ratelimit";
import type { Readable } from "svelte/store";
import { derived, writable } from "svelte/store";

import { isBrowser } from "../../../shared/is-browser";

export interface RateLimitOptions {
    /** Clock injection for tests. Defaults to `Date.now`. */
    now?: () => number;

    /**
     * Re-evaluation cadence in milliseconds while throttled, so `retryAfter`
     * ticks down and `disabled` flips back automatically. Defaults to `1000`.
     */
    tickMs?: number;
}

export interface RateLimitHandle {
    /** Would consuming `count` (default 1) succeed right now? Does not consume. */
    check: (count?: number) => boolean;
    /** Optimistically consume `count` (default 1) locally; mirrors the server algorithm. */
    consume: (count?: number) => RateLimitStatus;
    /** Readable store: `true` while a single unit cannot be consumed. */
    disabled: Readable<boolean>;
    /** Readable store: `true` while a single unit can be consumed. */
    ok: Readable<boolean>;
    /** Clear local accounting (e.g. after the server confirms a reset). */
    reset: () => void;
    /** Readable store: milliseconds until the next unit is available. `0` when `ok`. */
    retryAfter: Readable<number>;
    /** Stop the auto-tick interval. Call from `onDestroy` to prevent leaks. */
    teardown: () => void;
}

/**
 * Client-side mirror of a rate limit for instant UX — disable a button or show
 * a countdown without a round-trip. It runs the same token-bucket / fixed-window
 * math as `@lunora/ratelimit` on the server, so the prediction agrees with the
 * authoritative check; the server remains the source of truth.
 *
 * `config` is read on every call; pass a stable reference (module constant).
 *
 * Call `teardown()` when the component is destroyed to stop the auto-tick
 * interval (`onDestroy(handle.teardown)`).
 */
export const rateLimit = (config: RateLimitConfig, options: RateLimitOptions = {}): RateLimitHandle => {
    const now = options.now ?? Date.now;
    const tickMs = options.tickMs ?? 1000;

    // Mutable bucket value — not reactive itself; we gate reactivity through
    // the `epoch` store which triggers derived stores to re-evaluate.
    let value: RateLimitValue | undefined;
    const epoch = writable(0);

    const bump = (): void => {
        epoch.update((n) => n + 1);
    };

    // status store: derives from epoch so it re-evaluates on every bump.
    const status = derived(epoch, (): RateLimitStatus => evaluate(config, value, { consume: false, count: 1, now: now(), reserve: false }).status);

    let intervalHandle: ReturnType<typeof setInterval> | undefined;

    const stopInterval = (): void => {
        if (intervalHandle !== undefined) {
            clearInterval(intervalHandle);
            intervalHandle = undefined;
        }
    };

    let latestOk = true;

    // Track status changes to start/stop the interval.
    const unsubStatus = status.subscribe((s) => {
        latestOk = s.ok;
    });

    const startIntervalIfThrottled = (): void => {
        if (latestOk || intervalHandle !== undefined) {
            return;
        }

        intervalHandle = setInterval(() => {
            bump();

            if (latestOk) {
                stopInterval();
            }
        }, tickMs);
    };

    // Kick off the ticker if we start already throttled — but only in the
    // browser: a component's init can run server-side (this package pairs
    // with `@lunora/nuxt`'s server rendering) with no `window`, and arming a
    // bare `setInterval` there would strand a live timer for the life of the
    // process (no `onDestroy` ever fires to call `teardown`). `consume()`'s
    // own call below stays unguarded — an explicit caller invoking `consume()`
    // is actively using the handle, and `reset()`/`teardown` remain reachable.
    if (isBrowser()) {
        startIntervalIfThrottled();
    }

    const consume = (count = 1): RateLimitStatus => {
        const result = evaluate(config, value, { consume: true, count, now: now(), reserve: false });

        if (result.value !== undefined) {
            value = result.value;
        }

        bump();
        startIntervalIfThrottled();

        return result.status;
    };

    const check = (count = 1): boolean => evaluate(config, value, { consume: false, count, now: now(), reserve: false }).status.ok;

    const reset = (): void => {
        value = undefined;
        stopInterval();
        bump();
    };

    const teardown = (): void => {
        stopInterval();
        unsubStatus();
    };

    return {
        check,
        consume,
        disabled: derived(status, (s) => !s.ok),
        ok: derived(status, (s) => s.ok),
        reset,
        retryAfter: derived(status, (s) => s.retryAfter),
        teardown,
    };
};
