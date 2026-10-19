import { useEffect, useRef } from "react";

import { errorCode } from "../lib/internal";

/** The longest a failing poll backs off to, in milliseconds. */
const MAX_BACKOFF_MS = 60_000;

/** Error codes no retry will fix: polling stops on them until `enabled` toggles. */
const TERMINAL_CODES: ReadonlySet<string> = new Set(["FORBIDDEN", "UNAUTHORIZED"]);

/** Default polling cadence for auto-refresh, in milliseconds. */
export const DEFAULT_AUTO_REFRESH_MS = 5000;

/**
 * Call `onTick` on a timer while `enabled`, for panels whose backend has no live
 * subscription channel (the scheduler, R2, D1, the SessionDO — all HTTP-only).
 * Polling is the honest "live" here: a timer-driven scheduler has no
 * client-observable write event to push on, so the UI watches jobs count down
 * and disappear by re-asking.
 *
 * Each tick is scheduled after the previous one settles (`setTimeout` chaining,
 * not `setInterval`), so a slow request never overlaps the next. When `onTick`
 * returns a promise that rejects (or throws), the delay doubles up to
 * {@link MAX_BACKOFF_MS} and resets to `intervalMs` on the next success; an
 * `UNAUTHORIZED` / `FORBIDDEN` rejection stops polling until `enabled` toggles,
 * since re-asking cannot fix a missing credential. A sync `onTick` counts as a
 * success.
 *
 * Ticks are skipped while the tab is hidden (`document.hidden`) so a backgrounded
 * studio doesn't keep hammering the worker. `onTick` is held in a ref so a
 * fresh closure each render doesn't reset the timer; only `enabled`/`intervalMs`
 * do. The timer is cleared on disable and unmount.
 */
export const useAutoRefresh = (onTick: () => unknown, enabled: boolean, intervalMs: number = DEFAULT_AUTO_REFRESH_MS): void => {
    const tickRef = useRef(onTick);

    // Keep the latest `onTick` in a ref via an effect rather than a render-phase
    // write (which trips React Compiler's "no refs during render"). `onTick` is
    // only read in the async timer below, so the post-commit update is always
    // current by the time it fires — a fresh closure each render still doesn't
    // reset the timer.
    useEffect(() => {
        tickRef.current = onTick;
    });

    useEffect(() => {
        if (!enabled) {
            return undefined;
        }

        let delay = intervalMs;
        let stopped = false;
        let id: ReturnType<typeof setTimeout> | undefined;

        const schedule = (): void => {
            if (!stopped) {
                // eslint-disable-next-line @typescript-eslint/no-use-before-define -- `tick` reschedules itself through here
                id = setTimeout(tick, delay);
            }
        };

        const succeeded = (): void => {
            delay = intervalMs;
            schedule();
        };

        const failed = (error: unknown): void => {
            const code = errorCode(error);

            if (code !== undefined && TERMINAL_CODES.has(code)) {
                return;
            }

            delay = Math.max(intervalMs, Math.min(delay * 2, MAX_BACKOFF_MS));
            schedule();
        };

        const tick = (): void => {
            const globalDocument = (globalThis as { document?: { hidden?: boolean } }).document;

            if (globalDocument?.hidden === true) {
                schedule();

                return;
            }

            let result: unknown;

            try {
                result = tickRef.current();
            } catch (error) {
                failed(error);

                return;
            }

            if (result instanceof Promise) {
                result.then(succeeded).catch(failed);
            } else {
                succeeded();
            }
        };

        schedule();

        return () => {
            stopped = true;
            clearTimeout(id);
        };
    }, [enabled, intervalMs]);
};
