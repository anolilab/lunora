import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { CodegenResult } from "@lunora/codegen";
import { discoverMigrations, runCodegen } from "@lunora/codegen";
import type { ToolchainCommand } from "@lunora/config";
import {
    DEV_VARS_FILE,
    discoverContainerInfo,
    discoverSchemaInfo,
    generateSecretValue,
    inferLunoraBindings,
    isMintableSecretKey,
    packageNamesFromBindings,
    parseDevVariableEntries,
    requiredSecrets,
    resolveDeployDriver,
    upsertDevVariableLine,
    writeDevVariablesFileAtomically,
} from "@lunora/config";
import type { WranglerConfig } from "@lunora/config/cloudflare";
import {
    findWranglerFile,
    mergeWranglerEnvironment,
    readWranglerJsonc,
    reconcileWranglerBindings,
    reconcileWranglerCompatibilityDate,
    reconcileWranglerCrons,
} from "@lunora/config/cloudflare";
import { join } from "@visulima/path";
import { Spinner } from "@visulima/spinner";
import { Project } from "ts-morph";

import { isSecretKeyName } from "../../../../../shared/secret-key";
import { evaluateAdvisoryGate, resolveStrictAdvisories } from "../../util/advisory-gate";
import type { ApiSpec } from "../../util/api-spec";
import { parseApiSpec } from "../../util/api-spec";
import { autoLinkFromDeployOutput, parseDeployedUrl } from "../../util/auto-link";
import { writeBindingManifestFile } from "../../util/binding-manifest-file";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { renderDeploySummary } from "../../util/deploy-summary";
import { resolveRunnableTargetOrError } from "../../util/deploy-target";
import { detectPackageManager, execArgsFor } from "../../util/detect-package-manager";
import type { DockerProbe } from "../../util/docker";
import { isDockerAvailable } from "../../util/docker";
import type { HealthFetch } from "../../util/health-probe";
import { HEALTH_PATH, HEALTH_READY_PATH, probeHealth } from "../../util/health-probe";
import type { Logger } from "../../util/logger";
import { isJsonFormat, loggerForFormat, printJson, validateOutputFormat } from "../../util/output-format";
import reportPlatformDiagnostics from "../../util/platform-diagnostics";
import { runPostCodegenHook } from "../../util/post-codegen-hook";
import { buildRailpackImages } from "../../util/railpack";
import { resolveWorkerUrl } from "../../util/resolve-target";
import { runSchemaDriftGate } from "../../util/schema-drift-gate";
import type { SpawnDescriptor, Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import { createTuiConfirm } from "../../util/tui-prompts";
import type { VectorMetadataIndex } from "../../util/vectorize-metadata";
import { ensureVectorMetadataIndexes, metadataTypeFor } from "../../util/vectorize-metadata";
import readWranglerName from "../../util/wrangler-name";
import type { ListRemoteSecretsInputs, ListRemoteSecretsResult } from "../../util/wrangler-secrets";
import { listRemoteSecrets } from "../../util/wrangler-secrets";
import snapshotWranglerConfig from "../../util/wrangler-snapshot";
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

    /**
     * The command the operator actually ran. `build` delegates here with
     * `dryRun: true`; without this the gate names the wrong command in its
     * blocked message and offers flags the real caller does not accept.
     */
    commandName?: PreDeployCommand;
    cwd?: string;
    /** Docker-availability probe injected in tests. Defaults to a real `docker info` check. */
    dockerAvailable?: DockerProbe;

    /**
     * Validate, bundle, and run all pre-deploy gates without publishing
     * (`wrangler deploy --dry-run`). Post-deploy steps (data migrations, schema
     * baseline re-bless) are skipped since nothing shipped.
     */
    dryRun?: boolean;

    /**
     * Write the binding manifest (`build --emit-bindings`) to this path once the
     * bundle exists. Owned here rather than by the caller because it is the last
     * artifact that has to read the PROVISIONED `wrangler.jsonc`, and the dry-run
     * rollback below closes that window as soon as this function returns.
     * Relative paths resolve against the project root.
     */
    emitBindings?: string;
    env?: string;
    /** Fetch implementation injected in tests for `--migrate` RPC calls. */
    fetchImpl?: FetchLike;
    /** Output format: `pretty` (default) or `json`. */
    format?: string;

    /**
     * After a successful live deploy, probe the new version's health route
     * (`/_lunora/health/ready`, falling back to `/_lunora/health`) and fail the
     * command when it never answers. Opt-in, not default-on: a worker whose
     * health route is admin-gated or unreachable from CI must still be
     * deployable, and a default network step would turn a successful deploy
     * into a red build for an unrelated reason.
     */
    healthCheck?: boolean;

    /** Injectable fetch for `--health-check`; defaults to the global `fetch`. */
    healthFetch?: HealthFetch;
    /** Injectable inter-attempt delay for `--health-check`; injected in tests to skip the real wait. */
    healthSleep?: (ms: number) => Promise<void>;
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
     * it a `--migrate --migrate-url <prod>` deploy refuses to run the migration.
     */
    migrateYes?: boolean;

    /**
     * Emit the bundled worker to this directory via `wrangler deploy --outdir`
     * (paired with `dryRun` by `lunora build`). Also writes esbuild metadata to
     * `<outDir>/bundle-meta.json`. When unset, no artifact is written.
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
     * Fail the deploy when codegen reports an ERROR-level advisory. Same
     * option `lunora codegen` exposes as `--no-strict-advisories`; defaults to
     * CI detection (on in CI, off locally) so a legitimately-partial target
     * can still be shipped interactively. Does NOT gate platform diagnostics
     * (`platform_unsupported_feature` / `platform_unknown_target`), which
     * always block — those mean the emitted `ctx.*` surface does not match
     * what the target can serve, not merely a style nit.
     */
    strictAdvisories?: boolean;

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

/**
 * What this run put where — the identity of the thing that was just deployed.
 *
 * Present on every run that reached (and completed) the wrangler invocation,
 * including `--dry-run` and `--preview`, so a consumer can tell "nothing went
 * live" from "went live" without inferring it from a missing `url`. A dry run
 * publishes nothing and therefore never carries a `url`.
 *
 * No `versionId`: the pinned wrangler (see the `wrangler` catalog entry in
 * `pnpm-workspace.yaml`) has no structured deploy output
 * and no flag that returns the version id — it only prints it in prose, and
 * scraping a second value out of prose is exactly what this shouldn't do. The
 * id is available from `lunora deployments list` after the fact.
 */
interface DeployedIdentity {
    /** ISO-8601 stamp taken when the wrangler invocation returned. */
    deployedAt: string;
    /** True when `--dry-run` validated + bundled without publishing. */
    dryRun: boolean;
    /** The Cloudflare environment this run targeted, when `--env` named one. */
    env?: string;
    /** True when `--preview` uploaded a version instead of shifting live traffic. */
    preview: boolean;
    /** The URL wrangler reported publishing to; absent on a dry run, or when the output carried no URL. */
    url?: string;
    /** The Worker name from the project's wrangler config. */
    workerName?: string;
}

interface DeployCommandResult {
    code: number;
    /** What was deployed and where — set once the wrangler invocation completed. */
    deployment?: DeployedIdentity;
    descriptor: SpawnDescriptor | undefined;
    /** Set when the run aborted before reaching the wrangler invocation. */
    error?: string;

    /**
     * The `--health-check` probe's verdict, when the flag was set and the probe
     * ran. A red probe fails the command (`code` is non-zero) — but the deploy
     * itself still succeeded, which is why the reason is reported separately
     * from `error`.
     */
    healthCheck?: { error?: string; ok: boolean; url: string };

    /**
     * The `.dev.vars`-shaped filename (never a full path, never a value) a
     * secret minted during this run was recorded into, when the missing-
     * secret gate minted one — `.dev.vars` for the default environment, or a
     * `.dev.vars.<env>` sibling for an explicit `--env`. `undefined` when
     * nothing was minted this run.
     */
    mintedSecretsFile?: string;
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
 * Find and parse the project's wrangler.jsonc **in the `--env` view wrangler
 * will deploy**; `undefined` when absent or unparseable.
 *
 * `vars`, `d1_databases` and `containers` are all non-inheritable in wrangler,
 * so `deploy --env staging` uses `env.staging`'s values and ignores the top
 * level entirely. Reading the top level here shipped an env-scoped placeholder
 * database_id / loopback origin silently, and falsely blocked the reverse
 * layout (dev values at the top, real ones in the env block). Shares
 * `mergeWranglerEnvironment` with the validator so both agree with wrangler.
 */
const readWranglerShape = (cwd: string, environment?: string): WranglerD1Shape | undefined => {
    const wranglerPath = findWranglerFile(cwd);

    if (!wranglerPath) {
        return undefined;
    }

    const { parsed } = readWranglerJsonc<WranglerConfig>(wranglerPath);

    if (parsed === undefined) {
        return undefined;
    }

    // An undeclared `--env` is the validator's error to report (it never reaches
    // the wrangler spawn), so fall back to the unmerged view rather than
    // duplicating that message from a preflight.
    const { error, merged } = mergeWranglerEnvironment(parsed, environment);
    // Read back as `unknown`: `WranglerConfig` describes a WELL-FORMED config,
    // but this is hand-written JSONC where `"d1_databases": {}` type-checks as
    // an array and then throws `.filter is not a function` inside a preflight.
    // Normalised once here rather than at each gate — a malformed shape is the
    // validator's error to report, never a stack trace out of a gate.
    const view = (error === undefined ? merged : parsed) as Record<string, unknown>;
    const { containers, d1_databases: databases, vars } = view;

    return {
        containers: Array.isArray(containers) ? (containers as WranglerD1Shape["containers"]) : undefined,
        d1_databases: Array.isArray(databases) ? (databases as WranglerD1Shape["d1_databases"]) : undefined,
        vars: typeof vars === "object" && vars !== null && !Array.isArray(vars) ? (vars as Record<string, unknown>) : undefined,
    };
};

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
const checkContainerDockerPreflight = (
    cwd: string,
    logger: Logger,
    dockerAvailable: DockerProbe,
    command: PreDeployCommand = "deploy",
    environment?: string,
): string | undefined => {
    const localImages = (readWranglerShape(cwd, environment)?.containers ?? []).filter(
        (entry) => typeof entry?.image === "string" && isLocalImagePath(entry.image),
    );

    if (localImages.length === 0 || dockerAvailable()) {
        return undefined;
    }

    const message =
        `${command} blocked: wrangler.jsonc declares ${String(localImages.length)} container(s) built from a local Dockerfile, but no Docker-compatible ` +
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
const checkContainerSourcesExist = (cwd: string, logger: Logger, command: PreDeployCommand = "deploy"): string | undefined => {
    for (const container of discoverContainerInfo(cwd, "lunora").containers) {
        const { image } = container;

        if (image.kind === "dockerfile" && !existsSync(join(cwd, image.dockerfilePath))) {
            const message = `${command} blocked: container "${container.exportName}" references a Dockerfile at "${image.dockerfilePath}" that does not exist. Create it or fix the \`image\` path in lunora/containers.ts.`;

            logger.error(message);

            return message;
        }

        if (image.kind === "build" && !existsSync(join(cwd, image.buildDir))) {
            const message = `${command} blocked: container "${container.exportName}" references a Railpack build directory "${image.buildDir}" that does not exist. Create it or fix the \`image.build\` path in lunora/containers.ts.`;

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
const findD1PlaceholderBinding = (cwd: string, environment?: string): string | undefined =>
    (readWranglerShape(cwd, environment)?.d1_databases ?? []).find((entry) => entry.database_id === D1_PLACEHOLDER_ID)?.binding;

/**
 * Build + push any Railpack `{ build }` containers before wrangler runs. Reads
 * the build sources from `lunora/containers.ts` (not wrangler.jsonc — by the
 * time it's reconciled the build kind is indistinguishable from a registry ref)
 * and delegates to the testable {@link buildRailpackImages} orchestrator.
 * Returns an error message when a build is blocked or fails, else `undefined`.
 */
const buildContainerImages = async (cwd: string, options: DeployCommandOptions): Promise<string | undefined> => {
    // A dry run publishes nothing, and this pushes to the Cloudflare Registry —
    // the same reason `offerMissingSecrets` skips. The comment at the call site
    // called this "deploy-only" while nothing enforced it, so `lunora build` and
    // `deploy --dry-run` both shipped an image. The read-only container checks
    // (missing build dir / Dockerfile) still run in `runPreDeployChecks`, so a
    // dry run keeps reporting what a real deploy would reject.
    if (options.dryRun === true) {
        return undefined;
    }

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
const provisionBindings = async (
    cwd: string,
    logger: Logger,
    cronTriggers: ReadonlyArray<string> | undefined,
    target: string,
    environment: string | undefined,
): Promise<void> => {
    try {
        // Resolved for its side effect: reject an unregistered target before
        // reconciling a config shaped for the wrong provider. Every caller
        // (deploy, prepare, and `lunora dev`'s wrangler flavor) reconciles
        // through this function, so this is the one guard.
        resolveDeployDriver(target);

        const inferred = await inferLunoraBindings({ projectRoot: cwd });
        const reconciled = reconcileWranglerBindings(cwd, inferred, environment);

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
                .filter((key) => isSecretKeyName(key));
        }
    } catch {
        // Unreadable .dev.vars → packages-only.
    }

    return [...new Set([...fromPackages, ...fromLocal])];
};

/**
 * `wrangler secret put <name>` is Cloudflare's write-only channel — the
 * value never comes back. A previous version of this function minted a fresh
 * value for every key and piped it straight to `secret put`, without binding
 * it to anything the caller could see: the only trace was a key-name log
 * line, so the operator could never again use the secret it just created
 * (studio against prod, `lunora insights`, admin RPCs). Recovery meant minting
 * again, invalidating anything already holding the first value.
 *
 * Now: mint a fresh value for every missing key, push it, and return it in
 * `minted` so the caller can record it in `.dev.vars` — the only local record
 * of a value this function itself must never print, log, or return anywhere
 * else. Sequential; stops on first failure. `ok` is `false` the moment any
 * `secret put` fails — `minted` still holds whatever succeeded before that,
 * because those values are equally unrecoverable if discarded.
 *
 * Deliberately does NOT reuse an existing local `.dev.vars` value for a
 * missing key, even a non-placeholder one — an earlier version of this
 * function did, on the theory that a real local value needs no fresh
 * disclosure. That reasoning doesn't hold: `isPlaceholderValue` is a marker
 * heuristic (empty / `<…>` / `changeme` / `todo` / …), not a strength check,
 * so a real-but-weak shared dev secret (`AUTH_SECRET="devsecret"`) would
 * silently become the value protecting `--env production`, and the confirm
 * prompt never named which keys were about to be promoted that way. Minting
 * fresh for every missing key is the only choice that can't leak a weak
 * local value into a production credential.
 */
const pushMintableSecrets = async (
    cwd: string,
    options: DeployCommandOptions,
    keys: ReadonlyArray<string>,
    target: string,
): Promise<{ minted: ReadonlyArray<{ key: string; value: string }>; ok: boolean }> => {
    const { logger } = options;
    const spawner = options.spawner ?? defaultSpawner;
    const manager = detectPackageManager(cwd);
    const environmentFlag = options.env === undefined ? "" : ` --env ${options.env}`;

    const { toolchain } = resolveDeployDriver(target);

    if (toolchain === undefined) {
        logger.error("deploy target has no command-line toolchain; cannot push secrets");

        return { minted: [], ok: false };
    }

    const minted: { key: string; value: string }[] = [];

    for (const key of keys) {
        const value = generateSecretValue();

        const secretCommand = toolchain.secretPut({ environment: options.env, key, temporary: options.temporary });
        const exec = execArgsFor(manager, secretCommand.tool, secretCommand.args);

        // `wrangler secret put <name>` reads the value from stdin, so the value
        // never lands on the command line, in env, or in shell history.
        // eslint-disable-next-line no-await-in-loop -- push sequentially so a failure aborts before the rest.
        const pushResult = await spawner({ args: exec.args, command: exec.command, cwd, input: value });

        if (pushResult.code !== 0) {
            logger.error(
                `failed to push secret ${key} (exit ${String(pushResult.code)}); set it manually with \`wrangler secret put ${key}${environmentFlag}\`.`,
            );

            return { minted, ok: false };
        }

        minted.push({ key, value });
        // Destination is `persistMintedSecrets`'s call — it knows the actual
        // path (bare `.dev.vars` vs. an `--env`-scoped sibling); don't claim
        // one here.
        logger.success(`generated + pushed ${key}`);
    }

    return { minted, ok: true };
};

/**
 * Plain-identifier check before `options.env` is spliced into a filename
 * (`.dev.vars.<env>`) — defense-in-depth; a `--env <name>` naming no
 * declared `wrangler.jsonc` environment is already blocked earlier in the
 * deploy pipeline (`validateWrangler`), so this should be unreachable in
 * practice.
 */
const SAFE_ENV_NAME = /^[\w-]+$/u;

/**
 * The `.gitignore` lines that cover every `.dev.vars`-shaped file this command
 * can write. `.dev.vars` alone is an exact-name pattern and does not match the
 * `.dev.vars.<env>` sibling; the negation keeps a checked-in
 * `.dev.vars.example` visible. Same set the `lunora init` overlay writes.
 */
const DEV_VARS_IGNORE_PATTERNS = [".dev.vars", ".dev.vars.*", "!.dev.vars.example"];

/** Split a `.gitignore` on either line ending, so a CRLF file's patterns still match. */
const GITIGNORE_LINE = /\r?\n/u;

/**
 * Make sure the project's `.gitignore` covers the `.dev.vars`-shaped file this
 * deploy is about to write a freshly minted PRODUCTION secret into.
 *
 * git's `.dev.vars` pattern matches that exact name and nothing else, so the
 * `.dev.vars.<env>` sibling an `--env` deploy writes was untracked but NOT
 * ignored: the next `git add -A` commits a live admin token / auth secret. Every
 * scaffolded project ships the bare pattern only, and a project not scaffolded
 * by `lunora init` ships whatever its author wrote — so the guard belongs here,
 * at the one place a secret value ever reaches the disk, rather than in each
 * template. Appends only what is missing, and is a no-op once present.
 *
 * Best-effort: a `.gitignore` that cannot be written (read-only checkout, no
 * git at all) must not cost the user the only recoverable copy of a write-only
 * secret, so it warns and lets the write proceed.
 */
const ensureDevVariablesIgnored = (cwd: string, logger: Logger): void => {
    const gitignorePath = join(cwd, ".gitignore");

    try {
        const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
        const lines = new Set(existing.split(GITIGNORE_LINE).map((line) => line.trim()));
        const missing = DEV_VARS_IGNORE_PATTERNS.filter((pattern) => !lines.has(pattern));

        if (missing.length === 0) {
            return;
        }

        const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";

        writeFileSync(gitignorePath, `${existing}${prefix}\n# Lunora — never commit a minted secret\n${missing.join("\n")}\n`, "utf8");
        logger.info(`.gitignore: added ${missing.join(", ")} so the recorded secret cannot be committed`);
    } catch (error) {
        logger.warn(
            `could not update .gitignore (${error instanceof Error ? error.message : String(error)}) — add \`${DEV_VARS_IGNORE_PATTERNS.join("` and `")}\` by hand before committing.`,
        );
    }
};

/**
 * Fold newly-minted secret values into the right `.dev.vars`-shaped file, via
 * the same surgical upsert `env generate --set` uses, written atomically and
 * owner-only (`writeDevVariablesFileAtomically`, matching `@lunora/config`'s
 * own `.dev.vars` writers) — a plain `writeFileSync` would let a process
 * interrupted mid-write truncate the file, destroying every OTHER secret in
 * it alongside the new one, which for a value with no other recoverable copy
 * (Cloudflare secrets are write-only) is worse than not writing at all. A
 * no-op (returning `undefined`) when nothing was minted.
 *
 * Which file depends on `options.env`:
 * - No explicit `--env`: the deploy targets the account's one default environment — the same one `.dev.vars`/`lunora dev`/a plain `lunora env push` already treat as authoritative — so the minted value goes into `.dev.vars` itself, same as `env set`/`env generate --set` would.
 * - An explicit `--env <name>`: a DIFFERENT, named environment. Writing that secret into the bare, environment-agnostic `.dev.vars` would silently share it with local dev and with a later no-`--env` `env push` — the exact cross-environment leak an `--env`-scoped deploy is supposed to avoid. So it goes into a sibling `.dev.vars.<name>` instead, after {@link ensureDevVariablesIgnored} has made that filename un-committable. No other command reads `.dev.vars.<name>` today — it exists purely as this deploy's own recoverable record of a value `wrangler secret put` can never return; open it by hand to retrieve the value.
 *
 * Returns the (relative) filename written, or `undefined` when nothing was
 * recorded — the caller threads this through the deploy result so the
 * end-of-deploy summary can point at it too, alongside the KEY-only success
 * log this function prints immediately (a single trailing line naming every
 * minted key once, rather than repeating the file per key).
 */
const persistMintedSecrets = (cwd: string, options: DeployCommandOptions, minted: ReadonlyArray<{ key: string; value: string }>): string | undefined => {
    if (minted.length === 0) {
        return undefined;
    }

    const keys = minted.map((entry) => entry.key).join(", ");

    if (options.env !== undefined && !SAFE_ENV_NAME.test(options.env)) {
        options.logger.warn(
            `${keys}: minted and pushed for --env ${options.env}, but "${options.env}" isn't a safe filename fragment — the value could not be recorded. Capture it manually if you need it again.`,
        );

        return undefined;
    }

    const targetFile = options.env === undefined ? DEV_VARS_FILE : `${DEV_VARS_FILE}.${options.env}`;

    ensureDevVariablesIgnored(cwd, options.logger);

    const devVariablesPath = join(cwd, targetFile);
    let raw = existsSync(devVariablesPath) ? readFileSync(devVariablesPath, "utf8") : "";

    for (const entry of minted) {
        raw = upsertDevVariableLine(raw, entry.key, entry.value);
    }

    writeDevVariablesFileAtomically(devVariablesPath, raw);

    options.logger.success(
        options.env === undefined
            ? `${keys}: value(s) recorded in ${targetFile}`
            : `${keys}: value(s) recorded in ${targetFile} (kept separate from ${DEV_VARS_FILE} so \`lunora dev\` and a plain \`lunora env push\` don't inherit the --env ${options.env} value)`,
    );

    return targetFile;
};

/** {@link offerMissingSecrets}'s outcome: an abort message (deploy must not proceed) and/or the file a minted secret was recorded into, if any. */
interface MissingSecretsOutcome {
    /** Set when the deploy must abort before reaching the wrangler spawn. */
    error?: string;
    /** The `.dev.vars`-shaped file a minted secret was recorded into this run, if any — set even alongside `error` (see the mint-failure branch below), so a partially-recorded secret is never dropped from the caller's view. */
    mintedSecretsFile?: string;
}

/**
 * Before a live deploy, detect required secrets that are NOT yet set on the
 * target worker and resolve them. INTERACTIVE: offer to generate + push the
 * mintable secrets (`AUTH_SECRET`, `LUNORA_ADMIN_TOKEN`, …) in place and flag
 * provider secrets (`RESEND_API_KEY`, `STRIPE_*`) to set by hand.
 * NON-INTERACTIVE (CI): there's nothing to prompt, so a missing required secret
 * aborts the deploy — returns an error message rather than shipping a worker
 * that will crash on a missing secret. Returns `{}` when the deploy may
 * proceed.
 *
 * Best-effort detection: a dry-run/preview publishes nothing (skip), and if the
 * worker doesn't exist yet (first deploy) or wrangler isn't authenticated the
 * secret list can't be read — we proceed rather than guess. Any pushing happens
 * BEFORE the deploy spawn so the new version boots with the secrets present.
 */
const offerMissingSecrets = async (cwd: string, options: DeployCommandOptions, interactive: boolean, target: string): Promise<MissingSecretsOutcome> => {
    if (options.dryRun === true || options.preview === true) {
        return {};
    }

    const { logger } = options;
    const environmentFlag = options.env === undefined ? "" : ` --env ${options.env}`;

    let remote: ListRemoteSecretsResult;

    try {
        remote = await (options.secretLister ?? listRemoteSecrets)({ cwd, env: options.env, temporary: options.temporary });
    } catch {
        return {};
    }

    // Can't enumerate (no worker yet / not authed) → nothing actionable to check.
    if (!remote.ok) {
        return {};
    }

    const remoteNames = new Set(remote.names);
    const required = await resolveRequiredSecretKeys(cwd);
    const missing = required.filter((key) => !remoteNames.has(key));

    if (missing.length === 0) {
        return {};
    }

    // No TTY to prompt on → fail fast rather than deploy a worker that will crash
    // on a missing required secret.
    if (!interactive) {
        return {
            error:
                `missing required secret(s) on the deploy target: ${missing.join(", ")}. ` +
                `Set them with \`wrangler secret put <KEY>${environmentFlag}\` ` +
                `(or \`lunora env generate --set\` then \`lunora env push --yes${environmentFlag}\`), then re-deploy.`,
        };
    }

    for (const key of missing.filter((name) => !isMintableSecretKey(name))) {
        logger.warn(`required secret ${key} is not set on the target — set it with: wrangler secret put ${key}${environmentFlag}`);
    }

    const mintable = missing.filter((key) => isMintableSecretKey(key));

    if (mintable.length === 0) {
        return {};
    }

    const confirm = options.secretConfirm ?? createTuiConfirm();

    if (
        await confirm(`${String(mintable.length)} required secret(s) not set on the target (${mintable.join(", ")}). Generate strong values and push them now?`)
    ) {
        // `pushMintableSecrets` returns `ok: false` the moment any `secret put`
        // fails (e.g. auth expired mid-push). Discarding that result used to
        // deploy anyway, shipping a worker still missing the secret it just
        // failed to set — the exact outcome the non-interactive branch above
        // refuses to risk.
        const { minted, ok } = await pushMintableSecrets(cwd, options, mintable, target);

        // Persist whatever WAS minted even on a partial failure — a pushed
        // secret this function doesn't record is permanently lost (Cloudflare
        // secrets are write-only), so recording it is not conditional on the
        // rest of the batch succeeding. Its path is threaded into the returned
        // outcome even when `ok` is `false`, so an abort never drops a secret
        // that DID get recorded from the caller's view.
        const mintedSecretsFile = persistMintedSecrets(cwd, options, minted);

        if (!ok) {
            return { error: "failed to push required secret(s) — set them manually and re-deploy", mintedSecretsFile };
        }

        return { mintedSecretsFile };
    }

    logger.warn(
        `${String(mintable.length)} required secret(s) not set on the target: ${mintable.join(", ")}. ` +
            `Generate + push with \`lunora env generate --set\` then \`lunora env push --yes${environmentFlag}\`.`,
    );

    return {};
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

    // The deployed URL is only known AFTER wrangler runs, and this gate runs
    // before it — so there is nothing to default to here, and without an
    // explicit `--migrate-url` the downstream migration would fall back to
    // `http://localhost:8787` (the dev worker) and apply against LOCAL state —
    // and ship the production admin bearer to whatever listens on that port.
    // Refuse before deploying rather than silently targeting localhost later.
    // (A linked checkout satisfies this without the flag: the caller resolves
    // `migrateUrl` through `resolveWorkerUrl`, which reads the link this
    // deploy's predecessor recorded.)
    if (options.migrateUrl === undefined) {
        const message =
            "--migrate requires --migrate-url <https://your-worker> — the deploy target URL is only known after wrangler runs, and this gate runs before it; refusing to default to localhost";

        options.logger.error(message);

        return message;
    }

    if (options.migrateYes !== true) {
        const message = "--migrate runs production data migrations after deploy. Re-run with --migrate-yes to confirm.";

        options.logger.error(message);

        return message;
    }

    const migrateToken = options.migrateToken ?? process.env.LUNORA_ADMIN_TOKEN;

    if (migrateToken === undefined || migrateToken === "") {
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
const runCodegenStep = async (
    cwd: string,
    interactive: boolean,
    logger: Logger,
    apiSpec: ApiSpec | undefined,
    target: string,
    spawner: Spawner | undefined,
    jsonOutput: boolean,
    strictAdvisories: boolean,
): Promise<{ error?: string; result?: CodegenResult }> => {
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

        // Portability diagnostics (`platform_unsupported_feature` /
        // `platform_unknown_target`) mean the emitted `ctx.*` surface does not
        // match what the deploy target can actually serve — always blocking,
        // no opt-out, same as every other codegen caller
        // (`reportPlatformDiagnostics` is shared for exactly this reason).
        const platform = reportPlatformDiagnostics(result.platformDiagnostics, logger);

        if (platform.errors.length > 0) {
            // Every message was already logged above; the returned `error` is the
            // single-string abort reason the deploy result carries.
            return { error: platform.errors.join("; ") };
        }

        // ERROR-level schema advisories ("the call throws at runtime") gate on
        // the same `--no-strict-advisories` opt-out `lunora codegen` uses, so a
        // legitimately-partial target can still ship interactively while CI
        // stays strict by default.
        const { errorAdvisories, names, shouldBlock } = evaluateAdvisoryGate(result.advisories, strictAdvisories);

        if (shouldBlock) {
            const message =
                `${errorAdvisories.length.toString()} ERROR-level ${errorAdvisories.length === 1 ? "advisory" : "advisories"} (${names.join(", ")}). ` +
                `Pass --no-strict-advisories to downgrade this to a warning and deploy anyway.`;

            logger.error(message);

            return { error: message };
        }

        // Codegen ran in-process, not through the project's own `codegen`
        // script. Without this a deploy would ship output the project considers
        // unfinished, and the deploy pipeline has no reason to run that script
        // first, so nothing else would catch it.
        const postCodegen = await runPostCodegenHook({ cwd, logger, spawner, stdoutToStderr: jsonOutput });

        // Already logged by the hook — this only decides that it BLOCKS.
        if (postCodegen.error !== undefined) {
            return { error: postCodegen.error };
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
const checkD1Placeholder = (cwd: string, logger: Logger, command: PreDeployCommand = "deploy", environment?: string): string | undefined => {
    const placeholderBinding = findD1PlaceholderBinding(cwd, environment);

    if (placeholderBinding === undefined) {
        return undefined;
    }

    const message =
        `${command} blocked: the "${placeholderBinding}" D1 binding has a placeholder database_id ` +
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
const checkLocalhostOriginVariables = (cwd: string, logger: Logger, command: PreDeployCommand = "deploy", environment?: string): string | undefined => {
    const variables = readWranglerShape(cwd, environment)?.vars;

    if (!variables) {
        return undefined;
    }

    const offenders = ORIGIN_VAR_NAMES.filter((name) => typeof variables[name] === "string" && isLocalhostUrl(variables[name]));

    if (offenders.length === 0) {
        return undefined;
    }

    const message =
        `${command} blocked: ${offenders.join(", ")} in wrangler.jsonc point at localhost. A deployed Worker can't reach a loopback ` +
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

/** Attempt budget + spacing for `--health-check`: a fresh version takes seconds to propagate, and a predictable ceiling is what a CI timeout is set against. */
const HEALTH_CHECK_ATTEMPTS = 5;
const HEALTH_CHECK_DELAY_MS = 2000;

/**
 * The opt-in `--health-check` step: prove the version just deployed actually
 * answers. Probes the readiness gate first and falls back to the aggregate route
 * (older deployments have no `/ready`), retrying on a bounded budget because a
 * single immediate probe of a still-propagating deploy is a coin flip.
 *
 * Returns `undefined` when the flag wasn't set. The URL comes from the deploy
 * that just ran, falling back to the recorded link for THIS environment; with
 * neither, the step refuses rather than guessing an origin.
 */
const runHealthCheckStep = async (options: DeployCommandOptions, cwd: string, deployedUrl: string | undefined): Promise<DeployCommandResult["healthCheck"]> => {
    if (options.healthCheck !== true) {
        return undefined;
    }

    const baseUrl = deployedUrl ?? resolveWorkerUrl({ cwd, env: options.env });

    if (baseUrl === undefined) {
        const message =
            "--health-check: the deploy succeeded, but no URL to probe could be resolved — wrangler's output carried none and this checkout has no link for this environment. Run `lunora link --url <https://your-worker>` and re-deploy, or drop --health-check.";

        options.logger.error(message);

        return { error: message, ok: false, url: "" };
    }

    const probe = await probeHealth({
        attempts: HEALTH_CHECK_ATTEMPTS,
        baseUrl,
        delayMs: HEALTH_CHECK_DELAY_MS,
        fetchImpl: options.healthFetch,
        // The readiness gate answers "can this version serve"; the aggregate is
        // the one that exists on older deployments.
        paths: [HEALTH_READY_PATH, HEALTH_PATH],
        sleep: options.healthSleep,
    });

    if (probe.error === undefined) {
        options.logger.success(`health check ok (${probe.url})`);

        return { ok: true, url: probe.url };
    }

    // The deploy SUCCEEDED and the probe did not — different facts, and the
    // message has to say which one failed or it reads as a broken deploy.
    options.logger.error(
        `--health-check: the deploy succeeded, but the new version did not answer after ${String(HEALTH_CHECK_ATTEMPTS)} attempt(s) — ${probe.error}`,
    );

    return { error: probe.error, ok: false, url: probe.url };
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
    mintedSecretsFile: string | undefined,
): Promise<DeployCommandResult> => {
    // Before migrations: a data migration may write rows whose vectors are
    // filtered on immediately afterwards.
    await provisionVectorMetadataIndexes(options, cwd);

    const migrateCode = options.migrate ? await runPostDeployMigrations(options, cwd) : 0;

    // Only advance the committed baseline when deploy AND its migrations
    // succeeded; a failed migration leaves the gate measuring against the
    // pre-deploy baseline on the retry.
    if (migrateCode === 0) {
        reblessSchemaBaseline?.();
    }

    return { code: migrateCode, descriptor, mintedSecretsFile, validation };
};

/**
 * The commands that run the pre-deploy pipeline, as the OPERATOR typed them.
 *
 * These checks are reached from `lunora deploy`, `lunora prepare` and
 * `lunora build`, and a blocked run naming a command the operator never ran
 * reads as a bug in the tool rather than a problem in the project.
 *
 * `build` is one of them: it delegates to `runDeployCommand({ dryRun: true })`.
 * The name is threaded through rather than assumed, because the drift gate uses
 * it for two operator-facing decisions — which override flags to offer, and what
 * to call the thing that was blocked. Hardcoding `"deploy"` here meant `lunora
 * build` reported "deploy blocked" for a deploy nobody attempted and recommended
 * a flag `build` rejects with a raw stack trace.
 */
type PreDeployCommand = "build" | "deploy" | "prepare";

/**
 * The read-only half of the pre-deploy gates: the D1-placeholder hard-block, the
 * localhost-origin var check, and the container source + Docker preflights.
 * Returns the first error message, or `undefined` when all pass.
 *
 * Separate from the container BUILD so `lunora prepare` can run the checks
 * without it: building pushes images, which a command whose whole job is "tell me
 * whether this would deploy" must not do. `executeDeploy` runs both.
 */
const runPreDeployChecks = (cwd: string, options: DeployCommandOptions, command: PreDeployCommand): string | undefined => {
    const d1Error = checkD1Placeholder(cwd, options.logger, command, options.env);

    if (d1Error !== undefined) {
        return d1Error;
    }

    const localhostOriginError = checkLocalhostOriginVariables(cwd, options.logger, command, options.env);

    if (localhostOriginError !== undefined) {
        return localhostOriginError;
    }

    const sourceError = checkContainerSourcesExist(cwd, options.logger, command);

    if (sourceError !== undefined) {
        return sourceError;
    }

    return checkContainerDockerPreflight(cwd, options.logger, options.dockerAvailable ?? isDockerAvailable, command, options.env);
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

    // Not every registered driver ships a toolchain — the Node driver has none,
    // because there is no control plane to deploy to. `runDeployCommand` rejects
    // such a target at selection (`resolveRunnableTargetOrError`), so this is the
    // backstop for a direct caller that skipped that path, not the primary guard.
    if (driver.toolchain === undefined) {
        throw new Error(`deploy target "${driver.id}" has no command-line toolchain`);
    }

    return driver.toolchain.deploy(request);
};

/** Failed-deploy result with the empty validation shape shared by every pre-wrangler abort. */
const abortResult = (error: string, extra?: Partial<DeployCommandResult>): DeployCommandResult => {
    return {
        code: 1,
        descriptor: undefined,
        error,
        validation: { problems: [], wranglerPath: undefined },
        ...extra,
    };
};

/**
 * Log wrangler.jsonc validation problems (if any) and report whether the deploy
 * must abort.
 *
 * Warnings are printed too. The validator's unexported-class check is
 * deliberately a warning rather than an error (its scanner fails closed on
 * export forms it does not know, and blocking a working deploy is worse than
 * missing one) — but this command only ever printed `report.errors`, so on the
 * single command that actually ships a Worker the warning was invisible and the
 * user met wrangler's own bundle failure instead. Same for the `unverifiedKeys`
 * env-override notice and the missing-assets-directory warning.
 */
const reportWranglerProblems = (validation: { problems: ReadonlyArray<string>; report?: { warnings: ReadonlyArray<string> } }, logger: Logger): boolean => {
    for (const warning of validation.report?.warnings ?? []) {
        logger.warn(`wrangler.jsonc: ${warning}`);
    }

    if (validation.problems.length === 0) {
        return false;
    }

    logger.error("wrangler.jsonc validation failed:");

    for (const problem of validation.problems) {
        logger.error(`  - ${problem}`);
    }

    return true;
};

/**
 * Assemble the wrangler {@link SpawnDescriptor}, including how its stdout is
 * handled — the one decision that has to be right for `--format json` to stay
 * pipeable:
 *
 * Pretty + publishing uses `captureStdout` (buffered AND teed, so the URL can be
 * read while the user still watches live progress). Json + publishing uses
 * `captureStdoutSilently` (buffered, never teed — the caller replays it to
 * stderr), because `captureStdout` there would interleave with the single JSON
 * document on stdout and corrupt it. A dry run has nothing to read, so its
 * stdout is left alone (mapped to stderr in json mode).
 */
const buildDeploySpawn = (cwd: string, options: DeployCommandOptions, target: string): SpawnDescriptor => {
    const jsonFormat = isJsonFormat(options.format);
    // Read the deployed URL off wrangler's stdout on EVERY publishing run — a
    // preview and a `--format json` deploy need to report where the thing went
    // just as much as a first pretty deploy does, and a re-deploy is how a
    // CHANGED url gets noticed.
    const publishes = options.dryRun !== true;

    const deployCommand = buildDeployCommand(cwd, options, target);
    const exec = execArgsFor(detectPackageManager(cwd), deployCommand.tool, deployCommand.args);

    return {
        args: exec.args,
        captureStdout: publishes && !jsonFormat,
        captureStdoutSilently: publishes && jsonFormat,
        command: exec.command,
        cwd,
        stdoutToStderr: jsonFormat && !publishes,
    };
};

interface CompleteDeployInputs {
    cwd: string;
    descriptor: SpawnDescriptor;
    mintedSecretsFile: string | undefined;
    options: DeployCommandOptions;
    reblessSchemaBaseline: (() => void) | undefined;
    /** Wrangler's captured stdout, or `undefined` when this run didn't capture it. */
    stdout: string | undefined;
    validation: DeployCommandResult["validation"];
}

/**
 * Everything that happens once `wrangler` has exited 0: name what was deployed,
 * record the link, prove the new version answers, then finalize (migrations +
 * baseline re-bless). Extracted from {@link executeDeploy} to keep both
 * functions' cognitive complexity within the 15-node budget.
 */
const completeDeploy = async ({
    cwd,
    descriptor,
    mintedSecretsFile,
    options,
    reblessSchemaBaseline,
    stdout,
    validation,
}: CompleteDeployInputs): Promise<DeployCommandResult> => {
    // A dry run publishes nothing, so it reports no URL — the discriminators say
    // so explicitly rather than leaving a consumer to infer it from the absence.
    const deployment: DeployedIdentity = {
        deployedAt: new Date().toISOString(),
        dryRun: options.dryRun === true,
        env: options.env,
        preview: options.preview === true,
        url: options.dryRun === true ? undefined : parseDeployedUrl(stdout),
        workerName: readWranglerName(cwd),
    };

    // A dry run published nothing, and a preview uploaded a Version without
    // going live — either way, skip the post-deploy finalize (migrations /
    // baseline re-bless), the link write, and the health probe, which only apply
    // to a live deploy. The URL is still reported.
    if (options.dryRun === true || options.preview === true) {
        if (options.healthCheck === true) {
            options.logger.warn(
                `--health-check skipped: ${options.dryRun === true ? "a dry run publishes nothing" : "a preview version serves no live traffic"}`,
            );
        }

        return { code: 0, deployment, descriptor, mintedSecretsFile, validation };
    }

    // Zero-effort linking: record the deployed URL, warn instead of clobbering
    // when an existing link disagrees. Skipped for `--temporary`: that account
    // is deleted in ~60 minutes, so its URL must never become the checkout's
    // recorded target.
    if (options.temporary !== true) {
        autoLinkFromDeployOutput({ cwd, env: options.env, logger: options.logger, url: deployment.url });
    }

    // Prove the new version answers BEFORE running migrations against it — a
    // worker that can't serve is not one to migrate.
    const healthCheck = await runHealthCheckStep(options, cwd, deployment.url);

    if (healthCheck?.error !== undefined) {
        return { code: 1, deployment, descriptor, healthCheck, mintedSecretsFile, validation };
    }

    const finalized = await finalizeSuccessfulDeploy(options, cwd, descriptor, validation, reblessSchemaBaseline, mintedSecretsFile);

    return { ...finalized, deployment, healthCheck };
};

/**
 * Everything both `lunora prepare` and `lunora deploy` must do before anything
 * ships: resolve the target, run codegen (with its post-hook, platform
 * diagnostics and ERROR-advisory gate), gate on schema drift, provision the
 * bindings the code implies, run the read-only pre-deploy checks, and validate
 * the resulting wrangler config.
 *
 * Shared because it was written twice. `prepare` had its own copy of the same
 * five steps and the two had already drifted in the direction that matters: only
 * deploy gated on ERROR-level advisories, so a CI job could run `lunora prepare`,
 * go green, and still be rejected by the deploy it was meant to pre-check. They
 * also provisioned differently — deploy reconciled inline, prepare went through
 * `DeployDriver.provision` — so "prepare then deploy" could reconcile twice by
 * two routes.
 *
 * Not identical in every respect: `prepare` takes no `--env`, so it always sees
 * the top-level config view while `deploy --env <name>` sees the environment's
 * own (non-inheritable) `vars` / `d1_databases` / `containers`. A green
 * `prepare` therefore does not prove a `deploy --env <name>` will pass.
 *
 * Stops before the container BUILD and the wrangler invocation, which is exactly
 * the line between the two commands: `prepare` answers "would this deploy?"
 * without pushing an image or a bundle.
 */
const runPreDeployPipeline = async (
    options: DeployCommandOptions,
    command: PreDeployCommand,
): Promise<{
    codegen?: CodegenResult;
    error?: string;
    reblessSchemaBaseline?: () => void;
    schemaDrift?: { blocked: boolean; reason: string };
    target?: string;
    validation: DeployCommandResult["validation"];
}> => {
    const cwd = options.cwd ?? process.cwd();
    const interactive = isInteractive(options);
    const strictAdvisories = resolveStrictAdvisories(options);
    const empty = { problems: [], wranglerPath: undefined };

    // Resolved ONCE, and before anything writes. This rewrites `_generated/*`
    // and may mutate `wrangler.jsonc` well before the wrangler step, so
    // validating at the point of driver use would leave those side effects behind
    // on an unknown target. Resolving here also means `lunora.json`'s `target`
    // reaches the driver, not just the `--target` flag.
    //
    // The `Runnable` form additionally rejects a registered-but-undeployable
    // target (a driver with no toolchain). That has to happen here rather than at
    // the wrangler step: codegen below tailors the whole `ctx.*` surface to the
    // target's capability matrix, and failing after that leaves the app rewritten
    // for a target it then refuses to ship.
    const resolvedTarget = resolveRunnableTargetOrError(cwd, options.target);

    if (resolvedTarget.target === undefined) {
        const message = resolvedTarget.error ?? "unknown deploy target";

        // Logged here, not just returned: the caller only prints `error` in
        // `--format json` mode, so a bare return exits 1 in silence.
        options.logger.error(message);

        return { error: message, validation: empty };
    }

    const { target } = resolvedTarget;

    let codegen: CodegenResult | undefined;

    if (!options.skipCodegen) {
        const codegenStep = await runCodegenStep(
            cwd,
            interactive,
            options.logger,
            options.apiSpec,
            target,
            options.spawner,
            isJsonFormat(options.format),
            strictAdvisories,
        );

        if (codegenStep.error !== undefined) {
            return { error: codegenStep.error, target, validation: empty };
        }

        codegen = codegenStep.result;
    }

    let reblessSchemaBaseline: (() => void) | undefined;

    if (codegen !== undefined) {
        const gate = runSchemaDriftGate({
            allowDrift: options.allowSchemaDrift === true,
            codegen,
            command,
            logger: options.logger,
            updateBaseline: options.updateSchemaBaseline === true,
        });

        if (gate.blocked) {
            return {
                error: `schema drift gate blocked ${command}`,
                schemaDrift: { blocked: true, reason: gate.reason },
                target,
                validation: empty,
            };
        }

        reblessSchemaBaseline = gate.rebless;
    }

    // Provisioning WRITES `wrangler.jsonc`. On a dry run those writes are rolled
    // back — but not here: the caller owns that window, because the artifacts
    // that have to read the provisioned config (the wrangler bundle, and
    // `build --emit-bindings`'s requirements document) are produced after this
    // function returns. Restoring here derived both from the reverted config, so
    // `build --emit-bindings` handed a deployer `"crons": []` for an app with a
    // nightly cron. See `snapshotWranglerConfig`.
    await provisionBindings(cwd, options.logger, codegen?.cronTriggers, target, options.env);

    const checkError = runPreDeployChecks(cwd, options, command);

    if (checkError !== undefined) {
        return { error: checkError, target, validation: empty };
    }

    // `--env <name>` validates the env-scoped view — a binding present only at
    // the top level is a real gap for that environment (non-inheritable; see
    // wrangler-validator.ts's NON_INHERITABLE_KEYS).
    const validation = validateWrangler({ environment: options.env, projectRoot: cwd });

    if (reportWranglerProblems(validation, options.logger)) {
        return { error: "wrangler validation failed", target, validation };
    }

    return { codegen, reblessSchemaBaseline, target, validation };
};

const executeDeploy = async (options: DeployCommandOptions): Promise<DeployCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const interactive = isInteractive(options);

    const pipeline = await runPreDeployPipeline(options, options.commandName ?? "deploy");

    if (pipeline.error !== undefined) {
        // A validation failure carries its problem list; every earlier abort
        // shares the empty-validation shape, optionally with the drift verdict.
        if (pipeline.validation.problems.length > 0) {
            return { code: 1, descriptor: undefined, error: pipeline.error, validation: pipeline.validation };
        }

        const extra = pipeline.schemaDrift === undefined ? undefined : { schemaDrift: pipeline.schemaDrift };

        return abortResult(pipeline.error, extra);
    }

    const { reblessSchemaBaseline, validation } = pipeline;
    const target = pipeline.target as string;

    const migratePreflightError = validateMigrateDeployPreflight(options);

    if (migratePreflightError !== undefined) {
        return abortResult(migratePreflightError);
    }

    // The build half of the pre-deploy gates. The read-only checks already ran in
    // the shared pipeline; this pushes container images, so it no-ops on a dry
    // run (enforced inside `buildContainerImages`).
    const buildError = await buildContainerImages(cwd, options);

    if (buildError !== undefined) {
        return abortResult(buildError);
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
    const { error: secretAbort, mintedSecretsFile } = await offerMissingSecrets(cwd, options, interactive, target);

    if (secretAbort !== undefined) {
        options.logger.error(secretAbort);

        // `mintedSecretsFile` may be set here too — a secret can be recorded
        // and STILL abort (e.g. the second of two mintable keys failed to
        // push) — carry it through so the caller's `error` path doesn't drop
        // the one place that value is now recoverable.
        return { code: 1, descriptor: undefined, error: secretAbort, mintedSecretsFile, validation };
    }

    const descriptor = buildDeploySpawn(cwd, options, target);

    options.logger.info(`deploying via ${descriptor.command} ${descriptor.args.join(" ")}`);

    const spawner = options.spawner ?? defaultSpawner;
    const result = await spawner(descriptor);

    // Replay what was captured silently, so `--format json` still shows the
    // deploy output the operator reads in a CI log — on stderr, where it can't
    // touch the document on stdout.
    if (descriptor.captureStdoutSilently === true && result.stdout !== undefined && result.stdout !== "") {
        process.stderr.write(result.stdout);
    }

    if (result.code !== 0) {
        return { code: result.code, descriptor, mintedSecretsFile, validation };
    }

    return completeDeploy({ cwd, descriptor, mintedSecretsFile, options, reblessSchemaBaseline, stdout: result.stdout, validation });
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

        return abortResult(formatError);
    }

    // The dry-run rollback for `deploy --dry-run`: provisioning's writes stay on
    // disk until every artifact that has to describe them has been derived, then
    // the committed config goes back exactly as it was. Both artifacts are
    // produced inside this one window — the wrangler bundle by `executeDeploy`,
    // and `--emit-bindings`'s requirements document right after it — so nothing
    // else needs to own a snapshot.
    const logger = loggerForFormat(options.format, options.logger);
    const restoreWrangler = options.dryRun === true ? snapshotWranglerConfig(options.cwd ?? process.cwd()) : undefined;

    let result: DeployCommandResult;

    try {
        result = await executeDeploy({ ...options, logger });

        if (result.code === 0 && options.emitBindings !== undefined) {
            const { error } = writeBindingManifestFile({ destination: options.emitBindings, logger, projectRoot: options.cwd ?? process.cwd() });

            if (error !== undefined) {
                logger.error(error);

                result = { ...result, code: 1 };
            }
        }
    } finally {
        restoreWrangler?.();
    }

    if (isJsonFormat(options.format)) {
        printJson(result);

        return result;
    }

    // Vercel-style summary block after a successful real deploy. Skipped on
    // failure, on dry runs, and on previews (nothing went live; wrangler already
    // printed the preview URL), and never in json mode (the early return above)
    // where it would corrupt the document on stdout.
    if (result.code === 0 && options.dryRun !== true && options.preview !== true) {
        renderDeploySummary({
            cwd: options.cwd ?? process.cwd(),
            env: options.env,
            logger: options.logger,
            mintedSecretsFile: result.mintedSecretsFile,
            // From the deploy that just ran, not the link file — the link can be
            // stale (or absent on a first deploy), and this run knows the truth.
            url: result.deployment?.url,
        });
    } else if (result.code === 0 && options.preview === true) {
        const previewUrl = result.deployment?.url;

        options.logger.success(previewUrl === undefined ? "preview version uploaded" : `preview version uploaded — ${previewUrl}`);
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
        healthCheck: options.healthCheck === true,
        logger,
        migrate: options.migrate === true,
        migrateToken: options.migrateToken,
        // Fall back to the `.lunora/project.json` link so a linked checkout no
        // longer needs --migrate-url repeated on every `deploy --migrate`. The
        // link is only trusted when it was recorded for THIS `--env` — a
        // production-linked checkout must not silently supply its URL to a
        // `--env staging --migrate` run (see resolveWorkerUrl's env guard).
        migrateUrl: resolveWorkerUrl({ cwd, env: options.env, url: options.migrateUrl }),
        migrateYes: options.migrateYes === true,
        preview: options.preview === true,
        // `--prebuilt` trusts a prior `lunora build`/`prepare`: skip codegen (and
        // thus the drift gate, which has no fresh snapshot to measure).
        skipCodegen: options.prebuilt === true,
        strictAdvisories: options.strictAdvisories,
        target: options.target,
        temporary: options.temporary === true,
        updateSchemaBaseline: options.updateSchemaBaseline === true,
    });

    return { code: result.code };
});

export { execute };
export type { DeployCommandOptions, DeployCommandResult, DeployedIdentity };
// `provisionBindings` is shared with `lunora dev`'s wrangler flavor, which has
// no `@lunora/vite` to reconcile bindings for it on startup.
export { provisionBindings, runDeployCommand, runPreDeployPipeline };
