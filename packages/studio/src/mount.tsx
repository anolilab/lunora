import { LunoraError } from "@lunora/errors";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";

import type { StudioAppProps } from "./app/app";
import { StudioApp } from "./app/app";

export interface MountStudioOptions extends StudioAppProps {
    /**
     * The container to mount into. Accepts an element or a selector; defaults to
     * `#root`. Throws if the selector matches nothing so misconfiguration fails
     * loudly rather than silently rendering nowhere.
     */
    readonly container?: Element | string;
}

/**
 * Mount the batteries-included {@link StudioApp} into the DOM and return the
 * React root (call `.unmount()` to tear it down). This is the entry the
 * standalone app's `main.tsx` and the `@lunora/vite` dev route both call — it
 * keeps the host HTML to a single `<div id="root">` plus one script.
 */
export const mountStudio = (options: MountStudioOptions = {}): Root => {
    const { container = "#root", ...appProps } = options;

    const element = typeof container === "string" ? document.querySelector(container) : container;

    if (element === null) {
        throw new LunoraError("INTERNAL", `mountStudio: container ${typeof container === "string" ? container : "element"} not found`);
    }

    const root = createRoot(element);

    root.render(
        <StudioApp
            adminToken={appProps.adminToken}
            basePath={appProps.basePath}
            baseUrl={appProps.baseUrl}
            locale={appProps.locale}
            rulesInstalled={appProps.rulesInstalled}
            studio={appProps.studio}
        />,
    );

    return root;
};
