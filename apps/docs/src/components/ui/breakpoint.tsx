import type { FC, ReactNode } from "react";
import { useEffect, useLayoutEffect, useState } from "react";

const screens = {
    "2xl": "1536px",
    lg: "1024px",
    md: "768px",
    sm: "640px",
    xl: "1280px",
};

// https://github.com/pmndrs/zustand/blob/833f57ed131e94f3ed48627d4cfbf09cb9c7df03/src/react.ts#L20-L23
const isSSR = globalThis.window === undefined || !globalThis.navigator || /ServerSideRendering|^Deno\//.test(globalThis.navigator.userAgent);

const isBrowser = !isSSR;

const useIsomorphicEffect = isBrowser ? useLayoutEffect : useEffect;

function useBreakpoint(breakpoint: keyof typeof screens, defaultValue: boolean = false) {
    const [match, setMatch] = useState(() => defaultValue);

    useIsomorphicEffect(() => {
        if (!(isBrowser && "matchMedia" in globalThis && globalThis.matchMedia)) {
            return undefined;
        }

        const value = screens[breakpoint] ?? "999999px";
        const query = globalThis.matchMedia(`(min-width: ${value})`);

        function listener(event: MediaQueryListEvent) {
            setMatch(event.matches);
        }

        setMatch(query.matches);

        query.addEventListener("change", listener);

        return () => {
            query.removeEventListener("change", listener);
        };
    }, [breakpoint, defaultValue]);

    return match;
}

const Breakpoint: FC<{ breakpoint: "sm" | "md" | "lg" | "xl" | "2xl"; desktop: ReactNode; mobile: ReactNode }> = ({ breakpoint, desktop, mobile }) => {
    const show = useBreakpoint(breakpoint);

    if (show) {
        return desktop;
    }

    return mobile;
};

export default Breakpoint;
