import type { RateLimitConfig, RateLimitStatus, RateLimitValue } from "@lunora/ratelimit";
import { evaluate } from "@lunora/ratelimit";
import type { ComputedRef } from "vue";
import { computed, onScopeDispose, shallowRef } from "vue";

export interface UseRateLimitOptions {
    /** Clock injection for tests. Defaults to `Date.now`. */
    now?: () => number;

    /**
     * Re-render cadence in milliseconds while throttled, so `retryAfter` ticks
     * down and `disabled` flips back automatically. Defaults to `1000`.
     */
    tickMs?: number;
}

export interface UseRateLimitResult {
    /** Would consuming `count` (default 1) succeed right now? Does not consume. */
    check: (count?: number) => boolean;
    /** Optimistically consume `count` (default 1) locally; mirrors the server algorithm. */
    consume: (count?: number) => RateLimitStatus;
    /** `true` while a single unit cannot be consumed — convenient for disabling a control. */
    disabled: ComputedRef<boolean>;
    /** `true` while a single unit can be consumed. */
    ok: ComputedRef<boolean>;
    /** Clear local accounting (e.g. after the server confirms a reset). */
    reset: () => void;
    /** Milliseconds until the next unit is available. `0` when `ok`. */
    retryAfter: ComputedRef<number>;
}

/**
 * Client-side mirror of a rate limit for instant UX — disable a button or show
 * a countdown without a round-trip. It runs the same token-bucket / fixed-window
 * math as `@lunora/ratelimit` on the server, so the prediction agrees with the
 * authoritative check; the server remains the source of truth.
 *
 * `config` is read on every call; pass a stable reference (module constant) so
 * the reactive derived values stay settled.
 */
export const useRateLimit = (config: RateLimitConfig, options: UseRateLimitOptions = {}): UseRateLimitResult => {
    const now = options.now ?? Date.now;
    const tickMs = options.tickMs ?? 1000;

    // Mutable bucket value — not reactive itself; we gate reactivity through
    // the `epoch` shallowRef which forces re-evaluation of computed refs.
    let value: RateLimitValue | undefined;
    const epoch = shallowRef(0);

    const bump = (): void => {
        epoch.value += 1;
    };

    // Reads epoch (reactive dependency) + evaluates current status.
    // epoch.value is read via addition so the linter sees it used while also
    // establishing the Vue reactive tracking dependency.
    const status = computed((): RateLimitStatus => {
        const ts = now() + epoch.value * 0;

        return evaluate(config, value, { consume: false, count: 1, now: ts, reserve: false }).status;
    });

    let intervalHandle: ReturnType<typeof setInterval> | undefined;

    const stopInterval = (): void => {
        if (intervalHandle !== undefined) {
            clearInterval(intervalHandle);
            intervalHandle = undefined;
        }
    };

    const startIntervalIfThrottled = (): void => {
        if (status.value.ok || intervalHandle !== undefined) {
            return;
        }

        intervalHandle = setInterval(() => {
            bump();

            if (status.value.ok) {
                stopInterval();
            }
        }, tickMs);
    };

    onScopeDispose(stopInterval);

    // Kick off the ticker if we start already throttled.
    startIntervalIfThrottled();

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

    return {
        check,
        consume,
        disabled: computed(() => !status.value.ok),
        ok: computed(() => status.value.ok),
        reset,
        retryAfter: computed(() => status.value.retryAfter),
    };
};
