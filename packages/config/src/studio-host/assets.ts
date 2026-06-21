import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";

import type { StudioAssets, WarnLogger } from "./types";

/**
 * Read the prebuilt static studio files shipped by `@lunora/studio`
 * (`dist/standalone/studio.js` + `dist/styles.css`). Returns `undefined` —
 * with a one-time warning — when the optional package isn't installed or hasn't
 * been built, so a missing studio never breaks the dev server.
 *
 * `resolveFrom` controls where `@lunora/studio` is resolved from. It defaults
 * to this module's own location, which is correct once this code is inlined into
 * a host package (`@lunora/vite` / `@lunora/cli`) that has `@lunora/studio`
 * installed — node walks up from the host's `dist` to find it.
 */
const loadStudioAssets = (logger?: WarnLogger, resolveFrom: string = import.meta.url): StudioAssets | undefined => {
    try {
        const require = createRequire(resolveFrom);

        return {
            script: readFileSync(require.resolve("@lunora/studio/standalone/studio.js")),
            styles: readFileSync(require.resolve("@lunora/studio/styles.css")),
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger?.warnOnce?.(`[lunora] studio assets unavailable (build @lunora/studio?): ${message}`);

        return undefined;
    }
};

/**
 * A freshness stamp for the studio assets: the latest mtime (ms) of the resolved
 * `studio.js` / `styles.css`, or `undefined` when they can't be resolved. Hosts
 * cache {@link loadStudioAssets} for the dev session but compare this stamp per
 * request, so a `@lunora/studio` rebuild mid-session is picked up live — no dev
 * server restart needed.
 */
export const studioAssetsStamp = (resolveFrom: string = import.meta.url): number | undefined => {
    try {
        const require = createRequire(resolveFrom);
        const scriptMtime = statSync(require.resolve("@lunora/studio/standalone/studio.js")).mtimeMs;
        const stylesMtime = statSync(require.resolve("@lunora/studio/styles.css")).mtimeMs;

        return Math.max(scriptMtime, stylesMtime);
    } catch {
        return undefined;
    }
};

export default loadStudioAssets;
