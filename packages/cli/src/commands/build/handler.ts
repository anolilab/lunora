import type { ApiSpec } from "../../util/api-spec";
import { parseApiSpec } from "../../util/api-spec";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import type { Spawner } from "../../util/spawn";
import type { DeployCommandResult } from "../deploy/handler";
import { runDeployCommand } from "../deploy/handler";
import type { BuildOptions } from "./index";

/** Default artifact directory — gitignored alongside the other `.lunora/` state. */
const DEFAULT_OUT_DIR = ".lunora/build";

interface BuildCommandOptions {
    /** Which API spec(s) codegen emits. */
    apiSpec?: ApiSpec;
    cwd?: string;
    /** Output format: `pretty` (default) or `json`. */
    format?: string;
    logger: Logger;
    /** Directory the bundled worker is written to (default `.lunora/build`). */
    outDir?: string;
    spawner?: Spawner;

    /**
     * Deploy target the artifact is built for. Defaults to `"target"` in
     * `lunora.json`, then `"cloudflare"`. `build` is the artifact half of the
     * `lunora build` → `lunora deploy --prebuilt` CI split, so without this that
     * split can only ever produce a default-target artifact.
     */
    target?: string;
}

/**
 * Build the Worker without deploying: this is `deploy` in its dry-run +
 * `--outdir` mode, so it reuses the entire pre-deploy pipeline (codegen, the
 * schema-drift gate, binding provisioning, container preflight, wrangler
 * validation) and then emits the bundle to disk instead of publishing.
 */
const runBuildCommand = async (options: BuildCommandOptions): Promise<DeployCommandResult> => {
    const outDirectory = options.outDir ?? DEFAULT_OUT_DIR;

    const result = await runDeployCommand({
        apiSpec: options.apiSpec,
        cwd: options.cwd,
        dryRun: true,
        format: options.format,
        logger: options.logger,
        outDir: outDirectory,
        spawner: options.spawner,
        target: options.target,
    });

    if (result.code === 0) {
        options.logger.success(`build complete — bundle written to ${outDirectory}`);
    }

    return result;
};

/** `lunora build` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<BuildOptions> = defineHandler<BuildOptions>(async ({ cwd, logger, options }) => {
    const result = await runBuildCommand({
        apiSpec: parseApiSpec(options.apiSpec),
        cwd,
        format: options.format,
        logger,
        outDir: options.outDir,
        target: options.target,
    });

    return { code: result.code };
});

export { execute };
export type { BuildCommandOptions };
export { runBuildCommand };
