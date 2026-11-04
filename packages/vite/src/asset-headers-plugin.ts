import { resolve } from "node:path";

import { lunoraLine } from "@lunora/config";
import { findWranglerFile, readWranglerJsonc, securityHeadersDisabled, writeAssetHeaders } from "@lunora/config/cloudflare";
import type { Plugin } from "vite";

import type { ResolvedLunoraPluginOptions } from "./types";

/** The `CLOUDFLARE_ENV` the build targets; an empty value is no environment, as wrangler reads it. */
const cloudflareEnvironment = (): string | undefined => {
    const value = process.env["CLOUDFLARE_ENV"];

    return value === undefined || value === "" ? undefined : value;
};

/** `@cloudflare/vite-plugin`'s name: with it in the build, the client environment's `outDir` is what Workers Static Assets uploads. */
const CLOUDFLARE_PLUGIN_NAME = "vite-plugin-cloudflare";

/**
 * Write the Lunora-managed block of `_headers` into the client build, so a
 * static asset hit (which Cloudflare serves without running the Worker) still
 * carries Lunora's default security headers. See `@lunora/config`'s
 * `asset-headers` for the block itself.
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
            const result = writeAssetHeaders(resolve(config.root, config.build.outDir), {
                securityHeaders: !securityHeadersDisabled(wrangler, cloudflareEnvironment()),
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
