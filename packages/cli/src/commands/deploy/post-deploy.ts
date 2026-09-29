/**
 * What runs after the host CLI shipped: `--migrate` data migrations, Vectorize
 * metadata indexes, the health check, and the finalize that links the URL and
 * re-blesses the schema baseline.
 */
import { discoverMigrations } from "@lunora/codegen";
import { discoverSchemaInfo } from "@lunora/config";
import { join } from "@visulima/path";
import { Project } from "ts-morph";

import { autoLinkFromDeployOutput, parseDeployedUrl } from "../../util/auto-link";
import { detectPackageManager, execArgsFor } from "../../util/detect-package-manager";
import { EXIT_CODE } from "../../util/exit-code";
import { HEALTH_PATH, HEALTH_READY_PATH, probeHealth } from "../../util/health-probe";
import { resolveWorkerUrl } from "../../util/resolve-target";
import type { SpawnDescriptor } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import type { VectorMetadataIndex } from "../../util/vectorize-metadata";
import { ensureVectorMetadataIndexes, metadataTypeFor } from "../../util/vectorize-metadata";
import readWranglerName from "../../util/wrangler-name";
import type { MigrateDataCommandOptions } from "../migrate/handler";
import { runMigrateDataCommand } from "../migrate/handler";
import type { DeployCommandOptions, DeployCommandResult, DeployedIdentity } from "./types";

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
 * baseline re-bless). Split from the deploy handler's `executeDeploy` to keep
 * both functions' cognitive complexity within the 15-node budget.
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
        return { code: EXIT_CODE.UNAVAILABLE, deployment, descriptor, healthCheck, mintedSecretsFile, validation };
    }

    const finalized = await finalizeSuccessfulDeploy(options, cwd, descriptor, validation, reblessSchemaBaseline, mintedSecretsFile);

    return { ...finalized, deployment, healthCheck };
};

export default completeDeploy;
