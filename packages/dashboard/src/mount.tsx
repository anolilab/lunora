import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";

import type { DashboardAppProps } from "./app.js";
import { DashboardApp } from "./app.js";

export interface MountDashboardOptions extends DashboardAppProps {
    /**
     * The container to mount into. Accepts an element or a selector; defaults to
     * `#root`. Throws if the selector matches nothing so misconfiguration fails
     * loudly rather than silently rendering nowhere.
     */
    readonly container?: Element | string;
}

/**
 * Mount the batteries-included {@link DashboardApp} into the DOM and return the
 * React root (call `.unmount()` to tear it down). This is the entry the
 * standalone app's `main.tsx` and the `@cirrus/vite` dev route both call — it
 * keeps the host HTML to a single `&lt;div id="root">` plus one script.
 */
export const mountDashboard = (options: MountDashboardOptions = {}): Root => {
    const { container = "#root", ...appProps } = options;

    const element = typeof container === "string" ? document.querySelector(container) : container;

    if (element === null) {
        throw new Error(`mountDashboard: container ${typeof container === "string" ? container : "element"} not found`);
    }

    const root = createRoot(element);

    root.render(
        <DashboardApp
            adminToken={appProps.adminToken}
            basePath={appProps.basePath}
            baseUrl={appProps.baseUrl}
            dashboard={appProps.dashboard}
            locale={appProps.locale}
        />,
    );

    return root;
};
