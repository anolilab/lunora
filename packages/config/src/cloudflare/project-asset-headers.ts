/**
 * The one decision every bundler integration makes before writing the managed
 * `_headers` block: is this build's output the directory Cloudflare uploads as
 * the Worker's static assets, which headers go in, and may its hashed directory
 * be cached for good. `@lunora/vite`, `@lunora/rspack/rsbuild`, `@lunora/nuxt`
 * and `@lunora/astro` each only say where their output is.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import canonicalPath from "../canonical-path";
import join from "../path";
import type { AssetHeadersResult } from "./asset-headers";
import { resolveProjectSecurityHeaders, writeAssetHeaders } from "./asset-headers";
import { findWranglerFile, readWranglerJsonc } from "./wrangler-path";

interface ProjectAssetHeadersInput {
    /**
     * The build's directory of content-hashed files, relative to `outputDirectory`
     * (Vite's `build.assetsDir`, Astro's `_astro`, Rsbuild's `static`). Pass it only when
     * the integration can vouch that every file it writes there carries a content hash.
     */
    hashedDirectory?: string;
    /** Absolute directory the build wrote its client output to. */
    outputDirectory: string;
    projectRoot: string;
    /** Absolute `public/` directory the build copies verbatim into `outputDirectory`, if any. */
    publicDirectory?: string;

    /**
     * Write only when `outputDirectory` is the `assets.directory` wrangler deploys.
     * `@lunora/vite` passes `false`: with `@cloudflare/vite-plugin` in the build, the
     * client `outDir` is the assets root even when wrangler declares no `assets` block.
     */
    requireAssetsDirectory: boolean;
    /** Schema directory relative to `projectRoot`; `lunora.config` is looked up from it. */
    schemaDir: string;
    /** The resolved deploy target; only `"cloudflare"` serves `_headers`. */
    target: string;
}

type ProjectAssetHeadersOutcome = { result: AssetHeadersResult; written: true } | { reason: string; written: false };

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The `CLOUDFLARE_ENV` the build targets; an empty value is no environment, as wrangler reads it. */
const cloudflareEnvironment = (): string | undefined => {
    const value = process.env["CLOUDFLARE_ENV"];

    return value === undefined || value === "" ? undefined : value;
};

/** The `assets` block the build deploys: `assets` is inheritable, so an `env.<name>` without its own falls back to the top level. */
const assetsBlock = (wrangler: unknown, environment: string | undefined): Record<string, unknown> | undefined => {
    const top = recordOf(wrangler);
    const scoped = environment === undefined ? undefined : recordOf(recordOf(recordOf(top?.["env"])?.[environment])?.["assets"]);

    return scoped ?? recordOf(top?.["assets"]);
};

/**
 * The hashed directory, or `undefined` when caching it for good could cache the
 * wrong thing: a `public/` subfolder of the same name is copied in unhashed, and
 * under a `not_found_handling` fallback (`single-page-application`, `404-page`)
 * a request for a chunk a later deploy removed gets `index.html` or `404.html`
 * through the same path rule. Unset or `"none"`, a miss goes to the Worker, which
 * `_headers` never touches.
 */
const cacheableDirectory = (input: ProjectAssetHeadersInput, notFoundHandling: unknown): string | undefined => {
    const { hashedDirectory, publicDirectory } = input;

    if (hashedDirectory === undefined || hashedDirectory === "" || (notFoundHandling !== undefined && notFoundHandling !== "none")) {
        return undefined;
    }

    return publicDirectory !== undefined && existsSync(join(publicDirectory, hashedDirectory)) ? undefined : hashedDirectory;
};

/** Write the managed `_headers` block into a build's output when that output is what Cloudflare serves; otherwise say why not. */
const writeProjectAssetHeaders = (input: ProjectAssetHeadersInput): ProjectAssetHeadersOutcome => {
    if (input.target !== "cloudflare") {
        return { reason: `target "${input.target}" does not serve _headers`, written: false };
    }

    const wranglerPath = findWranglerFile(input.projectRoot);
    const wrangler = wranglerPath === undefined ? undefined : readWranglerJsonc(wranglerPath).parsed;
    const environment = cloudflareEnvironment();
    const assets = assetsBlock(wrangler, environment);

    if (input.requireAssetsDirectory) {
        const directory = assets?.["directory"];

        if (typeof directory !== "string" || wranglerPath === undefined) {
            return { reason: "wrangler declares no assets.directory", written: false };
        }

        // Wrangler resolves `assets.directory` against the config file's own directory.
        const deployed = isAbsolute(directory) ? directory : resolve(dirname(wranglerPath), directory);

        if (canonicalPath(deployed) !== canonicalPath(input.outputDirectory)) {
            return { reason: `the build output is not wrangler's assets.directory (${directory})`, written: false };
        }
    }

    const result = writeAssetHeaders(input.outputDirectory, {
        headers: resolveProjectSecurityHeaders(resolve(input.projectRoot, input.schemaDir), wrangler, environment),
        immutableDirectory: cacheableDirectory(input, assets?.["not_found_handling"]),
    });

    return { result, written: true };
};

/** Report a written block through a build's logger: the headers left to the user's own rules, then each warning. */
const reportAssetHeaders = (outcome: ProjectAssetHeadersOutcome, logger: { info: (message: string) => void; warn: (message: string) => void }): void => {
    if (!outcome.written) {
        return;
    }

    if (outcome.result.deferred.length > 0) {
        logger.info(`_headers: kept your own ${outcome.result.deferred.join(", ")} for static assets instead of Lunora's default`);
    }

    for (const warning of outcome.result.warnings) {
        logger.warn(warning);
    }
};

export type { ProjectAssetHeadersInput, ProjectAssetHeadersOutcome };
export { reportAssetHeaders, writeProjectAssetHeaders };
