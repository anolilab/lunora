import type { RateLimitConfig, RateLimitStatus, RateLimitValue } from "@lunora/ratelimit";
import { evaluate } from "@lunora/ratelimit";
import type { ComputedRef, MaybeRefOrGetter } from "vue";
import { computed, onScopeDispose, shallowRef, toValue, watchEffect } from "vue";

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
 * `config` accepts a plain object, a `ref`, or a getter (`MaybeRefOrGetter`).
 * When you pass a ref/getter it is tracked reactively — changing the config
 * re-derives `status` (and the `ok` / `disabled` / `retryAfter` views) on the
 * fly. A plain object keeps working unchanged; pass a stable reference (module
 * constant) so the reactive derived values stay settled.
 */
export const useRateLimit = (config: MaybeRefOrGetter<RateLimitConfig>, options: UseRateLimitOptions = {}): UseRateLimitResult => {
    const now = options.now ?? Date.now;
    const tickMs = options.tickMs ?? 1000;

    // Mutable bucket value — not reactive itself; we gate reactivity through
    // `status`, a shallowRef updated by a `watchEffect` that re-runs on every
    // `bump()` call.
    let value: RateLimitValue | undefined;

    // `epoch` is a monotonically-incrementing version counter. `watchEffect`
    // reads it to establish a reactive dependency; every `bump()` increments it,
    // which invalidates the effect and causes `status` to re-evaluate with a
    // fresh `now()` call. This is the Vue-idiomatic equivalent of Svelte's
    // `derived(epoch, () => evaluate(...))` pattern.
    const epoch = shallowRef(0);

    const bump = (): void => {
        epoch.value += 1;
    };

    const status = shallowRef<RateLimitStatus>(evaluate(toValue(config), value, { consume: false, count: 1, now: now(), reserve: false }).status);

    // `watchEffect` re-runs synchronously (flush: "sync") whenever any reactive
    // dependency inside it changes. Reading `epoch.value` registers it as a
    // reactive dependency — each `bump()` increments it, which triggers this
    // effect and re-evaluates `status` with a fresh clock reading.
    const stopStatusEffect = watchEffect(
        () => {
            epoch.value; // reactive dependency: re-run on every bump()
            // `toValue(config)` also registers a ref/getter config as a reactive
            // dependency, so changing the config re-runs this effect.
            status.value = evaluate(toValue(config), value, { consume: false, count: 1, now: now(), reserve: false }).status;
        },
        { flush: "sync" },
    );

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

    onScopeDispose(() => {
        stopInterval();
        stopStatusEffect();
    });

    // Kick off the ticker if we start already throttled.
    startIntervalIfThrottled();

    const consume = (count = 1): RateLimitStatus => {
        const result = evaluate(toValue(config), value, { consume: true, count, now: now(), reserve: false });

        if (result.value !== undefined) {
            value = result.value;
        }

        bump();
        startIntervalIfThrottled();

        return result.status;
    };

    const check = (count = 1): boolean => evaluate(toValue(config), value, { consume: false, count, now: now(), reserve: false }).status.ok;

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
