import { resolve } from "node:path";

import type { ApiSpec } from "../../util/api-spec";
import { parseApiSpec } from "../../util/api-spec";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import { isJsonFormat, loggerForFormat, printJson, validateOutputFormat } from "../../util/output-format";
import type { Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import type { DeployCommandResult } from "../deploy/handler";
import { runDeployCommand } from "../deploy/handler";
import type { BundleSize } from "./bundle-size";
import { measureBundle } from "./bundle-size";
import type { BuildOptions } from "./index";

/** Default artifact directory — gitignored alongside the other `.lunora/` state. */
const DEFAULT_OUT_DIR = ".lunora/build";

interface BuildCommandOptions {
    /**
     * Per-run override for the schema-drift gate. `build` runs the same gate
     * `deploy` does (it IS `deploy --dry-run` underneath), so the blocked-drift
     * message it prints tells the operator to pass this — and it used to be
     * rejected as an unknown option by the command that had just printed it.
     *
     * Per-run only: a build publishes nothing, so it never advances the
     * committed baseline (see `schema-drift-gate.ts`).
     */
    allowSchemaDrift?: boolean;
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
 * A build result is the deploy result plus the weight of what was produced.
 * `bundle` is absent when the out-dir could not be measured (see
 * {@link measureBundle}) and on a failed build, where nothing was written.
 */
interface BuildCommandResult extends DeployCommandResult {
    bundle?: BundleSize;
}

/**
 * `defaultSpawner` with every child's stdout folded into stderr.
 *
 * `build` takes over its own `--format json` document (below), which means the
 * `format` deploy sees is `undefined` — and `format` is what deploy would
 * otherwise have used to keep wrangler's chatter off stdout. Forcing it here
 * keeps stdout carrying exactly one JSON document.
 */
const stderrOnlySpawner: Spawner = async (descriptor) => defaultSpawner({ ...descriptor, stdoutToStderr: true });

/** Bundle sizes are always kilobytes-and-up; one unit keeps the two halves comparable at a glance. */
const kib = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`;

/**
 * Build the Worker without deploying: this is `deploy` in its dry-run +
 * `--outdir` mode, so it reuses the entire pre-deploy pipeline (codegen, the
 * schema-drift gate, binding provisioning, container preflight, wrangler
 * validation) and then emits the bundle to disk instead of publishing.
 */
const runBuildCommand = async (options: BuildCommandOptions): Promise<BuildCommandResult> => {
    const outDirectory = options.outDir ?? DEFAULT_OUT_DIR;
    const jsonMode = isJsonFormat(options.format);

    // `build` owns its `--format json` document instead of delegating to
    // deploy's: the bundle measurement below is what a CI consumer runs this
    // command for, and the deploy result has no field to carry it. Everything
    // human therefore goes to stderr from here on.
    const logger = loggerForFormat(options.format, options.logger);
    const emit = (result: BuildCommandResult): BuildCommandResult => {
        if (jsonMode) {
            printJson(result);
        }

        return result;
    };

    const formatError = validateOutputFormat("build", options.format);

    if (formatError !== undefined) {
        options.logger.error(formatError);

        return { code: 1, descriptor: undefined, error: formatError, validation: { problems: [], wranglerPath: undefined } };
    }

    const result = await runDeployCommand({
        allowSchemaDrift: options.allowSchemaDrift,
        apiSpec: options.apiSpec,
        // So the drift gate names `build` and offers only the flags `build`
        // registers — it does NOT accept `--update-schema-baseline`, because it
        // publishes nothing and re-blessing a baseline for an artifact that never
        // shipped is what lets a breaking change through on the retry.
        commandName: "build",
        cwd: options.cwd,
        dryRun: true,
        // The requirements document has to describe the PROVISIONED config, so
        // deploy writes it inside its own dry-run rollback window rather than
        // handing it back here, where the committed config is already restored.
        emitBindings: options.emitBindings,
        format: undefined,
        interactive: jsonMode ? false : undefined,
        logger,
        outDir: outDirectory,
        spawner: options.spawner ?? (jsonMode ? stderrOnlySpawner : undefined),
        target: options.target,
    });

    if (result.code !== 0) {
        return emit(result);
    }

    logger.success(`build complete — bundle written to ${outDirectory}`);

    const bundle = measureBundle(resolve(options.cwd ?? process.cwd(), outDirectory));

    if (bundle === undefined) {
        // Never report 0 bytes for this: an out-dir layout we no longer
        // recognise would measure as the healthiest possible bundle.
        logger.warn(`could not weigh the bundle — nothing uploadable was found in ${outDirectory}`);
    } else {
        logger.info(
            `bundle: ${kib(bundle.rawBytes)} raw, ${kib(bundle.gzipBytes)} gzipped across ${String(bundle.files)} file(s) — ` +
                `Cloudflare's Worker size limit (3 MB Free, 10 MB Paid) applies to the gzipped number`,
        );
    }

    return emit({ ...result, bundle });
};

/** `lunora build` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<BuildOptions> = defineHandler<BuildOptions>(async ({ cwd, logger, options }) => {
    const result = await runBuildCommand({
        allowSchemaDrift: options.allowSchemaDrift === true,
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
export type { BuildCommandOptions, BuildCommandResult };
export { runBuildCommand };
