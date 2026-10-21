import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { detectFramework, LAZY_FUNCTIONS_ENV, POST_CODEGEN_SKIP_ENV, resolveTargetOrThrow, STRICT_ADVISORIES_ENV } from "@lunora/config";
import { findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

import type { ApiSpec } from "../../util/api-spec";
import { detectPackageManager, execArgsFor } from "../../util/detect-package-manager";
import type { Logger } from "../../util/logger";
import type { Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import snapshotWranglerConfig from "../../util/wrangler-snapshot";

/** The client-build tool a project's config file names. */
/** `script` runs the project's own `build` script, for a framework (Astro, Nuxt) that has no Vite or rsbuild config to bundle through. */
type FrameworkTool = "rsbuild" | "script" | "vite";

/** Set on a client build's child so a build script that runs `lunora` does not start another client build. */
const CLIENT_BUILD_ENV = "LUNORA_CLIENT_BUILD";

/** The wrangler fields the gate reads, top level and per environment. */
interface WranglerShape {
    assets?: { directory?: unknown };
    env?: Record<string, { assets?: { directory?: unknown } } | undefined>;
    main?: unknown;
}

/** The `main` `@lunora/vite` points wrangler at for a class-A framework; only the Vite build generates it. */
const COMPOSED_MAIN = "virtual:lunora/worker";

const hasConfigFile = (cwd: string, base: string): boolean =>
    ["ts", "mts", "cts", "js", "mjs", "cjs"].some((extension) => existsSync(join(cwd, `${base}.config.${extension}`)));

/** Prefers rsbuild when both configs exist, since a leftover vite config is common after a migration. */
const pickTool = (cwd: string): FrameworkTool | undefined => {
    if (hasConfigFile(cwd, "rsbuild")) {
        return "rsbuild";
    }

    return hasConfigFile(cwd, "vite") ? "vite" : undefined;
};

/** A worker whose `main` is the Vite-generated composed entry is built by Vite, whatever else the project configures. */
const pickComposedTool = (cwd: string): FrameworkTool | undefined => (hasConfigFile(cwd, "vite") ? "vite" : pickTool(cwd));

/**
 * The client build `lunora build` has to run before wrangler, or `undefined`
 * when wrangler reads nothing a client build produces.
 *
 * The gate is what wrangler will read, not whether an output directory happens
 * to exist: a stale `dist/` or a `.wrangler/deploy/config.json` left by an older
 * build would otherwise ship old code. Runs when `main` is the Vite-generated
 * composed entry, when the framework is class A or B (its worker wraps the
 * framework's build output), or when `assets.directory` names a client build.
 */
const hasBuildScript = (cwd: string): boolean => {
    try {
        const { scripts } = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: { build?: unknown } };

        return typeof scripts?.build === "string" && scripts.build !== "";
    } catch {
        return false;
    }
};

const frameworkBuildFor = (cwd: string, environment?: string): FrameworkTool | undefined => {
    // A build script that runs `lunora` lands here from inside a client build: the outer build already owns the client output.
    if (process.env[CLIENT_BUILD_ENV] === "1") {
        return undefined;
    }

    const wranglerPath = findWranglerFile(cwd);
    const wrangler = wranglerPath === undefined ? undefined : readWranglerJsonc<WranglerShape>(wranglerPath).parsed;
    const composed = wrangler?.main === COMPOSED_MAIN;
    const tool = (composed ? pickComposedTool(cwd) : pickTool(cwd)) ?? (hasBuildScript(cwd) ? "script" : undefined);

    if (tool === undefined) {
        return undefined;
    }

    const envAssets = environment === undefined ? undefined : wrangler?.env?.[environment]?.assets?.directory;
    const assetsDirectory = wrangler?.assets?.directory ?? envAssets;
    const needed = composed || detectFramework(cwd).class !== "C" || assetsDirectory !== undefined;

    return needed ? tool : undefined;
};

interface FrameworkBuildOptions {
    /** The deploy environment (`--env`); the child build gets it as `CLOUDFLARE_ENV`, so its output targets that environment. */
    environment?: string;
    /** Opt the child's codegen into lazy imports, the same way `lunora build` itself does. */
    lazyFunctions: boolean;
    logger: Logger;
    /** `json` keeps the child's stdout off the parent's single JSON document. */
    outputJson: boolean;
    spawner?: Spawner;
    /** `false` when '--no-strict-advisories' opted out: the child build then does not fail on ERROR-level advisories. */
    strictAdvisories?: boolean;
}

/**
 * Run the project's client build (`vite build` / `rsbuild build`) before
 * wrangler bundles the Worker, and return the failure message on a non-zero exit.
 *
 * `@lunora/vite` and `@lunora/rspack` run codegen inside the child, so it
 * receives the lazy-functions opt-in through the env var both plugins read.
 * Whatever the build writes to `wrangler.jsonc` is rolled back afterwards:
 * `lunora build` publishes nothing, and its own pre-deploy pipeline provisions
 * the same bindings again.
 */
const runFrameworkBuild = async (cwd: string, tool: FrameworkTool, options: FrameworkBuildOptions): Promise<string | undefined> => {
    const spawner = options.spawner ?? defaultSpawner;
    const manager = detectPackageManager(cwd);
    const command = tool === "script" ? { args: ["run", "build"], command: manager } : execArgsFor(manager, tool, ["build"]);

    options.logger.info(`running ${tool} build before bundling the Worker`);

    const restore = snapshotWranglerConfig(cwd);

    try {
        const result = await spawner({
            args: command.args,
            command: command.command,
            cwd,
            env: {
                ...(options.lazyFunctions ? { [LAZY_FUNCTIONS_ENV]: "1" } : {}),
                ...(options.environment === undefined ? {} : { CLOUDFLARE_ENV: options.environment }),
                ...(options.strictAdvisories === false ? { [STRICT_ADVISORIES_ENV]: "0" } : {}),
                [CLIENT_BUILD_ENV]: "1",
                [POST_CODEGEN_SKIP_ENV]: "1",
            },
            stdoutToStderr: options.outputJson,
        });

        return result.code === 0 ? undefined : `${tool} build failed with exit code ${String(result.code)}`;
    } finally {
        restore();
    }
};

interface ClientBuildOptions {
    /** An explicit `--api-spec` is refused when a client build would run: the plugin config decides it. */
    apiSpec?: ApiSpec;
    cwd: string;
    /** Forwarded to the client build, which must build for the environment the wrangler deploy names. */
    environment?: string;
    /** `false` skips the client build (`--no-framework-build`, `--prebuilt`). */
    frameworkBuild?: boolean;
    lazyFunctions: boolean;
    logger: Logger;
    /** `true` when the caller's stdout is a JSON document, so the build's output goes to stderr. */
    outputJson: boolean;
    spawner?: Spawner;
    /** `false` when '--no-strict-advisories' opted out: the child build then does not fail on ERROR-level advisories. */
    strictAdvisories?: boolean;
    /** An explicit `--target` is refused when it names a different target than the project resolves to. */
    target?: string;
}

/** Whether {@link runClientBuild} runs a framework build for `cwd`. */
const clientBuildRuns = (cwd: string, frameworkBuild: boolean | undefined, environment?: string): boolean =>
    frameworkBuild !== false && frameworkBuildFor(cwd, environment) !== undefined;

/**
 * The reason the client build cannot run with these options, or `undefined` when it can. A refusal is a usage error, so
 * callers report it before anything is written. A build script consumes none of the plugin's settings, so the parent's
 * codegen honours `--api-spec` and `--target` for it instead of refusing them.
 */
const clientBuildRefusal = (options: ClientBuildOptions): string | undefined => {
    const tool = options.frameworkBuild === false ? undefined : frameworkBuildFor(options.cwd, options.environment);

    if (tool === undefined || tool === "script") {
        return undefined;
    }

    if (options.apiSpec !== undefined) {
        return `--api-spec is read from the ${tool} plugin config when the client build runs; set it there, or pass --no-framework-build`;
    }

    if (options.target !== undefined) {
        try {
            resolveTargetOrThrow(options.cwd, options.target);
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    }

    let projectTarget: string;

    try {
        projectTarget = resolveTargetOrThrow(options.cwd);
    } catch (error) {
        return `the project's configured target cannot be used, and the ${tool} plugin reads it: ${error instanceof Error ? error.message : String(error)}`;
    }

    if (options.target !== undefined && options.target !== projectTarget) {
        return `--target ${options.target} differs from the project's target (${projectTarget}), which the ${tool} plugin reads; set it in the project config, or pass --no-framework-build`;
    }

    return undefined;
};

/**
 * Run the client build wrangler depends on, if there is one, and return the failure message when it does not pass.
 * `undefined` means there was nothing to build or the build passed. Refusals are reported by {@link clientBuildRefusal}.
 */
const runClientBuild = async (options: ClientBuildOptions): Promise<string | undefined> => {
    const tool = options.frameworkBuild === false ? undefined : frameworkBuildFor(options.cwd, options.environment);

    if (tool === undefined) {
        return undefined;
    }

    return runFrameworkBuild(options.cwd, tool, {
        environment: options.environment,
        strictAdvisories: options.strictAdvisories,
        lazyFunctions: options.lazyFunctions,
        logger: options.logger,
        outputJson: options.outputJson,
        spawner: options.spawner,
    });
};

export { clientBuildRefusal, clientBuildRuns, frameworkBuildFor, runClientBuild, runFrameworkBuild };
export type { FrameworkTool };
