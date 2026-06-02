"use client";

import type { RateLimitConfig, RateLimitStatus, RateLimitValue } from "@cirrus/ratelimit";
import { evaluate } from "@cirrus/ratelimit";
import { useCallback, useEffect, useReducer, useRef } from "react";

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
    disabled: boolean;
    /** `true` while a single unit can be consumed. */
    ok: boolean;
    /** Clear local accounting (e.g. after the server confirms a reset). */
    reset: () => void;
    /** Milliseconds until the next unit is available. `0` when `ok`. */
    retryAfter: number;
}

/**
 * Client-side mirror of a rate limit for instant UX — disable a button or show
 * a countdown without a round-trip. It runs the same token-bucket / fixed-window
 * math as `@cirrus/ratelimit` on the server, so the prediction agrees with the
 * authoritative check; the server remains the source of truth.
 *
 * `config` is read on every render; pass a stable reference (module constant or
 * `useMemo`) so the `consume`/`check` callbacks keep a steady identity.
 */
export const useRateLimit = (config: RateLimitConfig, options: UseRateLimitOptions = {}): UseRateLimitResult => {
    const now = options.now ?? Date.now;
    const tickMs = options.tickMs ?? 1000;
    const valueRef = useRef<RateLimitValue | undefined>(undefined);
    const [, forceRender] = useReducer((count: number): number => count + 1, 0);

    const consume = useCallback(
        (count = 1): RateLimitStatus => {
            const { status, value } = evaluate(config, valueRef.current, { consume: true, count, now: now(), reserve: false });

            if (value !== null) {
                valueRef.current = value;
            }

            forceRender();

            return status;
        },
        [config, now],
    );

    const check = useCallback(
        (count = 1): boolean => evaluate(config, valueRef.current, { consume: false, count, now: now(), reserve: false }).status.ok,
        [config, now],
    );

    const reset = useCallback((): void => {
        valueRef.current = undefined;
        forceRender();
    }, []);

    const { status } = evaluate(config, valueRef.current, { consume: false, count: 1, now: now(), reserve: false });

    useEffect(() => {
        if (status.ok) {
            return undefined;
        }

        const handle = setInterval(forceRender, tickMs);

        return () => {
            clearInterval(handle);
        };
    }, [status.ok, tickMs]);

    return { check, consume, disabled: !status.ok, ok: status.ok, reset, retryAfter: status.retryAfter };
};
