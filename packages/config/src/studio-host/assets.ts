import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";

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

/**
 * Absolute path of the built standalone directory — `@lunora/studio`'s
 * `dist/standalone`, where the `studio.js` entry and its code-split `chunk-*.js`
 * siblings live — or `undefined` when the studio isn't installed/built. The
 * standalone bundle is emitted with esbuild `splitting`, so the hosts must serve
 * the whole directory (not two fixed paths); this resolves its root.
 */
export const resolveStandaloneDirectory = (resolveFrom: string = import.meta.url): string | undefined => {
    try {
        return dirname(createRequire(resolveFrom).resolve("@lunora/studio/standalone/studio.js"));
    } catch {
        return undefined;
    }
};

/**
 * Resolve a plain filename to an absolute path that is a **direct child** of
 * `directory`, or `undefined` when the name would escape it. Pure path math (no
 * I/O): the path-traversal guard behind {@link readStandaloneAsset}, extracted so
 * it can be unit-tested directly. Rejects empty names, `.`/`..`, path separators,
 * NUL, and any resolved path that isn't a lone segment inside `directory` (a
 * parent escape, an absolute path, or a nested subdirectory).
 */
export const resolveContainedFile = (directory: string, fileName: string): string | undefined => {
    // A servable asset is a lone filename: reject separators, NUL, and the `.`/`..`
    // segments up front (a bare `..` has no separator, so guard it explicitly).
    if (fileName === "" || fileName === "." || fileName === ".." || fileName.includes("/") || fileName.includes("\\") || fileName.includes("\0")) {
        return undefined;
    }

    const resolved = normalize(join(directory, fileName));
    const relativePath = relative(directory, resolved);

    // Belt-and-suspenders after resolving: the result must be a non-empty lone
    // segment directly under `directory` — no parent escape, no absolute path, no
    // nested separator.
    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath) || relativePath.includes("/") || relativePath.includes("\\")) {
        return undefined;
    }

    return resolved;
};

/**
 * Read a single file from the standalone directory by its plain filename (the
 * `studio.js` entry, a `chunk-*.js`, or a `.map`). **Path-traversal-safe** via
 * {@link resolveContainedFile}: only a lone filename resolving to a direct child
 * of the standalone directory is served — any separator, `..`, NUL, or absolute
 * path is rejected — so a request like `../../etc/passwd` can never escape it.
 * Returns the bytes, or `undefined` when the studio isn't built or the name
 * doesn't resolve to a file inside the directory (the host answers that 404).
 */
export const readStandaloneAsset = (fileName: string, resolveFrom: string = import.meta.url): Buffer | undefined => {
    const directory = resolveStandaloneDirectory(resolveFrom);

    if (directory === undefined) {
        return undefined;
    }

    const resolved = resolveContainedFile(directory, fileName);

    if (resolved === undefined) {
        return undefined;
    }

    try {
        return readFileSync(resolved);
    } catch {
        return undefined;
    }
};

export default loadStudioAssets;
