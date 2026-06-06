import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { DashboardAssets, WarnLogger } from "./types.js";

/**
 * Read the prebuilt static dashboard files shipped by `@cirrus/dashboard`
 * (`dist/standalone/dashboard.js` + `dist/styles.css`). Returns `undefined` —
 * with a one-time warning — when the optional package isn't installed or hasn't
 * been built, so a missing dashboard never breaks the dev server.
 *
 * `resolveFrom` controls where `@cirrus/dashboard` is resolved from. It defaults
 * to this module's own location, which is correct once this code is inlined into
 * a host package (`@cirrus/vite` / `@cirrus/cli`) that has `@cirrus/dashboard`
 * installed — node walks up from the host's `dist` to find it.
 */
const loadDashboardAssets = (logger?: WarnLogger, resolveFrom: string = import.meta.url): DashboardAssets | undefined => {
    try {
        const require = createRequire(resolveFrom);

        return {
            script: readFileSync(require.resolve("@cirrus/dashboard/standalone/dashboard.js")),
            styles: readFileSync(require.resolve("@cirrus/dashboard/styles.css")),
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger?.warnOnce?.(`[cirrus] dashboard assets unavailable (build @cirrus/dashboard?): ${message}`);

        return undefined;
    }
};

export default loadDashboardAssets;
