import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type { ManifestConfigShape } from "@lunora/config/cloudflare";
import { buildBindingManifest, findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

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

    /**
     * Path to write the binding manifest to. Relative paths resolve against the
     * project root, and parent directories are created.
     */
    emitBindings?: string;
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
 * Write the binding manifest for the project at `projectRoot`.
 *
 * Runs AFTER the pre-deploy pipeline, deliberately: that pipeline is what infers
 * the app's requirements and reconciles them into `wrangler.jsonc`, so the config
 * is only the resolved answer once it has finished. Reading it earlier would
 * describe the requirements the project happened to have written down, not the
 * ones the bundle actually has.
 *
 * A project with no `wrangler.jsonc` at all is a hard error rather than an empty
 * manifest: an empty requirements document reads as "this Worker needs nothing",
 * which an IaC program would act on by provisioning nothing.
 */
const writeBindingManifest = (projectRoot: string, target: string, logger: Logger): { error?: string } => {
    const wranglerPath = findWranglerFile(projectRoot);
    const parsed = wranglerPath === undefined ? undefined : readWranglerJsonc<ManifestConfigShape>(wranglerPath).parsed;

    if (parsed === undefined) {
        return {
            error: `--emit-bindings found no readable wrangler config in ${projectRoot}. The manifest is derived from it, and an empty one would tell a deployer this Worker needs nothing.`,
        };
    }

    const manifest = buildBindingManifest(parsed);
    const destination = isAbsolute(target) ? target : resolve(projectRoot, target);

    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `${JSON.stringify(manifest, undefined, 2)}\n`, "utf8");

    logger.success(`binding manifest written to ${destination} (${manifest.bindings.length.toString()} bindings, ${manifest.crons.length.toString()} crons)`);

    // Not an error: the bundle is fine and the manifest is still usable. But a
    // consumer acting on it would silently under-provision, so say which section
    // was not carried rather than leaving them to notice at runtime.
    if (manifest.unknown.length > 0) {
        logger.warn(
            `binding manifest does not model these wrangler sections: ${manifest.unknown.join(", ")}. ` +
                `Anything they bind must be provisioned by hand — please report them so the manifest can cover them.`,
        );
    }

    return {};
};

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

    if (result.code !== 0) {
        return result;
    }

    options.logger.success(`build complete — bundle written to ${outDirectory}`);

    if (options.emitBindings !== undefined) {
        const { error } = writeBindingManifest(options.cwd ?? process.cwd(), options.emitBindings, options.logger);

        if (error !== undefined) {
            options.logger.error(error);

            return { ...result, code: 1 };
        }
    }

    return result;
};

/** `lunora build` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<BuildOptions> = defineHandler<BuildOptions>(async ({ cwd, logger, options }) => {
    const result = await runBuildCommand({
        apiSpec: parseApiSpec(options.apiSpec),
        cwd,
        emitBindings: options.emitBindings,
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
