import { existsSync } from "node:fs";
import { join } from "node:path";

import { detectFramework, LAZY_FUNCTIONS_ENV } from "@lunora/config";
import { findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

import { detectPackageManager, execArgsFor } from "../../util/detect-package-manager";
import type { Logger } from "../../util/logger";
import type { Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import snapshotWranglerConfig from "../../util/wrangler-snapshot";

/** The client-build tool a project's config file names. */
type FrameworkTool = "rsbuild" | "vite";

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
const frameworkBuildFor = (cwd: string): FrameworkTool | undefined => {
    const tool = pickTool(cwd);

    if (tool === undefined) {
        return undefined;
    }

    const wranglerPath = findWranglerFile(cwd);
    const wrangler = wranglerPath === undefined ? undefined : readWranglerJsonc<{ assets?: { directory?: unknown }; main?: unknown }>(wranglerPath).parsed;
    const needed = wrangler?.main === COMPOSED_MAIN || detectFramework(cwd).class !== "C" || wrangler?.assets?.directory !== undefined;

    return needed ? tool : undefined;
};

interface FrameworkBuildOptions {
    /** Opt the child's codegen into lazy imports, the same way `lunora build` itself does. */
    lazyFunctions: boolean;
    logger: Logger;
    /** `json` keeps the child's stdout off the parent's single JSON document. */
    outputJson: boolean;
    spawner?: Spawner;
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
    const command = execArgsFor(detectPackageManager(cwd), tool, ["build"]);

    options.logger.info(`running ${tool} build before bundling the Worker`);

    const restore = snapshotWranglerConfig(cwd);

    try {
        const result = await spawner({
            args: command.args,
            command: command.command,
            cwd,
            env: options.lazyFunctions ? { [LAZY_FUNCTIONS_ENV]: "1" } : undefined,
            stdoutToStderr: options.outputJson,
        });

        return result.code === 0 ? undefined : `${tool} build failed with exit code ${String(result.code)}`;
    } finally {
        restore();
    }
};

export { frameworkBuildFor, runFrameworkBuild };
export type { FrameworkTool };
