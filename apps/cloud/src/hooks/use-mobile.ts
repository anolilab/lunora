import { useEffect, useState } from "react";

const MOBILE_BREAKPOINT = 768;

/**
 * Tracks whether the viewport is below the mobile breakpoint (768px). Drives the
 * sidebar's off-canvas (sheet) mode on narrow screens. Returns `false` until the
 * first effect runs, so SSR/first paint assumes desktop.
 */
export function useIsMobile(): boolean {
    const [isMobile, setIsMobile] = useState<boolean | undefined>(undefined);

    useEffect(() => {
        const mql = globalThis.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
        const onChange = (): void => {
            setIsMobile(globalThis.innerWidth < MOBILE_BREAKPOINT);
        };

        mql.addEventListener("change", onChange);
        setIsMobile(globalThis.innerWidth < MOBILE_BREAKPOINT);

        return () => {
            mql.removeEventListener("change", onChange);
        };
    }, []);

    return Boolean(isMobile);
}
