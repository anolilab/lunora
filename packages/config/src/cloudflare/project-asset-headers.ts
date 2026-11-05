/**
 * The one decision every bundler integration makes before writing the managed
 * `_headers` block: is this build's output the directory Cloudflare uploads as
 * the Worker's static assets, which headers go in, and may its hashed directory
 * be cached for good. `@lunora/vite`, `@lunora/rspack/rsbuild`, `@lunora/nuxt`
 * and `@lunora/astro` each only say where their output is.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { readProjectSecurityHeaders } from "@lunora/codegen";

import { isPlainObject } from "../../../../shared/is-plain-object";
import type { SecurityHeadersOptions } from "../../../../shared/security-headers";
import { effectiveSecurityHeaders } from "../../../../shared/security-headers";
import canonicalPath from "../canonical-path";
import join from "../path";
import { resolveProjectTarget } from "../project-config";
import type { AssetHeadersResult } from "./asset-headers";
import { writeAssetHeaders } from "./asset-headers";
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
    /** Schema directory relative to `projectRoot`; `lunora.config` is looked up from it. Defaults to `lunora`. */
    schemaDir?: string;
    /** The deploy target an integration was configured with; resolved from `lunora.config` when omitted. Only `"cloudflare"` serves `_headers`. */
    target?: string;
}

/** Where an integration's build log goes. */
interface AssetHeadersLogger {
    info: (message: string) => void;
    warn: (message: string) => void;
}

type ProjectAssetHeadersOutcome = { reason: string; written: false } | { result: AssetHeadersResult; written: true };

/** The `CLOUDFLARE_ENV` the build targets; an empty value is no environment, as wrangler reads it. */
const cloudflareEnvironment = (): string | undefined => {
    const value = process.env["CLOUDFLARE_ENV"];

    return value === undefined || value === "" ? undefined : value;
};

/**
 * The wrangler block under `key` that an `env.<environment>` build uses. An
 * inheritable key (`assets`) falls back to the top level when the environment
 * has none of its own; a non-inheritable one (`vars`) does not.
 */
const scopedBlock = (
    wrangler: unknown,
    environment: string | undefined,
    key: string,
    { inherit }: { inherit: boolean },
): Record<string, unknown> | undefined => {
    const top = isPlainObject(wrangler) ? wrangler : undefined;
    const topBlock = isPlainObject(top?.[key]) ? top[key] : undefined;

    if (environment === undefined) {
        return topBlock;
    }

    const environments = top?.["env"];
    const scope = isPlainObject(environments) ? environments[environment] : undefined;
    const own = isPlainObject(scope) ? scope[key] : undefined;

    if (isPlainObject(own)) {
        return own;
    }

    return inherit ? topBlock : undefined;
};

/**
 * The security headers a build writes for the static assets, in the precedence
 * the Worker applies them: `lunora.config`'s `security.headers` (read and parsed
 * by `@lunora/codegen`, which also emits it into the Worker), then an off value
 * for `LUNORA_SECURITY_HEADERS` in the build's own `vars`, then the defaults. A
 * `security.headers` passed to `createWorker` in code cannot be seen here; set it
 * in `lunora.config` to cover both.
 */
const projectSecurityHeaders = (lunoraDirectory: string, wrangler: unknown, environment: string | undefined): boolean | SecurityHeadersOptions | undefined =>
    effectiveSecurityHeaders(
        readProjectSecurityHeaders(lunoraDirectory),
        scopedBlock(wrangler, environment, "vars", { inherit: false })?.["LUNORA_SECURITY_HEADERS"],
    );

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
    const target = resolveProjectTarget(input.projectRoot, input.target);

    if (target !== "cloudflare") {
        return { reason: `target "${target}" does not serve _headers`, written: false };
    }

    const wranglerPath = findWranglerFile(input.projectRoot);
    const wrangler = wranglerPath === undefined ? undefined : readWranglerJsonc(wranglerPath).parsed;
    const environment = cloudflareEnvironment();
    const assets = scopedBlock(wrangler, environment, "assets", { inherit: true });

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

    // Without a parsed config `not_found_handling` is unknown, not unset: under a fallback, a request for a chunk a
    // later deploy removed would get the fallback page cached for a year, so the immutable rule waits for the config.
    const configRead = wrangler !== undefined;
    const result = writeAssetHeaders(input.outputDirectory, {
        headers: projectSecurityHeaders(resolve(input.projectRoot, input.schemaDir ?? "lunora"), wrangler, environment),
        immutableDirectory: configRead ? cacheableDirectory(input, assets?.["not_found_handling"]) : undefined,
    });

    if (!configRead && input.hashedDirectory !== undefined && input.hashedDirectory !== "") {
        result.warnings.push(
            `_headers: no long-term caching for ${input.hashedDirectory}/, because ${
                wranglerPath === undefined ? "no wrangler.jsonc or wrangler.json was found" : `${wranglerPath} could not be parsed`
            } and assets.not_found_handling decides whether that is safe`,
        );
    }

    return { result, written: true };
};

/**
 * Write the managed `_headers` block for one build output and report it through
 * the build's logger: the headers left to the user's own rules, then each
 * warning. The single entry point every bundler integration calls after its
 * client build.
 */
const emitProjectAssetHeaders = (input: ProjectAssetHeadersInput, logger: AssetHeadersLogger): ProjectAssetHeadersOutcome => {
    const outcome = writeProjectAssetHeaders(input);

    if (outcome.written) {
        if (outcome.result.deferred.length > 0) {
            logger.info(`_headers: kept your own ${outcome.result.deferred.join(", ")} for static assets instead of Lunora's default`);
        }

        for (const warning of outcome.result.warnings) {
            logger.warn(warning);
        }
    }

    return outcome;
};

export type { AssetHeadersLogger, ProjectAssetHeadersInput, ProjectAssetHeadersOutcome };
export { emitProjectAssetHeaders };
