import { existsSync, readFileSync } from "node:fs";

import type { CodegenResult } from "@lunora/codegen";
import { discoverMigrations, runCodegen } from "@lunora/codegen";
import type { ToolchainCommand } from "@lunora/config";
import {
    DEV_VARS_FILE,
    discoverContainerInfo,
    discoverSchemaInfo,
    findWranglerFile,
    generateSecretValue,
    inferLunoraBindings,
    isMintableSecretKey,
    packageNamesFromBindings,
    parseDevVariableEntries,
    readLinkedProject,
    readWranglerJsonc,
    reconcileWranglerBindings,
    reconcileWranglerCompatibilityDate,
    reconcileWranglerCrons,
    requiredSecrets,
    resolveDeployDriver,
} from "@lunora/config";
import { join } from "@visulima/path";
import { Spinner } from "@visulima/spinner";
import { Project } from "ts-morph";

import type { ApiSpec } from "../../util/api-spec";
import { parseApiSpec } from "../../util/api-spec";
import { autoLinkFromDeployOutput } from "../../util/auto-link";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { renderDeploySummary } from "../../util/deploy-summary";
import { resolveTargetOrError } from "../../util/deploy-target";
import { detectPackageManager, execArgsFor } from "../../util/detect-package-manager";
import type { DockerProbe } from "../../util/docker";
import { isDockerAvailable } from "../../util/docker";
import type { Logger } from "../../util/logger";
import { isJsonFormat, loggerForFormat, printJson, validateOutputFormat } from "../../util/output-format";
import { buildRailpackImages } from "../../util/railpack";
import { resolveWorkerUrl } from "../../util/resolve-target";
import { runSchemaDriftGate } from "../../util/schema-drift-gate";
import type { SpawnDescriptor, Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import { createTuiConfirm } from "../../util/tui-prompts";
import type { VectorMetadataIndex } from "../../util/vectorize-metadata";
import { ensureVectorMetadataIndexes, metadataTypeFor } from "../../util/vectorize-metadata";
import type { ListRemoteSecretsInputs, ListRemoteSecretsResult } from "../../util/wrangler-secrets";
import { listRemoteSecrets } from "../../util/wrangler-secrets";
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

    /**
     * Validate, bundle, and run all pre-deploy gates without publishing
     * (`wrangler deploy --dry-run`). Post-deploy steps (data migrations, schema
     * baseline re-bless) are skipped since nothing shipped.
     */
    dryRun?: boolean;
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
     * pending data migrations via the worker's `/_lunora/migrate` admin RPC.
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

    /** Admin bearer token for `--migrate` (falls back to `LUNORA_ADMIN_TOKEN`). */
    migrateToken?: string;

    /**
     * Worker URL for `--migrate`. REQUIRED when `--migrate` is set — the deploy
     * handler never captures the URL `wrangler deploy` published to, so there is
     * no safe default; omitting it would silently target `http://localhost:8787`
     * (the dev worker), applying the migration to local state instead of prod.
     */
    migrateUrl?: string;

    /**
     * Confirm a production data migration triggered via `--migrate` (the
     * `migrate up --prod` confirmation the standalone command requires). Without
     * it a `--migrate --migrate-url &lt;prod>` deploy refuses to run the migration.
     */
    migrateYes?: boolean;

    /**
     * Emit the bundled worker to this directory via `wrangler deploy --outdir`
     * (paired with `dryRun` by `lunora build`). Also writes esbuild metadata to
     * `&lt;outDir>/bundle-meta.json`. When unset, no artifact is written.
     */
    outDir?: string;

    /**
     * Upload a preview version (`wrangler versions upload`) instead of a live
     * `wrangler deploy`. Codegen + the drift gate + validation still run, but
     * the post-deploy finalize (migrations, baseline re-bless, auto-link, the
     * production summary) is skipped — a preview never shifts live traffic.
     */
    preview?: boolean;
    /** Railpack-availability probe injected in tests. Defaults to a real `railpack --version` + `BUILDKIT_HOST` check. */
    railpackAvailable?: DockerProbe;
    /** Confirm prompt for the missing-secret offer; injected in tests. Defaults to the TTY prompt. */
    secretConfirm?: (message: string) => Promise<boolean>;
    /** Remote-secret lister for the missing-secret offer; injected in tests. Defaults to `wrangler secret list`. */
    secretLister?: (inputs: ListRemoteSecretsInputs) => Promise<ListRemoteSecretsResult>;
    skipCodegen?: boolean;
    spawner?: Spawner;

    /**
     * Deploy target. Falls back to `"target"` in `lunora.json`, then
     * `"cloudflare"`, which selects the wrangler
     * toolchain — i.e. today's behavior for every project. An unregistered name
     * throws rather than falling back, so a typo can never ship the app to the
     * wrong provider.
     */
    target?: string;

    /**
     * Deploy to a temporary Cloudflare account (`wrangler deploy --temporary`).
     * For unauthenticated use only: wrangler provisions a short-lived account +
     * token, deploys, and prints a claim URL; the deployment stays live ~60
     * minutes before the unclaimed account is deleted. Wrangler itself errors
     * if credentials are already present (OAuth / `CLOUDFLARE_API_TOKEN` /
     * global API key), so we pass the flag straight through without guarding.
     */
    temporary?: boolean;
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
    vars?: Record<string, unknown>;
}

