import { useSyncExternalStore } from "react";

const MOBILE_BREAKPOINT = 768;

const mobileQuery = `(max-width: ${String(MOBILE_BREAKPOINT - 1)}px)`;

const subscribe = (onChange: () => void): (() => void) => {
    const mql = globalThis.matchMedia(mobileQuery);

    mql.addEventListener("change", onChange);

    return () => {
        mql.removeEventListener("change", onChange);
    };
};

const getSnapshot = (): boolean => globalThis.innerWidth < MOBILE_BREAKPOINT;

/** Server and first hydration render assume desktop, so the markup matches before the client measures. */
const getServerSnapshot = (): boolean => false;

/**
 * Tracks whether the viewport is below the mobile breakpoint (768px). Drives the
 * sidebar's off-canvas (sheet) mode on narrow screens. Subscribes to the media
 * query, so it follows resizes without setting state from an effect.
 */
export function useIsMobile(): boolean {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
