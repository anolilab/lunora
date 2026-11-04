import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { lunoraLine } from "@lunora/config";
import { findWranglerFile, readWranglerJsonc, resolveProjectSecurityHeaders, writeAssetHeaders } from "@lunora/config/cloudflare";
import type { Plugin, ResolvedConfig } from "vite";

import type { ResolvedLunoraPluginOptions } from "./types";

/** The `CLOUDFLARE_ENV` the build targets; an empty value is no environment, as wrangler reads it. */
const cloudflareEnvironment = (): string | undefined => {
    const value = process.env["CLOUDFLARE_ENV"];

    return value === undefined || value === "" ? undefined : value;
};

/** `@cloudflare/vite-plugin`'s name: with it in the build, the client environment's `outDir` is what Workers Static Assets uploads. */
const CLOUDFLARE_PLUGIN_NAME = "vite-plugin-cloudflare";

const FILE_NAME_OPTIONS = ["assetFileNames", "chunkFileNames", "entryFileNames"] as const;

/** Whether every output file name the build is configured with carries `[hash]`; Vite's own defaults all do. */
const namesCarryHash = (build: ResolvedConfig["build"]): boolean => {
    // Vite 8 renamed `rollupOptions` to `rolldownOptions` (keeping the old name as an alias); Vite 6 and 7, which the peer range
    // still covers, have only the old name.
    // eslint-disable-next-line sonarjs/deprecation -- the fallback for Vite 6/7, where `rolldownOptions` does not exist
    const { output } = (build as { rolldownOptions?: ResolvedConfig["build"]["rolldownOptions"] }).rolldownOptions ?? build.rollupOptions;
    const outputs = output === undefined ? [] : [output].flat();

    // A function can name a file anything, so only a pattern string can promise a hash.
    return outputs.every((entry) =>
        FILE_NAME_OPTIONS.every((key) => entry[key] === undefined || (typeof entry[key] === "string" && entry[key].includes("[hash]"))),
    );
};

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * The `assets.not_found_handling` the build deploys with. `assets` is
 * inheritable, so an `env.<name>` block without its own falls back to the top level.
 */
const notFoundHandling = (wrangler: unknown, environment: string | undefined): unknown => {
    const top = recordOf(wrangler);
    const scoped = environment === undefined ? undefined : recordOf(recordOf(recordOf(top?.["env"])?.[environment])?.["assets"]);

    return (scoped ?? recordOf(top?.["assets"]))?.["not_found_handling"];
};

/**
 * The directory whose files can be cached for good: Vite's `build.assetsDir`,
 * where it writes the content-hashed chunks and assets. `undefined` when it
 * might hold an unhashed file (a custom output name without `[hash]`, or a
 * `publicDir` subfolder of the same name, which Vite copies in unhashed), and
 * when a miss there is answered from the assets: under a `not_found_handling`
 * fallback, a request for a chunk a later deploy removed gets `index.html` or
 * `404.html` through the same `_headers` rule, which would cache that page for a
 * year. Unset or `"none"`, a miss goes to the Worker, which `_headers` never touches.
 */
const immutableDirectory = (config: ResolvedConfig, fallback: unknown): string | undefined => {
    const { assetsDir } = config.build;

    if (assetsDir === "" || (fallback !== undefined && fallback !== "none") || !namesCarryHash(config.build)) {
        return undefined;
    }

    return config.publicDir !== "" && existsSync(join(config.publicDir, assetsDir)) ? undefined : assetsDir;
};

/**
 * Write the Lunora-managed block of `_headers` into the client build, so a
 * static asset hit (which Cloudflare serves without running the Worker) still
 * carries Lunora's default security headers, and its content-hashed files are
 * cached for good. See `@lunora/config`'s `asset-headers` for the block itself.
 *
 * Runs in `writeBundle`, after Vite has copied `publicDir` (and with it any
 * `_headers` the user wrote) into `outDir`, so the user's rules are merged
 * rather than replaced. Only when `@cloudflare/vite-plugin` is in the build
 * (Lunora's own or the project's) and the target is Cloudflare: without it, the
 * client `outDir` is not known to be the assets root, and a framework that copies
 * it under a sub-path would publish `_headers` as a file.
 */
const assetHeadersPlugin = (options: ResolvedLunoraPluginOptions): Plugin => {
    let cloudflareBuild = false;

    return {
        apply: "build",
        applyToEnvironment: (environment) => environment.name === "client",
        configResolved(config) {
            cloudflareBuild = options.target === "cloudflare" && config.plugins.some((plugin) => plugin.name === CLOUDFLARE_PLUGIN_NAME);
        },
        name: "lunora:asset-headers",
        writeBundle() {
            if (!cloudflareBuild) {
                return;
            }

            const { config } = this.environment;
            const wranglerPath = findWranglerFile(options.projectRoot);
            const wrangler = wranglerPath === undefined ? undefined : readWranglerJsonc(wranglerPath).parsed;
            const environment = cloudflareEnvironment();
            const result = writeAssetHeaders(resolve(config.root, config.build.outDir), {
                immutableDirectory: immutableDirectory(config, notFoundHandling(wrangler, environment)),
                headers: resolveProjectSecurityHeaders(resolve(options.projectRoot, options.schemaDir), wrangler, environment),
            });

            if (result.deferred.length > 0) {
                config.logger.info(lunoraLine(`_headers: kept your own ${result.deferred.join(", ")} for static assets instead of Lunora's default`));
            }

            for (const warning of result.warnings) {
                config.logger.warn(lunoraLine(warning));
            }
        },
    };
};

export default assetHeadersPlugin;