/**
 * Worker-origin `vars` that must resolve to the deployed worker's public URL.
 * A Cloudflare Worker can't reach `localhost`, so a localhost value here means
 * scheduled-job dispatch (SchedulerDO → `LUNORA_ORIGIN_URL`) and auth callbacks
 * (`AUTH_URL`) silently break in production.
 */
const ORIGIN_VAR_NAMES = ["LUNORA_ORIGIN_URL", "LUNORA_WORKER_ORIGIN", "AUTH_URL"] as const;

/** True when a URL string resolves to a loopback host (localhost / 127.0.0.1 / ::1). */
const isLocalhostUrl = (value: string): boolean => {
    try {
        const { hostname } = new URL(value);

        return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
    } catch {
        return false;
    }
};

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
 * itself point at Lunora's composition. The template instead ships a
 * `src/worker.ts` that imports that generated handler, wraps it with
 * `withLunora` (mounting `/_lunora/*`), and re-exports `ShardDO`. When that file
 * exists we pass it as the positional deploy entry so the ONE deployed worker is
 * the composed one — the positional argument overrides `main`. Class-A/C
 * templates have no `src/worker.ts` (their `main` already points at the real
 * entry), so this returns `undefined` and `wrangler` uses `main` as usual.
 */
const resolveComposedWorkerEntry = (cwd: string): string | undefined => (existsSync(join(cwd, "src", "worker.ts")) ? "src/worker.ts" : undefined);

/**
 * Verify every container's local build source exists before wrangler/railpack
 * runs. A Dockerfile/build-dir typo otherwise fails opaquely mid-deploy.
 * Registry images have no local source, so they're skipped. Returns the first
 * error message, or `undefined` when all sources exist (or none are local).
 */
