import type { Signal } from "@angular/core";
import { computed, DestroyRef, inject, signal } from "@angular/core";
import type { RateLimitConfig, RateLimitStatus, RateLimitValue } from "@lunora/ratelimit";
import { evaluate } from "@lunora/ratelimit";

export interface RateLimitOptions {
    /**
     * `DestroyRef` whose `onDestroy` clears the interval. Defaults to
     * `inject(DestroyRef)` — the calling component/service.
     */
    destroyRef?: DestroyRef;

    /** Clock injection for tests. Defaults to `Date.now`. */
    now?: () => number;

    /**
     * Re-render cadence in milliseconds while throttled, so `retryAfter` ticks
     * down and `disabled` flips back automatically. Defaults to `1000`.
     */
    tickMs?: number;
}

export interface RateLimitResult {
    /** Would consuming `count` (default 1) succeed right now? Does not consume. */
    check: (count?: number) => boolean;

    /** Optimistically consume `count` (default 1) locally; mirrors the server algorithm. */
    consume: (count?: number) => RateLimitStatus;

    /** `true` while a single unit cannot be consumed — convenient for disabling a control. */
    disabled: Signal<boolean>;

    /** `true` while a single unit can be consumed. */
    ok: Signal<boolean>;

    /** Clear local accounting (e.g. after the server confirms a reset). */
    reset: () => void;

    /** Milliseconds until the next unit is available. `0` when `ok`. */
    retryAfter: Signal<number>;
}

/**
 * Client-side mirror of a rate limit for instant UX — disable a button or show
 * a countdown without a round-trip. It runs the same token-bucket / fixed-window
 * math as `@lunora/ratelimit` on the server, so the prediction agrees with the
 * authoritative check; the server remains the source of truth.
 *
 * Does NOT require an injection context — `client` is only used when DI-based
 * resolution is needed (omit to use the injected client).
 *
 * ```ts
 * readonly sendLimit = rateLimit({ kind: "token bucket", period: 1000, rate: 10 });
 * ```
 */
export const rateLimit = (config: RateLimitConfig, options: RateLimitOptions = {}): RateLimitResult => {
    const destroyRef = options.destroyRef ?? inject(DestroyRef);
    const now = options.now ?? Date.now;
    const tickMs = options.tickMs ?? 1000;

    // Mutable bucket value — not reactive itself.
    let value: RateLimitValue | undefined;

    // `epoch` increments on every state change; the status signal is
    // re-evaluated whenever epoch changes (via a reactive computation).
    const epoch = signal(0);

    const computeStatus = (): RateLimitStatus => evaluate(config, value, { consume: false, count: 1, now: now(), reserve: false }).status;

    const status = signal<RateLimitStatus>(computeStatus());

    const bump = (): void => {
        epoch.update((v) => v + 1);
        status.set(computeStatus());
    };

    let intervalHandle: ReturnType<typeof setInterval> | undefined;

    const stopInterval = (): void => {
        if (intervalHandle !== undefined) {
            clearInterval(intervalHandle);
            intervalHandle = undefined;
        }
    };

    const startIntervalIfThrottled = (): void => {
        if (status().ok || intervalHandle !== undefined) {
            return;
        }

        intervalHandle = setInterval(() => {
            bump();

            if (status().ok) {
                stopInterval();
            }
        }, tickMs);
    };

    // Kick off the ticker if we start already throttled.
    startIntervalIfThrottled();

    destroyRef.onDestroy(() => {
        stopInterval();
    });

    return {
        check: (count = 1): boolean => evaluate(config, value, { consume: false, count, now: now(), reserve: false }).status.ok,
        consume: (count = 1): RateLimitStatus => {
            const result = evaluate(config, value, { consume: true, count, now: now(), reserve: false });

            if (result.value !== undefined) {
                value = result.value;
            }

            bump();
            startIntervalIfThrottled();

            return result.status;
        },
        disabled: computed(() => !status().ok),
        ok: computed(() => status().ok),
        reset: (): void => {
            value = undefined;
            stopInterval();
            bump();
        },
        retryAfter: computed(() => status().retryAfter),
    };
};

// Re-export types so consumers can import everything from this module.
export type { RateLimitConfig, RateLimitStatus, RateLimitValue } from "@lunora/ratelimit";
