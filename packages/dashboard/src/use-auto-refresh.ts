import { useEffect, useRef } from "react";

/** Default polling cadence for auto-refresh, in milliseconds. */
export const DEFAULT_AUTO_REFRESH_MS = 5000;

/**
 * Call `onTick` on a fixed interval while `enabled`, for panels whose backend
 * has no live subscription channel (the scheduler, R2, D1, the SessionDO — all
 * HTTP-only). Polling is the honest "live" here: a timer-driven scheduler has no
 * client-observable write event to push on, so the UI watches jobs count down
 * and disappear by re-asking.
 *
 * Ticks are skipped while the tab is hidden (`document.hidden`) so a backgrounded
 * dashboard doesn't keep hammering the worker. `onTick` is held in a ref so a
 * fresh closure each render doesn't reset the interval; only `enabled`/`intervalMs`
 * do. The interval is cleared on disable and unmount.
 */
export function useAutoRefresh(onTick: () => void, enabled: boolean, intervalMs: number = DEFAULT_AUTO_REFRESH_MS): void {
    const tickRef = useRef(onTick);

    tickRef.current = onTick;

    useEffect(() => {
        if (!enabled) {
            return undefined;
        }

        const id = setInterval(() => {
            const doc = (globalThis as { document?: { hidden?: boolean } }).document;

            if (doc?.hidden === true) {
                return;
            }

            tickRef.current();
        }, intervalMs);

        return () => {
            clearInterval(id);
        };
    }, [enabled, intervalMs]);
}