const checkContainerSourcesExist = (cwd: string, logger: Logger): string | undefined => {
    for (const container of discoverContainerInfo(cwd, "lunora").containers) {
        const { image } = container;

        if (image.kind === "dockerfile" && !existsSync(join(cwd, image.dockerfilePath))) {
            const message = `deploy blocked: container "${container.exportName}" references a Dockerfile at "${image.dockerfilePath}" that does not exist. Create it or fix the \`image\` path in lunora/containers.ts.`;

            logger.error(message);

            return message;
        }

        if (image.kind === "build" && !existsSync(join(cwd, image.buildDir))) {
            const message = `deploy blocked: container "${container.exportName}" references a Railpack build directory "${image.buildDir}" that does not exist. Create it or fix the \`image.build\` path in lunora/containers.ts.`;

            logger.error(message);

            return message;
        }
    }

    return undefined;
};

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
 * the build sources from `lunora/containers.ts` (not wrangler.jsonc — by the
 * time it's reconciled the build kind is indistinguishable from a registry ref)
 * and delegates to the testable {@link buildRailpackImages} orchestrator.
 * Returns an error message when a build is blocked or fails, else `undefined`.
 */
const buildContainerImages = async (cwd: string, options: DeployCommandOptions): Promise<string | undefined> => {
    const targets = discoverContainerInfo(cwd, "lunora")
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
 * Reconcile the committed `triggers.crons` with the schedules codegen discovered.
 *
 * `undefined` means codegen was skipped (e.g. `--prebuilt`): we have no evidence
 * of the project's crons, so leave the committed `triggers.crons` untouched —
 * clearing it would silently stop every production cron. A defined array
 * (including `[]`) means codegen ran and reconciling — clearing a
 * genuinely-removed last cron — is intended. Mirrors the
 * `if (codegen !== undefined)` guard on the schema-drift gate.
 */
const syncCronTriggers = (cwd: string, logger: Logger, cronTriggers: ReadonlyArray<string> | undefined): void => {
    if (cronTriggers === undefined) {
        return;
    }

    try {
        const reconciled = reconcileWranglerCrons(cwd, cronTriggers);

        if (reconciled.changed) {
            logger.success(`synced ${String(cronTriggers.length)} cron trigger(s) → ${reconciled.wranglerPath ?? "wrangler.jsonc"}`);
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger.warn(`cron trigger sync skipped: ${message}`);
    }
};

/**
 * Auto-provision the bindings the project's code implies before validating, so
 * a first deploy doesn't fail on a SESSION/SCHEDULER/DB binding the user never
 * had to hand-write. Idempotent — a no-op once the config is in sync — and
 * best-effort: a failure here must not abort the deploy, since the validator
 * still reports any genuinely missing requirement.
 */
const provisionBindings = async (cwd: string, logger: Logger, cronTriggers: ReadonlyArray<string> | undefined, target: string): Promise<void> => {
    try {
        // Resolved for its side effect: reject an unregistered target before
        // reconciling a config shaped for the wrong provider. `prepare` routes
        // its provisioning through `DeployDriver.provision`; deploy still
        // reconciles inline, so this is the narrower equivalent guard.
        resolveDeployDriver(target);

        const inferred = await inferLunoraBindings({ projectRoot: cwd });
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

    try {
        const reconciled = reconcileWranglerCompatibilityDate(cwd);

        if (reconciled.changed) {
            logger.success(
                `bumped compatibility_date to ${reconciled.date ?? "unknown"} (Workers Cache enabled) → ${reconciled.wranglerPath ?? "wrangler.jsonc"}`,
            );
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger.warn(`compatibility date sync skipped: ${message}`);
    }

    syncCronTriggers(cwd, logger, cronTriggers);
};

/**
 * Print a NON-BLOCKING reminder that `wrangler deploy` does not push secrets.
 * `lunora deploy` ships code + bindings but never uploads `.dev.vars` values —
 * those are pushed separately via `lunora env push`. So a user who edited
 * `.dev.vars` and then deployed would otherwise be left with stale/missing
 * deployed secrets and no signal that anything drifted (Supabase #45242).
 *
 * This only fires when a local `.dev.vars` actually exists and carries at least
 * one key — there's nothing to remind about otherwise. It is a warning only and
 * never aborts the deploy; it does not prompt, so it's safe under
 * `--yes`/non-interactive flows.
 */
const warnDevVariablesNotPushed = (cwd: string, logger: Logger): void => {
    const devVariablesPath = join(cwd, DEV_VARS_FILE);

    if (!existsSync(devVariablesPath)) {
        return;
    }

    let keyCount: number;

    try {
        keyCount = parseDevVariableEntries(readFileSync(devVariablesPath, "utf8")).length;
    } catch {
        // A read/parse failure here must never block a deploy — skip the reminder.
        return;
    }

    if (keyCount === 0) {
        return;
    }

    logger.warn(
        `Note: \`lunora deploy\` does not push secrets. ${DEV_VARS_FILE} has ${String(keyCount)} key(s); ` +
            `if you changed them, run \`lunora env push --yes\` to update the deployed secrets.`,
    );
};

/** A `.dev.vars` key whose value is a secret (vs. a plain config var like a URL). Module-scoped to avoid recompilation. */
const SECRET_LIKE_KEY = /(?:KEY|PASSWORD|SECRET|TOKEN)$/u;

/** The secret keys this project requires on the deployed worker: its packages' + any secret-typed local var. */
const resolveRequiredSecretKeys = async (cwd: string): Promise<string[]> => {
    let packages: ReadonlyArray<string> = [];

    try {
        packages = packageNamesFromBindings(await inferLunoraBindings({ projectRoot: cwd }));
    } catch {
        // Scan failure → fall back to the core secrets + whatever is declared locally.
    }

    const fromPackages = requiredSecrets(packages).map((entry) => entry.key);

    let fromLocal: string[] = [];

    try {
        const devVariablesPath = join(cwd, DEV_VARS_FILE);

        if (existsSync(devVariablesPath)) {
            // Only secret-typed local vars count as "required secrets" on the worker;
            // a non-secret var (e.g. a URL) belongs in wrangler.jsonc `vars`, not secrets.
            fromLocal = parseDevVariableEntries(readFileSync(devVariablesPath, "utf8"))
                .map((entry) => entry.key)
                .filter((key) => SECRET_LIKE_KEY.test(key));
        }
    } catch {
        // Unreadable .dev.vars → packages-only.
    }

    return [...new Set([...fromPackages, ...fromLocal])];
};

/** Generate + `wrangler secret put` each mintable key (sequential; stops on first failure). Returns true on full success. */
const pushMintableSecrets = async (cwd: string, options: DeployCommandOptions, keys: ReadonlyArray<string>, target: string): Promise<boolean> => {
    const { logger } = options;
    const spawner = options.spawner ?? defaultSpawner;
    const manager = detectPackageManager(cwd);
    const environmentFlag = options.env === undefined ? "" : ` --env ${options.env}`;

    const { toolchain } = resolveDeployDriver(target);

    if (toolchain?.secretPut === undefined) {
        // Either the target has no CLI at all, or it has one with no secret
        // step — an IaC-backed target declares secrets as resources inside its
        // program instead. Reported rather than skipped: a silent no-op here
        // would look like the secrets were pushed.
        logger.error("deploy target has no command-line secret step; push secrets through the target's own tooling");

        return false;
    }

    for (const key of keys) {
        const secretCommand = toolchain.secretPut({ environment: options.env, key, temporary: options.temporary });

        if (secretCommand === undefined) {
            logger.error(`deploy target has no secret command for "${key}"`);

            return false;
        }

        const exec = execArgsFor(manager, secretCommand.tool, secretCommand.args);

        // `wrangler secret put <name>` reads the value from stdin, so the generated
        // secret never lands on the command line, in env, or in shell history.
        // eslint-disable-next-line no-await-in-loop -- push sequentially so a failure aborts before the rest.
        const pushResult = await spawner({ args: exec.args, command: exec.command, cwd, input: generateSecretValue() });

        if (pushResult.code !== 0) {
            logger.error(
                `failed to push secret ${key} (exit ${String(pushResult.code)}); set it manually with \`wrangler secret put ${key}${environmentFlag}\`.`,
            );

            return false;
        }

        logger.success(`generated + pushed ${key}`);
    }

    return true;
};

/**
 * Before a live deploy, detect required secrets that are NOT yet set on the
 * target worker and resolve them. INTERACTIVE: offer to generate + push the
 * mintable secrets (`AUTH_SECRET`, `LUNORA_ADMIN_TOKEN`, …) in place and flag
 * provider secrets (`RESEND_API_KEY`, `STRIPE_*`) to set by hand.
 * NON-INTERACTIVE (CI): there's nothing to prompt, so a missing required secret
 * aborts the deploy — returns an error message rather than shipping a worker
 * that will crash on a missing secret. Returns `undefined` when the deploy may
 * proceed.
 *
 * Best-effort detection: a dry-run/preview publishes nothing (skip), and if the
 * worker doesn't exist yet (first deploy) or wrangler isn't authenticated the
 * secret list can't be read — we proceed rather than guess. Any pushing happens
 * BEFORE the deploy spawn so the new version boots with the secrets present.
 */
const offerMissingSecrets = async (cwd: string, options: DeployCommandOptions, interactive: boolean, target: string): Promise<string | undefined> => {
    if (options.dryRun === true || options.preview === true) {
        return undefined;
    }

    const { logger } = options;
    const environmentFlag = options.env === undefined ? "" : ` --env ${options.env}`;

    let remote: ListRemoteSecretsResult;

    try {
        remote = await (options.secretLister ?? listRemoteSecrets)({ cwd, env: options.env, temporary: options.temporary });
    } catch {
        return undefined;
    }

    // Can't enumerate (no worker yet / not authed) → nothing actionable to check.
    if (!remote.ok) {
        return undefined;
    }

    const remoteNames = new Set(remote.names);
    const required = await resolveRequiredSecretKeys(cwd);
    const missing = required.filter((key) => !remoteNames.has(key));

    if (missing.length === 0) {
        return undefined;
    }

    // No TTY to prompt on → fail fast rather than deploy a worker that will crash
    // on a missing required secret.
    if (!interactive) {
        return (
            `missing required secret(s) on the deploy target: ${missing.join(", ")}. ` +
            `Set them with \`wrangler secret put <KEY>${environmentFlag}\` ` +
            `(or \`lunora env generate --set\` then \`lunora env push --yes${options.env === undefined ? "" : " --prod"}\`), then re-deploy.`
        );
    }

    for (const key of missing.filter((name) => !isMintableSecretKey(name))) {
        logger.warn(`required secret ${key} is not set on the target — set it with: wrangler secret put ${key}${environmentFlag}`);
    }

    const mintable = missing.filter((key) => isMintableSecretKey(key));

    if (mintable.length === 0) {
        return undefined;
    }

    const confirm = options.secretConfirm ?? createTuiConfirm();

    if (
        await confirm(`${String(mintable.length)} required secret(s) not set on the target (${mintable.join(", ")}). Generate strong values and push them now?`)
    ) {
        await pushMintableSecrets(cwd, options, mintable, target);

        return undefined;
    }

    logger.warn(
        `${String(mintable.length)} required secret(s) not set on the target: ${mintable.join(", ")}. ` +
            `Generate + push with \`lunora env generate --set\` then \`lunora env push --yes${options.env === undefined ? "" : " --prod"}\`.`,
    );

    return undefined;
};

/**
 * Discover migration ids from `lunora/migrations.ts` and run them in declared
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
    const lunoraDirectory = join(cwd, "lunora");
    let migrations: ReadonlyArray<{ id: string; table: string }>;

    try {
        migrations = discoverMigrations(project, lunoraDirectory);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        options.logger.warn(`--migrate: could not discover migrations (${message}); skipping`);

        return 0;
    }

    if (migrations.length === 0) {
        options.logger.info("--migrate: no data migrations declared in lunora/");

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
            // A `--migrate-url` is always set by this point (guarded above), so this
            // is a production migration — gate it behind the operator's explicit
            // `--migrate-yes`/`--yes` rather than auto-confirming.
            prod: true,
            subcommand: "up",
            token: options.migrateToken,
            url: options.migrateUrl,
            yes: options.migrateYes === true,
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
 * Validate the migration options that would otherwise fail only after the live
 * worker has already been replaced by `wrangler deploy`.
 */
const validateMigrateDeployPreflight = (options: DeployCommandOptions): string | undefined => {
    // A dry run / preview never publishes a live version, so post-deploy
    // migrations don't run — don't demand `--migrate-url`/`--migrate-yes` for a
    // `--dry-run --migrate` or `--preview --migrate` combo.
    if (!options.migrate || options.dryRun || options.preview) {
        return undefined;
    }

    // `wrangler deploy`'s published URL is never captured here, so without an
    // explicit `--migrate-url` the downstream migration would default to
    // `http://localhost:8787` (the dev worker) and apply against LOCAL state —
    // and ship the production admin bearer to whatever listens on that port.
    // Refuse before deploying rather than silently targeting localhost later.
    if (options.migrateUrl === undefined) {
        const message =
            "--migrate requires --migrate-url <https://your-worker> — the deploy target URL is not captured automatically, refusing to default to localhost";

        options.logger.error(message);

        return message;
    }

    if (options.migrateYes !== true) {
        const message = "--migrate runs production data migrations after deploy. Re-run with --migrate-yes to confirm.";

        options.logger.error(message);

        return message;
    }

    if ((options.migrateToken ?? process.env.LUNORA_ADMIN_TOKEN) === undefined || (options.migrateToken ?? process.env.LUNORA_ADMIN_TOKEN) === "") {
        const message = "admin token required for --migrate — pass --migrate-token or set LUNORA_ADMIN_TOKEN";

        options.logger.error(message);

        return message;
    }

    return undefined;
};

/**
 * Run codegen (with optional spinner). Returns the {@link CodegenResult} on
 * success (the deploy needs its schema snapshot for the drift gate), or an
 * `{ error }` message on failure.
 */
const runCodegenStep = (
    cwd: string,
    interactive: boolean,
    logger: Logger,
    apiSpec: ApiSpec | undefined,
    target: string,
): { error?: string; result?: CodegenResult } => {
    let codegenSpinner: Spinner | undefined;

    if (interactive) {
        codegenSpinner = new Spinner({ name: "dots" });
        codegenSpinner.start("running codegen");
    } else {
        logger.info("running codegen");
    }

    try {
        const result = runCodegen({ apiSpec, projectRoot: cwd, target });
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
 * Hard-block a deploy when a worker-origin `var` still points at localhost.
 * `lunora deploy` always targets Cloudflare (the dev loop is `lunora dev`), and
 * a Worker can't reach a loopback address — so a localhost origin silently
 * breaks scheduled jobs / auth callbacks in production. Mirrors the
 * D1-placeholder hard-block. Returns the error message, or `undefined` when
 * clean (or when wrangler.jsonc is absent/unparseable — the validator handles
 * that).
 */
const checkLocalhostOriginVariables = (cwd: string, logger: Logger): string | undefined => {
    const wranglerPath = findWranglerFile(cwd);

    if (!wranglerPath) {
        return undefined;
    }

    const { parsed } = readWranglerJsonc<WranglerD1Shape>(wranglerPath);
    const variables = parsed?.vars;

    if (!variables) {
        return undefined;
    }

    const offenders = ORIGIN_VAR_NAMES.filter((name) => typeof variables[name] === "string" && isLocalhostUrl(variables[name]));

    if (offenders.length === 0) {
        return undefined;
    }

    const message =
        `deploy blocked: ${offenders.join(", ")} in wrangler.jsonc point at localhost. A deployed Worker can't reach a loopback ` +
        `address, so this silently breaks scheduled-job dispatch / auth callbacks. Set each to the deployed worker's public URL ` +
        `(or move it to a secret with \`wrangler secret put\`) before deploying.`;

    logger.error(message);

    return message;
};

/**
 * Create the Vectorize metadata indexes the schema's `.vectorize({ metadata })`
 * declarations imply.
 *
 * Cloudflare will not filter on a metadata property that has no index, and it
 * says so by returning nothing rather than by failing — so a schema that
 * declares filterable metadata needs these provisioned or its filters quietly
 * match zero vectors. Idempotent, and non-fatal: the worker is already live, so
 * a failure here is reported with the command to run, not a failed deploy.
 */
const provisionVectorMetadataIndexes = async (options: DeployCommandOptions, cwd: string): Promise<void> => {
    const { info } = discoverSchemaInfo(cwd, "lunora");
    const declared = info?.vectorMetadata ?? [];

    if (declared.length === 0) {
        return;
    }

    const entries: VectorMetadataIndex[] = [];

    for (const declaration of declared) {
        const type = metadataTypeFor(declaration.kind);

        if (type === undefined) {
            options.logger.warn(
                `vector index "${declaration.index}" declares metadata "${declaration.property}", whose column type cannot be filtered on in Vectorize — it is stored with each vector but no filter will match it.`,
            );

            continue;
        }

        entries.push({ index: declaration.index, property: declaration.property, type });
    }

    if (entries.length === 0) {
        return;
    }

    const results = await ensureVectorMetadataIndexes({
        cwd,
        entries,
        exec: execArgsFor(detectPackageManager(cwd), "wrangler", []),
        logger: options.logger,
        spawner: options.spawner ?? defaultSpawner,
    });
    const provisioned = results.filter((result) => result.status !== "failed").length;

    if (provisioned > 0) {
        options.logger.success(`vectorize metadata indexes ready: ${String(provisioned)}/${String(entries.length)}`);
    }
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
    // Before migrations: a data migration may write rows whose vectors are
    // filtered on immediately afterwards.
    await provisionVectorMetadataIndexes(options, cwd);

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

    const localhostOriginError = checkLocalhostOriginVariables(cwd, options.logger);

    if (localhostOriginError !== undefined) {
        return localhostOriginError;
    }

    const sourceError = checkContainerSourcesExist(cwd, options.logger);

    if (sourceError !== undefined) {
        return sourceError;
    }

    const dockerError = checkContainerDockerPreflight(cwd, options.logger, options.dockerAvailable ?? isDockerAvailable);

    if (dockerError !== undefined) {
        return dockerError;
    }

    return buildContainerImages(cwd, options);
};

/**
 * Assemble the `wrangler deploy …` argv (the wrangler subcommand + flags): the
 * class-B composed-entry positional (when present), `--env`, and `--dry-run`.
 * The package-manager launcher (`pnpm exec` / `npx --` / …) is prepended by the
 * caller via {@link execArgsFor}. Extracted from {@link executeDeploy} to keep
 * its cognitive complexity within budget.
 */
const buildDeployCommand = (cwd: string, options: DeployCommandOptions, target: string): ToolchainCommand => {
    // Class-B composition: bundle the `src/worker.ts` wrapper (which the
    // framework's CF adapter can't clobber) instead of the adapter-owned `main`.
    const composedEntry = resolveComposedWorkerEntry(cwd);

    if (composedEntry !== undefined) {
        options.logger.info(`class-B composition: deploying ${composedEntry} (overrides wrangler main)`);
    }

    // A short-lived account is wrangler-provisioned when unauthenticated; it
    // errors itself if credentials are already present.
    if (options.temporary) {
        options.logger.info("temporary account: deploying to a short-lived Cloudflare account (~60min); wrangler will print a claim URL");
    }

    // A dry run validates + bundles without publishing. Nothing ships, so the
    // post-deploy finalize (migrations, baseline re-bless) is skipped by the caller.
    if (options.dryRun) {
        options.logger.info("dry run: validating + bundling without publishing");
    }

    // `lunora build` writes the bundled worker (+ esbuild metafile) to disk for
    // CI artifacting / bundle inspection.
    if (options.outDir !== undefined) {
        options.logger.info(`build artifact: emitting bundle to ${options.outDir}`);
    }

    // The target's own CLI decides the flags; this command only says what it
    // wants done. Logging stays here because it is the CLI's voice, not the
    // driver's.
    const driver = resolveDeployDriver(target);
    const request = {
        dryRun: options.dryRun,
        entry: composedEntry,
        environment: options.env,
        outDir: options.outDir,
        preview: options.preview,
        temporary: options.temporary,
    };

    // Every registered driver ships a toolchain; the optionality on the contract
    // is for a hypothetical API-only host, which cannot be selected today.
    if (driver.toolchain === undefined) {
        throw new Error(`deploy target "${driver.id}" has no command-line toolchain`);
    }

    return driver.toolchain.deploy(request);
};

/** Log wrangler.jsonc validation problems (if any) and report whether the deploy must abort. */
const reportWranglerProblems = (validation: { problems: ReadonlyArray<string> }, logger: Logger): boolean => {
    if (validation.problems.length === 0) {
        return false;
    }

    logger.error("wrangler.jsonc validation failed:");

    for (const problem of validation.problems) {
        logger.error(`  - ${problem}`);
    }

    return true;
};

const executeDeploy = async (options: DeployCommandOptions): Promise<DeployCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const interactive = isInteractive(options);

    // Resolved ONCE, and before anything writes. Deploy rewrites `_generated/*`
    // and may mutate `wrangler.jsonc` well before it reaches the wrangler step,
    // so validating at the point of driver use would leave those side effects
    // behind on an unknown target. Resolving here also means `lunora.json`'s
    // `target` reaches the driver, not just the `--target` flag.
    const resolvedTarget = resolveTargetOrError(cwd, options.target);

    if (resolvedTarget.target === undefined) {
        const message = resolvedTarget.error ?? "unknown deploy target";

        // Logged here, not just returned: the caller only prints `error` in
        // `--format json` mode, so a bare return exits 1 in silence.
        options.logger.error(message);

        return { code: 1, descriptor: undefined, error: message, validation: { problems: [], wranglerPath: undefined } };
    }

    const { target } = resolvedTarget;

    let codegen: CodegenResult | undefined;

    if (!options.skipCodegen) {
        const codegenStep = runCodegenStep(cwd, interactive, options.logger, options.apiSpec, target);

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

    await provisionBindings(cwd, options.logger, codegen?.cronTriggers, target);

    const migratePreflightError = validateMigrateDeployPreflight(options);

    if (migratePreflightError !== undefined) {
        return { code: 1, descriptor: undefined, error: migratePreflightError, validation: { problems: [], wranglerPath: undefined } };
    }

    // Pre-wrangler gates: the D1 placeholder hard-block, the Dockerfile-container
    // Docker preflight, and the Railpack `{ build }` build+push step. Each aborts
    // with a directed message rather than letting wrangler fail opaquely later.
    const preflightError = await runPreDeployGates(cwd, options);

    if (preflightError !== undefined) {
        return { code: 1, descriptor: undefined, error: preflightError, validation: { problems: [], wranglerPath: undefined } };
    }

    const validation = validateWrangler({ projectRoot: cwd });

    if (reportWranglerProblems(validation, options.logger)) {
        return { code: 1, descriptor: undefined, error: "wrangler validation failed", validation };
    }

    // Non-blocking secret-drift reminder: `wrangler deploy` never pushes
    // `.dev.vars` values, so an edited `.dev.vars` would otherwise leave the
    // deployed worker with stale/missing secrets silently (Supabase #45242).
    warnDevVariablesNotPushed(cwd, options.logger);

    // Detect required secrets not yet set on the target. Interactive: offer to
    // generate + push the mintable ones (provider keys flagged to set by hand).
    // Non-interactive (CI): a missing required secret aborts rather than shipping
    // a worker that will crash. Best-effort detection — skips dry-run/preview and
    // stays quiet when the worker can't be queried yet (first deploy / not authed).
    const secretAbort = await offerMissingSecrets(cwd, options, interactive, target);

    if (secretAbort !== undefined) {
        options.logger.error(secretAbort);

        return { code: 1, descriptor: undefined, error: secretAbort, validation };
    }

    // Capture wrangler's stdout (to read the deployed URL for auto-link) only on
    // a first, unlinked, real (non-dry-run, non-preview) pretty-mode deploy — so
    // existing links are never clobbered and subsequent deploys keep full TTY output.
    const shouldAutoLink = !isJsonFormat(options.format) && options.dryRun !== true && options.preview !== true && readLinkedProject(cwd) === undefined;

    const deployCommand = buildDeployCommand(cwd, options, target);
    const exec = execArgsFor(detectPackageManager(cwd), deployCommand.tool, deployCommand.args);
    const descriptor: SpawnDescriptor = {
        args: exec.args,
        captureStdout: shouldAutoLink,
        command: exec.command,
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

    // A dry run published nothing — never run migrations or advance the schema
    // baseline against a deploy that didn't happen.
    if (options.dryRun) {
        return { code: 0, descriptor, validation };
    }

    // A preview uploaded a Version but didn't go live — skip the post-deploy
    // finalize (migrations / baseline re-bless) and auto-link, which only apply
    // to a production deploy. wrangler prints the preview URL itself.
    if (options.preview) {
        return { code: 0, descriptor, validation };
    }

    // Zero-effort linking: record the deployed URL the first time (self-guards
    // when already linked or when stdout wasn't captured).
    autoLinkFromDeployOutput({ cwd, env: options.env, logger: options.logger, output: result.stdout });

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

        return result;
    }

    // Vercel-style summary block after a successful real deploy. Skipped on
    // failure, on dry runs, and on previews (nothing went live; wrangler already
    // printed the preview URL), and never in json mode (the early return above)
    // where it would corrupt the document on stdout.
    if (result.code === 0 && options.dryRun !== true && options.preview !== true) {
        renderDeploySummary({ cwd: options.cwd ?? process.cwd(), env: options.env, logger: options.logger, migrated: options.migrate === true });
    } else if (result.code === 0 && options.preview === true) {
        options.logger.success("preview version uploaded — see the preview URL in the wrangler output above");
    }

    return result;
};

/** `lunora deploy` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<DeployOptions> = defineHandler<DeployOptions>(async ({ cwd, logger, options }) => {
    const result = await runDeployCommand({
        allowSchemaDrift: options.allowSchemaDrift === true,
        apiSpec: parseApiSpec(options.apiSpec),
        cwd,
        dryRun: options.dryRun === true,
        env: options.env,
        format: options.format,
        logger,
        migrate: options.migrate === true,
        migrateToken: options.migrateToken,
        // Fall back to the `.lunora/project.json` link so a linked checkout no
        // longer needs --migrate-url repeated on every `deploy --migrate`.
        migrateUrl: resolveWorkerUrl({ cwd, url: options.migrateUrl }),
        migrateYes: options.migrateYes === true,
        preview: options.preview === true,
        // `--prebuilt` trusts a prior `lunora build`/`prepare`: skip codegen (and
        // thus the drift gate, which has no fresh snapshot to measure).
        skipCodegen: options.prebuilt === true,
        target: options.target,
        temporary: options.temporary === true,
        updateSchemaBaseline: options.updateSchemaBaseline === true,
    });

    return { code: result.code };
});

export { execute };
export type { DeployCommandOptions, DeployCommandResult };
export { runDeployCommand };
