import { useLayoutEffect, useState } from "react";

const useWindowSize = (): { height: number | undefined; width: number | undefined } => {
    const [size, setSize] = useState<{
        height: number | undefined;
        width: number | undefined;
    }>({
        height: undefined,
        width: undefined,
    });

    useLayoutEffect(() => {
        // `"window" in globalThis` sidesteps both the typeof-undefined and the
        // always-false (lib.dom narrows `window` to non-optional) lints while still
        // guarding the SSR pass where there is no window.
        if (!("window" in globalThis)) {
            return undefined;
        }

        const handleResize = () => {
            setSize({
                height: window.innerHeight,
                width: window.innerWidth,
            });
        };

        handleResize();

        window.addEventListener("resize", handleResize);

        return () => {
            window.removeEventListener("resize", handleResize);
        };
    }, []);

    return size;
};

export default useWindowSize;
