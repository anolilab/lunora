import { resolve } from "node:path";

import { lunoraLine } from "@lunora/config";
import type { Plugin, ResolvedConfig } from "vite";

import type { ResolvedLunoraPluginOptions } from "./types";

/** `@cloudflare/vite-plugin`'s name: with it in the build, the client environment's `outDir` is what Workers Static Assets uploads. */
const CLOUDFLARE_PLUGIN_NAME = "vite-plugin-cloudflare";

const FILE_NAME_OPTIONS = ["assetFileNames", "chunkFileNames", "entryFileNames"] as const;

type OutputOptions = Partial<Record<(typeof FILE_NAME_OPTIONS)[number], unknown>>;

/** The configured `output` entries. Vite 8 renamed `rollupOptions` to `rolldownOptions` (keeping the old name as an alias); Vite 6 and 7, which the peer range still covers, have only the old name. */
const outputsOf = (build: ResolvedConfig["build"]): OutputOptions[] => {
    // eslint-disable-next-line sonarjs/deprecation -- the fallback for Vite 6/7, where `rolldownOptions` does not exist
    const { output } = (build as { rolldownOptions?: ResolvedConfig["build"]["rolldownOptions"] }).rolldownOptions ?? build.rollupOptions;

    return output === undefined ? [] : [output].flat();
};

/** Whether every output file name the build is configured with carries `[hash]`; Vite's own defaults all do. */
const namesCarryHash = (build: ResolvedConfig["build"]): boolean =>
    // A function can name a file anything, so only a pattern string can promise a hash.
    outputsOf(build).every((entry) =>
        FILE_NAME_OPTIONS.every((key) => entry[key] === undefined || (typeof entry[key] === "string" && entry[key].includes("[hash]"))),
    );

/** The names the build gives its files under `assetsDir`: the configured patterns, and Vite's defaults for every option left unset. */
const hashedNamePatterns = (build: ResolvedConfig["build"]): string[] => [
    ...outputsOf(build).flatMap((entry) => FILE_NAME_OPTIONS.map((key) => entry[key]).filter((name) => typeof name === "string")),
    `${build.assetsDir}/[name]-[hash][extname]`,
    `${build.assetsDir}/[name]-[hash].js`,
];

/**
 * Write the Lunora-managed block of `_headers` into the client build, so a
 * static asset hit (which Cloudflare serves without running the Worker) still
 * carries Lunora's default security headers, and its content-hashed files are
 * cached for good. See `@lunora/config`'s `asset-headers` for the block itself.
 *
 * The hashed directory is Vite's `build.assetsDir`, offered only while every
 * output name the build is configured with carries `[hash]`; `@lunora/config`
 * checks every file the build left there has such a name, and applies the rest of the
 * decision (public folder, `not_found_handling`), reading the wrangler config
 * `@cloudflare/vite-plugin` was pointed at (`wranglerPath`).
 *
 * `@lunora/config/cloudflare` is imported when the build gets here, the way every
 * integration's `_headers` step loads it.
 *
 * Runs in `writeBundle`, after Vite has copied `publicDir` (and with it any
 * `_headers` the user wrote) into `outDir`, so the user's rules are merged
 * rather than replaced. Only when `@cloudflare/vite-plugin` is in the build
 * (Lunora's own or the project's) and the target is Cloudflare: without it, the
 * client `outDir` is not known to be the assets root, and a framework that copies
 * it under a sub-path would publish `_headers` as a file.
 */
const assetHeadersPlugin = (options: ResolvedLunoraPluginOptions, wranglerPath?: string): Plugin => {
    let cloudflareBuild = false;

    return {
        apply: "build",
        applyToEnvironment: (environment) => environment.name === "client",
        configResolved(config) {
            cloudflareBuild = config.plugins.some((plugin) => plugin.name === CLOUDFLARE_PLUGIN_NAME);
        },
        name: "lunora:asset-headers",
        async writeBundle() {
            if (!cloudflareBuild) {
                return;
            }

            const { config } = this.environment;
            const { emitProjectAssetHeaders } = await import("@lunora/config/cloudflare");

            emitProjectAssetHeaders(
                {
                    hashedDirectory: namesCarryHash(config.build) ? config.build.assetsDir : undefined,
                    hashedNamePatterns: hashedNamePatterns(config.build),
                    outputDirectory: resolve(config.root, config.build.outDir),
                    projectRoot: options.projectRoot,
                    publicDirectory: config.publicDir === "" ? undefined : config.publicDir,
                    requireAssetsDirectory: false,
                    schemaDir: options.schemaDir,
                    target: options.target,
                    wranglerPath,
                },
                {
                    info: (message) => {
                        config.logger.info(lunoraLine(message));
                    },
                    warn: (message) => {
                        config.logger.warn(lunoraLine(message));
                    },
                },
            );
        },
    };
};

export default assetHeadersPlugin;
