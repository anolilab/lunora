import { existsSync } from "node:fs";

import type { CodegenResult } from "@cirrus/codegen";
import { discoverMigrations, runCodegen } from "@cirrus/codegen";
import { discoverContainerInfo, findWranglerFile, inferCirrusBindings, readWranglerJsonc, reconcileWranglerBindings } from "@cirrus/config";
import { join } from "@visulima/path";
import { Spinner } from "@visulima/spinner";
import { Project } from "ts-morph";

import type { ApiSpec } from "../../util/api-spec";
import { parseApiSpec } from "../../util/api-spec";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { DockerProbe } from "../../util/docker";
import { isDockerAvailable } from "../../util/docker";
import type { Logger } from "../../util/logger";
import { isJsonFormat, loggerForFormat, printJson, validateOutputFormat } from "../../util/output-format";
import { buildRailpackImages } from "../../util/railpack";
import { runSchemaDriftGate } from "../../util/schema-drift-gate";
import type { SpawnDescriptor, Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import { validateWrangler } from "../../util/wrangler-validator";
import type { MigrateDataCommandOptions } from "../migrate/handler";
import { runMigrateDataCommand } from "../migrate/handler";
import type { FetchLike } from "../run/handler";
import type { DeployOptions } from "./index";

/** Placeholder written by `reconcileWranglerBindings` for auto-provisioned D1 bindings. */
const D1_PLACEHOLDER_ID = "<replace-with-d1-create-id>";

interface DeployCommandOptions {
    /** Override the schema-drift gate — deploy even with breaking drift and no new migration. */
    allowSchemaDrift?: boolean;
    /** Which API spec(s) codegen emits. Defaults to codegen's `"openapi"` when omitted. */
    apiSpec?: ApiSpec;
    cwd?: string;
    /** Docker-availability probe injected in tests. Defaults to a real `docker info` check. */
    dockerAvailable?: DockerProbe;
    env?: string;
    /** Fetch implementation injected in tests for `--migrate` RPC calls. */
    fetchImpl?: FetchLike;
    /** Output format: `pretty` (default) or `json`. */
    format?: string;
    /** Set to `false` to disable interactive spinners (test injection). */
    interactive?: boolean;
    logger: Logger;

    /**
     * When true, after a successful `wrangler deploy`, discover and run all
     * pending data migrations via the worker's `/_cirrus/migrate` admin RPC.
     * The worker must be live (exit 0) before migrations are attempted.
     *
     * Implementation note: the status RPC returns the full shard-level
     * migration state, but there is no single authoritative "list of pending
     * migration ids" that can be read client-side before running the worker.
     * Instead, `--migrate` runs `migrate status` followed by `migrate up` for
     * each migration id discovered locally via `discoverMigrations`.  The
     * worker's `MigrationRunner` is idempotent — running `up` on an already-
     * applied migration is a no-op — so this approach is safe.
     */
    migrate?: boolean;

    /** Admin bearer token for `--migrate` (falls back to `CIRRUS_ADMIN_TOKEN`). */
    migrateToken?: string;

    /** Worker URL for `--migrate` (defaults to the wrangler deploy target). */
    migrateUrl?: string;
    /** Railpack-availability probe injected in tests. Defaults to a real `railpack --version` + `BUILDKIT_HOST` check. */
    railpackAvailable?: DockerProbe;
    skipCodegen?: boolean;
    spawner?: Spawner;
    /** Re-bless the committed schema baseline with the current shape (accepts breaking drift). */
    updateSchemaBaseline?: boolean;
}

interface DeployCommandResult {
    code: number;
    descriptor: SpawnDescriptor | undefined;
    /** Set when the run aborted before reaching the wrangler invocation. */
    error?: string;
    /** The schema-drift gate verdict, when it ran (skipped on `--skip-codegen`). */
    schemaDrift?: { blocked: boolean; reason: string };
    validation: {
        problems: ReadonlyArray<string>;
        wranglerPath: string | undefined;
    };
}

interface WranglerD1Entry {
    binding?: string;
    database_id?: string;
}

interface WranglerD1Shape {
    containers?: ReadonlyArray<{ image?: string } | null | undefined>;
    d1_databases?: ReadonlyArray<WranglerD1Entry>;
}

/** Mirrors the validator's heuristic: a container image that is a local path (vs a registry reference). */
const isLocalImagePath = (image: string): boolean => image.startsWith("./") || image.startsWith("../") || image.startsWith("/") || image.includes("Dockerfile");

/**
 * `wrangler deploy` builds and pushes a container image with the local Docker
 * engine whenever `containers[].image` points at a Dockerfile. Check that
 * prerequisite up front and return an actionable error instead of letting
 * wrangler fail mid-deploy with an opaque engine error. Returns `undefined`
 * when no local image build is needed or Docker is available.
 */
const checkContainerDockerPreflight = (cwd: string, logger: Logger, dockerAvailable: DockerProbe): string | undefined => {
    const wranglerPath = findWranglerFile(cwd);

    if (!wranglerPath) {
        return undefined;
    }

    const { parsed } = readWranglerJsonc<WranglerD1Shape>(wranglerPath);
    const localImages = (parsed?.containers ?? []).filter((entry) => typeof entry?.image === "string" && isLocalImagePath(entry.image));

    if (localImages.length === 0 || dockerAvailable()) {
        return undefined;
    }

    const message =
        `deploy blocked: wrangler.jsonc declares ${String(localImages.length)} container(s) built from a local Dockerfile, but no Docker-compatible ` +
        `engine is available. Start Docker (or Colima), or point the container's \`image\` at a pre-built registry reference. ` +
        `Note: container images must target linux/amd64.`;

    logger.error(message);

    return message;
};

/**
 * Resolve the worker entry `wrangler deploy` should bundle. Class-B frameworks
 * (SvelteKit, Astro) ship a CF adapter that owns the wrangler `main` field and
 * overwrites it with its own generated worker at build time — so `main` cannot
 * itself point at Cirrus's composition. The template instead ships a
 * `src/worker.ts` that imports that generated handler, wraps it with
 * `withCirrus` (mounting `/_cirrus/*`), and re-exports `ShardDO`. When that file
 * exists we pass it as the positional deploy entry so the ONE deployed worker is
 * the composed one — the positional argument overrides `main`. Class-A/C
 * templates have no `src/worker.ts` (their `main` already points at the real
 * entry), so this returns `undefined` and `wrangler` uses `main` as usual.
 */
const resolveComposedWorkerEntry = (cwd: string): string | undefined => (existsSync(join(cwd, "src", "worker.ts")) ? "src/worker.ts" : undefined);

const isInteractive = (options: DeployCommandOptions): boolean => {
    // `--format json` owns stdout for the JSON document — interactive spinners
    // would corrupt it, so json mode is always non-interactive.
    if (isJsonFormat(options.format)) {
        return false;
    }

    if (options.interactive !== undefined) {
        return options.interactive;
    }

    return process.stdout.isTTY && !process.env.CI;
};

/**
 * Return the name of any D1 binding that still carries the placeholder
 * database_id written by `reconcileWranglerBindings`. Returns `undefined`
 * when no placeholder is found (or when wrangler.jsonc is absent/unparseable —
 * the validator will report the real problem in that case).
 */
const findD1PlaceholderBinding = (cwd: string): string | undefined => {
    const wranglerPath = findWranglerFile(cwd);

    if (!wranglerPath) {
        return undefined;
    }

    const { parsed } = readWranglerJsonc<WranglerD1Shape>(wranglerPath);

    if (!parsed) {
        return undefined;
    }

    const placeholder = (parsed.d1_databases ?? []).find((entry) => entry.database_id === D1_PLACEHOLDER_ID);

    return placeholder?.binding;
};

/**
 * Build + push any Railpack `{ build }` containers before wrangler runs. Reads
 * the build sources from `cirrus/containers.ts` (not wrangler.jsonc — by the
 * time it's reconciled the build kind is indistinguishable from a registry ref)
 * and delegates to the testable {@link buildRailpackImages} orchestrator.
 * Returns an error message when a build is blocked or fails, else `undefined`.
 */
const buildContainerImages = async (cwd: string, options: DeployCommandOptions): Promise<string | undefined> => {
    const targets = discoverContainerInfo(cwd, "cirrus")
        .containers.filter((container) => container.image.kind === "build")
        .map((container) => {
            return { buildDir: (container.image as { buildDir: string }).buildDir, exportName: container.exportName };
        });

    if (targets.length === 0) {
        return undefined;
    }

    const result = await buildRailpackImages({
        cwd,
        logger: options.logger,
        railpackAvailable: options.railpackAvailable,
        spawner: options.spawner,
        targets,
    });

    return result.code === 0 ? undefined : (result.error ?? "railpack build failed");
};

/**
 * Auto-provision the bindings the project's code implies before validating, so
 * a first deploy doesn't fail on a SESSION/SCHEDULER/DB binding the user never
 * had to hand-write. Idempotent — a no-op once the config is in sync — and
 * best-effort: a failure here must not abort the deploy, since the validator
 * still reports any genuinely missing requirement.
 */
const provisionBindings = async (cwd: string, logger: Logger): Promise<void> => {
    try {
        const inferred = await inferCirrusBindings({ projectRoot: cwd });
        const reconciled = reconcileWranglerBindings(cwd, inferred);

        if (reconciled.changed) {
            logger.success(`provisioned bindings: ${reconciled.added.join(", ")} → ${reconciled.wranglerPath ?? "wrangler.jsonc"}`);
        }

        for (const warning of reconciled.warnings) {
            logger.warn(warning);
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger.warn(`binding inference skipped: ${message}`);
    }
};

/**
 * Discover migration ids from `cirrus/migrations.ts` and run them in declared
 * order against the now-live worker. The worker's `MigrationRunner` is
 * idempotent — running `up` on an already-applied migration is a no-op —
 * so iterating every declared id is safe even when some were previously applied.
 *
 * We do not attempt to parse the `status` RPC response to filter "pending"
 * ids, because the status response is shard-aggregated (each shard reports its
 * own applied set) and there is no guaranteed single boolean per migration id.
 * Running `up` unconditionally and relying on worker idempotency is simpler,
 * auditable, and safe.
 */
const runPostDeployMigrations = async (options: DeployCommandOptions, cwd: string): Promise<number> => {
    const project = new Project({ skipAddingFilesFromTsConfig: true });
    const cirrusDirectory = join(cwd, "cirrus");
    let migrations: ReadonlyArray<{ id: string; table: string }>;

    try {
        migrations = discoverMigrations(project, cirrusDirectory);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        options.logger.warn(`--migrate: could not discover migrations (${message}); skipping`);

        return 0;
    }

    if (migrations.length === 0) {
        options.logger.info("--migrate: no data migrations declared in cirrus/");

        return 0;
    }

    options.logger.info(`--migrate: running ${String(migrations.length)} migration(s) against deployed worker`);

    for (const migration of migrations) {
        options.logger.info(`--migrate: up "${migration.id}" (table "${migration.table}")`);

        const migrateOptions: MigrateDataCommandOptions = {
            cwd,
            fetchImpl: options.fetchImpl,
            id: migration.id,
            logger: options.logger,
            prod: options.migrateUrl !== undefined,
            subcommand: "up",
            token: options.migrateToken,
            url: options.migrateUrl,
            yes: options.migrateUrl !== undefined,
        };

        // eslint-disable-next-line no-await-in-loop -- sequential: each migration must finish before the next
        const migrateResult = await runMigrateDataCommand(migrateOptions);

        if (migrateResult.code !== 0) {
            options.logger.error(`--migrate: migration "${migration.id}" failed — see output above`);

            return migrateResult.code;
        }

        options.logger.success(`--migrate: "${migration.id}" applied`);
    }

    return 0;
};

/**
 * Run codegen (with optional spinner). Returns the {@link CodegenResult} on
 * success (the deploy needs its schema snapshot for the drift gate), or an
 * `{ error }` message on failure.
 */
const runCodegenStep = (cwd: string, interactive: boolean, logger: Logger, apiSpec: ApiSpec | undefined): { error?: string; result?: CodegenResult } => {
    let codegenSpinner: Spinner | undefined;

    if (interactive) {
        codegenSpinner = new Spinner({ name: "dots" });
        codegenSpinner.start("running codegen");
    } else {
        logger.info("running codegen");
    }

    try {
        const result = runCodegen({ apiSpec, projectRoot: cwd });
        codegenSpinner?.succeed("codegen complete");

        if (!codegenSpinner) {
            logger.success("codegen complete");
        }

        return { result };
    } catch (error: unknown) {
        codegenSpinner?.failed("codegen failed");

        const message = error instanceof Error ? error.message : String(error);

        logger.error(`codegen failed: ${message}`);

        return { error: `codegen failed: ${message}` };
    }
};

/**
 * Check for a D1 placeholder database_id and return an error message when one
 * is found. Returns `undefined` when the config is clean (or absent/unparseable
 * — those cases fall through to the validator). Extracted from `runDeployCommand`
 * to keep its cognitive complexity within the 15-node budget.
 */
const checkD1Placeholder = (cwd: string, logger: Logger): string | undefined => {
    const placeholderBinding = findD1PlaceholderBinding(cwd);

    if (placeholderBinding === undefined) {
        return undefined;
    }

    const message =
        `deploy blocked: the "${placeholderBinding}" D1 binding has a placeholder database_id ` +
        `("${D1_PLACEHOLDER_ID}"). Run \`wrangler d1 create <name>\` to create the database, ` +
        `then replace the placeholder in wrangler.jsonc with the real id before deploying.`;

    logger.error(message);

    return message;
};

/**
 * After a successful `wrangler deploy`, run any requested data migrations and —
 * only when the whole operation succeeded — advance the committed schema
 * baseline via the gate's deferred `rebless`. Extracted from `executeDeploy` to
 * keep its cognitive complexity within the 15-node budget.
 */
const finalizeSuccessfulDeploy = async (
    options: DeployCommandOptions,
    cwd: string,
    descriptor: SpawnDescriptor,
    validation: DeployCommandResult["validation"],
    reblessSchemaBaseline: (() => void) | undefined,
): Promise<DeployCommandResult> => {
    if (options.migrate) {
        const migrateCode = await runPostDeployMigrations(options, cwd);

        // Only advance the committed baseline when deploy AND its migrations
        // succeeded; a failed migration leaves the gate measuring against the
        // pre-deploy baseline on the retry.
        if (migrateCode === 0) {
            reblessSchemaBaseline?.();
        }

        return { code: migrateCode, descriptor, validation };
    }

    // Deploy succeeded — safe to advance the committed schema baseline.
    reblessSchemaBaseline?.();

    return { code: 0, descriptor, validation };
};

/**
 * Run the gates that must pass before `wrangler deploy`: the D1-placeholder
 * hard-block, the Dockerfile-container Docker preflight, and the Railpack
 * `{ build }` build+push step. Returns the first error message, or `undefined`
 * when all pass. Extracted from {@link executeDeploy} to keep its complexity
 * bounded.
 */
const runPreDeployGates = async (cwd: string, options: DeployCommandOptions): Promise<string | undefined> => {
    const d1Error = checkD1Placeholder(cwd, options.logger);

    if (d1Error !== undefined) {
        return d1Error;
    }

    const dockerError = checkContainerDockerPreflight(cwd, options.logger, options.dockerAvailable ?? isDockerAvailable);

    if (dockerError !== undefined) {
        return dockerError;
    }

    return buildContainerImages(cwd, options);
};

const executeDeploy = async (options: DeployCommandOptions): Promise<DeployCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const interactive = isInteractive(options);

    let codegen: CodegenResult | undefined;

    if (!options.skipCodegen) {
        const codegenStep = runCodegenStep(cwd, interactive, options.logger, options.apiSpec);

        if (codegenStep.error !== undefined) {
            return {
                code: 1,
                descriptor: undefined,
                error: codegenStep.error,
                validation: { problems: [], wranglerPath: undefined },
            };
        }

        codegen = codegenStep.result;
    }

    // Schema-drift gate: block when the schema has breaking changes (dropped/
    // retyped/now-required field, dropped table/index/relation, re-shard, …) and
    // no NEW `defineMigration` was added since the committed baseline. Mirrors the
    // D1-placeholder guard's early-abort + actionable message. Skipped on
    // `--skip-codegen` (no fresh snapshot to gate on).
    //
    // The baseline re-bless is DEFERRED: `gate.rebless` is invoked only after a
    // successful `wrangler deploy` (below), so a deploy that fails after this
    // point never advances the committed baseline past a breaking change that
    // never shipped — which would silently defeat the gate on the retry.
    let reblessSchemaBaseline: (() => void) | undefined;

    if (codegen !== undefined) {
        const gate = runSchemaDriftGate({
            allowDrift: options.allowSchemaDrift === true,
            codegen,
            logger: options.logger,
            updateBaseline: options.updateSchemaBaseline === true,
        });

        if (gate.blocked) {
            return {
                code: 1,
                descriptor: undefined,
                error: "schema drift gate blocked deploy",
                schemaDrift: { blocked: true, reason: gate.reason },
                validation: { problems: [], wranglerPath: undefined },
            };
        }

        reblessSchemaBaseline = gate.rebless;
    }

    await provisionBindings(cwd, options.logger);

    // Pre-wrangler gates: the D1 placeholder hard-block, the Dockerfile-container
    // Docker preflight, and the Railpack `{ build }` build+push step. Each aborts
    // with a directed message rather than letting wrangler fail opaquely later.
    const preflightError = await runPreDeployGates(cwd, options);

    if (preflightError !== undefined) {
        return { code: 1, descriptor: undefined, error: preflightError, validation: { problems: [], wranglerPath: undefined } };
    }

    const validation = validateWrangler({ projectRoot: cwd });

    if (validation.problems.length > 0) {
        options.logger.error("wrangler.jsonc validation failed:");

        for (const problem of validation.problems) {
            options.logger.error(`  - ${problem}`);
        }

        return {
            code: 1,
            descriptor: undefined,
            error: "wrangler validation failed",
            validation,
        };
    }

    const args = ["exec", "wrangler", "deploy"];

    // Class-B composition: bundle the `src/worker.ts` wrapper (which the
    // framework's CF adapter can't clobber) instead of the adapter-owned `main`.
    const composedEntry = resolveComposedWorkerEntry(cwd);

    if (composedEntry !== undefined) {
        args.push(composedEntry);
        options.logger.info(`class-B composition: deploying ${composedEntry} (overrides wrangler main)`);
    }

    if (options.env !== undefined) {
        args.push("--env", options.env);
    }

    const descriptor: SpawnDescriptor = {
        args,
        command: "pnpm",
        cwd,
        // In `--format json` mode stdout is reserved for the single JSON document,
        // so route wrangler's progress + deployed-URL output to stderr instead.
        stdoutToStderr: isJsonFormat(options.format),
    };

    options.logger.info(`deploying via ${descriptor.command} ${descriptor.args.join(" ")}`);

    const spawner = options.spawner ?? defaultSpawner;
    const result = await spawner(descriptor);

    if (result.code !== 0) {
        return { code: result.code, descriptor, validation };
    }

    return finalizeSuccessfulDeploy(options, cwd, descriptor, validation, reblessSchemaBaseline);
};

/**
 * Run a deploy, then (in `--format json` mode) serialize the structured
 * {@link DeployCommandResult} to stdout. Human/progress logging is routed to
 * stderr for json output so stdout carries only the single JSON document.
 */
const runDeployCommand = async (options: DeployCommandOptions): Promise<DeployCommandResult> => {
    const formatError = validateOutputFormat("deploy", options.format);

    if (formatError !== undefined) {
        options.logger.error(formatError);

        return { code: 1, descriptor: undefined, error: formatError, validation: { problems: [], wranglerPath: undefined } };
    }

    const result = await executeDeploy({ ...options, logger: loggerForFormat(options.format, options.logger) });

    if (isJsonFormat(options.format)) {
        printJson(result);
    }

    return result;
};

/** `cirrus deploy` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<DeployOptions> = defineHandler<DeployOptions>(async ({ cwd, logger, options }) => {
    const result = await runDeployCommand({
        allowSchemaDrift: options.allowSchemaDrift === true,
        apiSpec: parseApiSpec(options.apiSpec),
        cwd,
        env: options.env,
        format: options.format,
        logger,
        migrate: options.migrate === true,
        migrateToken: options.migrateToken,
        migrateUrl: options.migrateUrl,
        updateSchemaBaseline: options.updateSchemaBaseline === true,
    });

    return { code: result.code };
});

export { execute };
export type { DeployCommandOptions, DeployCommandResult };
export { runDeployCommand };
