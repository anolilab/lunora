import { existsSync } from "node:fs";

import { discoverMigrations, runCodegen } from "@cirrus/codegen";
import { findWranglerFile, inferCirrusBindings, readWranglerJsonc, reconcileWranglerBindings } from "@cirrus/config";
import { join } from "@visulima/path";
import { Spinner } from "@visulima/spinner";
import { Project } from "ts-morph";

import type { ApiSpec } from "../../util/api-spec";
import { parseApiSpec } from "../../util/api-spec";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
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
    /** Which API spec(s) codegen emits. Defaults to codegen's `"openapi"` when omitted. */
    apiSpec?: ApiSpec;
    cwd?: string;
    env?: string;
    /** Fetch implementation injected in tests for `--migrate` RPC calls. */
    fetchImpl?: FetchLike;
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
    skipCodegen?: boolean;
    spawner?: Spawner;
}

interface DeployCommandResult {
    code: number;
    descriptor: SpawnDescriptor | undefined;
    /** Set when the run aborted before reaching the wrangler invocation. */
    error?: string;
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
    d1_databases?: ReadonlyArray<WranglerD1Entry>;
}

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

/** Run codegen (with optional spinner), returning an error message or `undefined` on success. */
const runCodegenStep = (cwd: string, interactive: boolean, logger: Logger, apiSpec: ApiSpec | undefined): string | undefined => {
    let codegenSpinner: Spinner | undefined;

    if (interactive) {
        codegenSpinner = new Spinner({ name: "dots" });
        codegenSpinner.start("running codegen");
    } else {
        logger.info("running codegen");
    }

    try {
        runCodegen({ apiSpec, projectRoot: cwd });
        codegenSpinner?.succeed("codegen complete");

        if (!codegenSpinner) {
            logger.success("codegen complete");
        }

        return undefined;
    } catch (error: unknown) {
        codegenSpinner?.failed("codegen failed");

        const message = error instanceof Error ? error.message : String(error);

        logger.error(`codegen failed: ${message}`);

        return `codegen failed: ${message}`;
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

const runDeployCommand = async (options: DeployCommandOptions): Promise<DeployCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const interactive = isInteractive(options);

    if (!options.skipCodegen) {
        const codegenError = runCodegenStep(cwd, interactive, options.logger, options.apiSpec);

        if (codegenError !== undefined) {
            return {
                code: 1,
                descriptor: undefined,
                error: codegenError,
                validation: { problems: [], wranglerPath: undefined },
            };
        }
    }

    await provisionBindings(cwd, options.logger);

    // Hard-block: if any D1 binding still carries the placeholder id written by
    // `reconcileWranglerBindings`, deploying would let `wrangler deploy` fail
    // with a confusing "invalid database id" error deep in the output. Abort
    // early with a clear, actionable message.
    const d1Error = checkD1Placeholder(cwd, options.logger);

    if (d1Error !== undefined) {
        return { code: 1, descriptor: undefined, error: d1Error, validation: { problems: [], wranglerPath: undefined } };
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
    };

    options.logger.info(`deploying via ${descriptor.command} ${descriptor.args.join(" ")}`);

    const spawner = options.spawner ?? defaultSpawner;
    const result = await spawner(descriptor);

    if (result.code !== 0) {
        return { code: result.code, descriptor, validation };
    }

    // Post-deploy migrations: only when explicitly requested AND deploy succeeded.
    if (options.migrate) {
        const migrateCode = await runPostDeployMigrations(options, cwd);

        return { code: migrateCode, descriptor, validation };
    }

    return {
        code: result.code,
        descriptor,
        validation,
    };
};

/** `cirrus deploy` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<DeployOptions> = defineHandler<DeployOptions>(({ cwd, logger, options }) =>
    runDeployCommand({
        apiSpec: parseApiSpec(options.apiSpec),
        cwd,
        env: options.env,
        logger,
        migrate: options.migrate === true,
        migrateToken: options.migrateToken,
        migrateUrl: options.migrateUrl,
    }),
);

export { execute };
export type { DeployCommandOptions, DeployCommandResult };
export { runDeployCommand };
