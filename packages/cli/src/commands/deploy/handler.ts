import type { CodegenResult } from "@lunora/codegen";
import { runCodegen } from "@lunora/codegen";
import type { DeployDriver, DeployRequest, ToolchainCommand } from "@lunora/config";
import { discoverContainerInfo, inferLunoraBindings, planToolchainInvocation, resolveDeployDriver } from "@lunora/config";
import { describePreservedCrons, reconcileWranglerBindings, reconcileWranglerCompatibilityDate, reconcileWranglerCrons } from "@lunora/config/cloudflare";
import { Spinner } from "@visulima/spinner";

import { evaluateAdvisoryGate, resolveStrictAdvisories } from "../../util/advisory-gate";
import type { ApiSpec } from "../../util/api-spec";
import { parseApiSpec } from "../../util/api-spec";
import { writeBindingManifestFile } from "../../util/binding-manifest-file";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { renderDeploySummary } from "../../util/deploy-summary";
import { resolveRunnableTargetOrError } from "../../util/deploy-target";
import { detectPackageManager, toolchainExecArgs } from "../../util/detect-package-manager";
import type { ExitCode } from "../../util/exit-code";
import { EXIT_CODE } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import reportPlatformDiagnostics from "../../util/platform-diagnostics";
import { runPostCodegenHook } from "../../util/post-codegen-hook";
import { buildRailpackImages } from "../../util/railpack";
import { resolveWorkerUrl } from "../../util/resolve-target";
import { runSchemaDriftGate } from "../../util/schema-drift-gate";
import type { SpawnDescriptor, Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import snapshotWranglerConfig from "../../util/wrangler-snapshot";
import { validateWrangler } from "../../util/wrangler-validator";
import type { PreDeployCommand } from "./checks";
import { resolveComposedWorkerEntry, runPreDeployChecks, validateMigrateDeployPreflight } from "./checks";
import type { DeployOptions } from "./index";
import completeDeploy from "./post-deploy";
import { offerMissingSecrets, warnDevVariablesNotPushed } from "./secrets";
import type { DeployCommandData, DeployCommandOptions, DeployCommandResult } from "./types";

const isInteractive = (options: DeployCommandOptions): boolean => {
    // `--format json` owns stdout for the JSON document — interactive spinners
    // would corrupt it, so json mode is always non-interactive.
    if (options.format === "json") {
        return false;
    }

    if (options.interactive !== undefined) {
        return options.interactive;
    }

    return process.stdout.isTTY && !process.env.CI;
};

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

        // A damaged `lunora.crons` ownership record degrades reconciliation to
        // add-only, which is safe but invisible — see `ReconcileCronsResult`.
        for (const warning of reconciled.warnings) {
            logger.warn(warning);
        }

        // The array is not the codegen-derived set. Say so — a `backupCron`
        // entry that quietly stopped being delivered is exactly the failure the
        // preservation exists to prevent, and silence is how it went unnoticed.
        const kept = describePreservedCrons(reconciled.preserved);

        if (kept !== undefined) {
            logger.info(kept);
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

        const writtenTo = reconciled.wranglerPath ?? "wrangler.jsonc";

        if (reconciled.added.length > 0) {
            logger.success(`provisioned bindings: ${reconciled.added.join(", ")} → ${writtenTo}`);
        }

        if (reconciled.updated.length > 0) {
            logger.success(`updated bindings: ${reconciled.updated.join(", ")} → ${writtenTo}`);
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
                // Command-neutral: this pipeline is reached from `deploy`, `prepare`
                // AND `build`, and all three now register the flag it names.
                `Pass --no-strict-advisories to downgrade this to a warning and continue.`;

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
 * The neutral deploy request these options describe. The projection's
 * `configPath` is added when the command is planned
 * ({@link planToolchainInvocation}).
 */
const deployRequestFor = (cwd: string, options: DeployCommandOptions): DeployRequest => {
    return {
        dryRun: options.dryRun,
        // Class-B composition: bundle the `src/worker.ts` wrapper (which the
        // framework's CF adapter can't clobber) instead of the adapter-owned `main`.
        entry: resolveComposedWorkerEntry(cwd),
        environment: options.env,
        outDir: options.outDir,
        preview: options.preview,
        temporary: options.temporary,
    };
};

/**
 * Plan the target's deploy command without writing anything. The argv builder
 * is where a host refuses an option it has no equivalent for (celld has no
 * `--env`, `--preview`, …), so the pre-deploy pipeline plans once up front — a
 * refusal then stops the deploy before codegen or provisioning has touched a
 * file — and {@link buildDeployCommand} plans again, against the provisioned
 * config, to run it.
 */
const planDeploy = (cwd: string, options: DeployCommandOptions, driver: DeployDriver): ReturnType<typeof planToolchainInvocation> => {
    const { toolchain } = driver;

    // `resolveRunnableTargetOrError` rejects a toolchain-less target (Node) at
    // selection; this is the backstop for a direct caller that skipped it.
    if (toolchain === undefined) {
        throw new Error(`deploy target "${driver.id}" has no command-line toolchain`);
    }

    const request = deployRequestFor(cwd, options);

    return planToolchainInvocation(driver, cwd, "deploy", (configPath) => toolchain.deploy({ ...request, configPath }));
};

/**
 * Assemble the target's deploy argv (the package-manager launcher is prepended
 * by the caller via {@link toolchainExecArgs}), write the config projection it
 * reads, and say what that projection left out.
 */
const buildDeployCommand = (cwd: string, options: DeployCommandOptions, driver: DeployDriver): ToolchainCommand => {
    const invocation = planDeploy(cwd, options, driver);
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

    invocation.commit();

    // Those keys configure nothing on that host, and an operator reading the
    // Cloudflare config should not assume otherwise.
    if (invocation.projection !== undefined && invocation.projection.dropped.length > 0) {
        options.logger.warn(
            `${driver.name} ignores these wrangler keys, so they were left out of ${invocation.projection.configPath}: ${invocation.projection.dropped.join(", ")}`,
        );
    }

    return invocation.command;
};

/**
 * Failed-deploy result with the empty validation shape shared by every
 * pre-wrangler abort. Exit 2 by default: everything that aborts before wrangler
 * runs — the pipeline, the `--migrate` preflight, the entry build — refuses
 * because the project or the invocation is wrong, never because the deploy
 * itself failed. A check that resolved a different bucket passes `code`.
 */
const abortResult = (error: string, extra?: Partial<DeployCommandResult>): DeployCommandResult => {
    return {
        code: EXIT_CODE.USAGE,
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
 * Warnings are printed too, not just `report.errors`. This command is the one
 * that actually ships a Worker, so a warning it swallows is one the user meets
 * as a wrangler failure instead — which is what happened while the
 * unexported-class check was warning-level (it blocks now), and still applies to
 * the `unverifiedKeys` env-override notice and the missing-assets-directory
 * warning.
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
const buildDeploySpawn = (cwd: string, options: DeployCommandOptions, driver: DeployDriver): SpawnDescriptor => {
    const jsonFormat = options.format === "json";
    // Read the deployed URL off wrangler's stdout on EVERY publishing run — a
    // preview and a `--format json` deploy need to report where the thing went
    // just as much as a first pretty deploy does, and a re-deploy is how a
    // CHANGED url gets noticed.
    const publishes = options.dryRun !== true;

    const deployCommand = buildDeployCommand(cwd, options, driver);
    const exec = toolchainExecArgs(detectPackageManager(cwd), deployCommand);

    return {
        args: exec.args,
        captureStdout: publishes && !jsonFormat,
        captureStdoutSilently: publishes && jsonFormat,
        command: exec.command,
        cwd,
        stdoutToStderr: jsonFormat && !publishes,
    };
};

/**
 * {@link runPreDeployPipeline}'s outcome. Split on `error` so a passing run
 * always carries its resolved `target` — the caller must never fall back to
 * `resolveDeployDriver`'s default (Cloudflare) for a target it did not resolve.
 */
type PreDeployPipelineResult =
    | {
          /** Set when a check resolved its own exit code — otherwise the caller's default applies. */
          code?: ExitCode;
          error: string;
          schemaDrift?: { blocked: boolean; reason: string };
          target?: string;
          validation: DeployCommandResult["validation"];
      }
    | {
          codegen?: CodegenResult;
          error?: never;
          reblessSchemaBaseline?: () => void;
          target: string;
          validation: DeployCommandResult["validation"];
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
const runPreDeployPipeline = async (options: DeployCommandOptions, command: PreDeployCommand): Promise<PreDeployPipelineResult> => {
    const cwd = options.cwd ?? process.cwd();
    const interactive = isInteractive(options);
    const strictAdvisories = resolveStrictAdvisories(options);
    const empty = { problems: [], wranglerPath: undefined };

    // Resolved ONCE, and before anything writes. This rewrites `_generated/*`
    // and may mutate `wrangler.jsonc` well before the wrangler step, so
    // validating at the point of driver use would leave those side effects behind
    // on an unknown target. Resolving here also means `lunora.config.*`'s `target`
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

    // An option the target refuses (celld has no `--env`, `--preview`, …) has to
    // stop the deploy HERE, before codegen rewrites `_generated/*` and
    // provisioning writes `wrangler.jsonc` — not at the deploy step, after both.
    try {
        planDeploy(cwd, options, resolveDeployDriver(target));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        options.logger.error(message);

        return { error: message, target, validation: empty };
    }

    let codegen: CodegenResult | undefined;

    if (!options.skipCodegen) {
        const codegenStep = await runCodegenStep(
            cwd,
            interactive,
            options.logger,
            options.apiSpec,
            target,
            options.spawner,
            options.format === "json",
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
        return { code: checkError.code, error: checkError.error, target, validation: empty };
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
            return { code: EXIT_CODE.USAGE, descriptor: undefined, error: pipeline.error, validation: pipeline.validation };
        }

        const extra = pipeline.schemaDrift === undefined ? undefined : { schemaDrift: pipeline.schemaDrift };

        return abortResult(pipeline.error, { ...extra, ...(pipeline.code === undefined ? {} : { code: pipeline.code }) });
    }

    const { reblessSchemaBaseline, validation } = pipeline;
    const driver = resolveDeployDriver(pipeline.target);

    const migratePreflightError = validateMigrateDeployPreflight(options);

    if (migratePreflightError !== undefined) {
        return abortResult(migratePreflightError);
    }

    // The build half of the pre-deploy gates. The read-only checks already ran in
    // the shared pipeline; this pushes container images, so it no-ops on a dry
    // run (enforced inside `buildContainerImages`).
    // railpack builds and pushes to the Cloudflare registry; celld builds each
    // container from its Dockerfile itself during `celld deploy`.
    const buildError = driver.toolchain?.prebuildsContainerImages === true ? await buildContainerImages(cwd, options) : undefined;

    if (buildError !== undefined) {
        return abortResult(buildError);
    }

    // Non-blocking secret-drift reminder: `wrangler deploy` never pushes
    // `.dev.vars` values, so an edited `.dev.vars` would otherwise leave the
    // deployed worker with stale/missing secrets silently (Supabase #45242).
    warnDevVariablesNotPushed(cwd, options.logger, driver);

    // Detect required secrets not yet set on the target. Interactive: offer to
    // generate + push the mintable ones (provider keys flagged to set by hand).
    // Non-interactive (CI): a missing required secret aborts rather than shipping
    // a worker that will crash. Best-effort detection — skips dry-run/preview and
    // stays quiet when the worker can't be queried yet (first deploy / not authed).
    const { error: secretAbort, mintedSecretsFile } = await offerMissingSecrets(cwd, options, interactive, driver);

    if (secretAbort !== undefined) {
        options.logger.error(secretAbort);

        // `mintedSecretsFile` may be set here too — a secret can be recorded
        // and STILL abort (e.g. the second of two mintable keys failed to
        // push) — carry it through so the caller's `error` path doesn't drop
        // the one place that value is now recoverable.
        return { code: EXIT_CODE.USAGE, descriptor: undefined, error: secretAbort, mintedSecretsFile, validation };
    }

    const descriptor = buildDeploySpawn(cwd, options, driver);

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

    const completed = await completeDeploy({ cwd, descriptor, mintedSecretsFile, options, reblessSchemaBaseline, stdout: result.stdout, validation });

    return { ...completed, logsAvailable: driver.toolchain?.tail !== undefined };
};

/**
 * Run a deploy. In `--format json` mode the human/progress channel is already on
 * stderr (`defineHandler` routed it) and the Vercel-style summary is skipped, so
 * stdout is left to the single result document `execute` returns.
 */
const runDeployCommand = async (options: DeployCommandOptions): Promise<DeployCommandResult> => {
    // The dry-run rollback for `deploy --dry-run`: provisioning's writes stay on
    // disk until every artifact that has to describe them has been derived, then
    // the committed config goes back exactly as it was. Both artifacts are
    // produced inside this one window — the wrangler bundle by `executeDeploy`,
    // and `--emit-bindings`'s requirements document right after it — so nothing
    // else needs to own a snapshot.
    const { logger } = options;
    const restoreWrangler = options.dryRun === true ? snapshotWranglerConfig(options.cwd ?? process.cwd()) : undefined;

    let result: DeployCommandResult;

    try {
        result = await executeDeploy({ ...options, logger });

        if (result.code === 0 && options.emitBindings !== undefined) {
            const { error } = writeBindingManifestFile({ destination: options.emitBindings, logger, projectRoot: options.cwd ?? process.cwd() });

            if (error !== undefined) {
                logger.error(error);

                result = { ...result, code: EXIT_CODE.USAGE };
            }
        }
    } finally {
        restoreWrangler?.();
    }

    if (options.format === "json") {
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
            logsAvailable: result.logsAvailable === true,
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
const execute: CommandHandler<DeployOptions> = defineHandler<DeployOptions, DeployCommandData>(async ({ cwd, format, logger, options }) => {
    const result = await runDeployCommand({
        allowSchemaDrift: options.allowSchemaDrift === true,
        apiSpec: parseApiSpec(options.apiSpec),
        cwd,
        dryRun: options.dryRun === true,
        env: options.env,
        format,
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

    return {
        code: result.code,
        data: {
            deployment: result.deployment,
            healthCheck: result.healthCheck,
            mintedSecretsFile: result.mintedSecretsFile,
            schemaDrift: result.schemaDrift,
            validation: result.validation,
        },
        error: result.error,
    };
});

export { execute };
// `provisionBindings` is shared with `lunora dev`'s wrangler flavor, which has
// no `@lunora/vite` to reconcile bindings for it on startup.
export { provisionBindings, runDeployCommand, runPreDeployPipeline };
