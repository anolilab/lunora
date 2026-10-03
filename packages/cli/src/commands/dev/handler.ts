import { runCodegen } from "@lunora/codegen";
import type { ContainerLogStreamHandle } from "@lunora/config";
import {
    AGENT_RULES_HINT,
    claimAgentRulesHint,
    claimDevServerState,
    clearDevServerState,
    detectAgentRules,
    detectAiAgent,
    DEV_BINDINGS_FILE,
    DEV_DAEMON_ENV,
    DEV_HANDOFF_ENV,
    DEV_LOG_FILE_ENV,
    DEV_STATE_FILE,
    DEV_VARS_EXAMPLE_FILE,
    DEV_VARS_FILE,
    ensureDevVariables,
    ensureDevVarsExample,
    fillDevSecrets,
    inferLunoraBindings,
    isInteractive,
    packageNamesFromBindings,
    readLiveDevServerState,
    readProjectRemotePreference,
    updateDevServerState,
} from "@lunora/config";
import { resolveRemoteEnabled } from "@lunora/config/cloudflare";

import { parseApiSpec } from "../../util/api-spec";
import { writeBindingManifestFile } from "../../util/binding-manifest-file";
import { startCodegenWatch } from "../../util/codegen-watch";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { resolveRunnableTargetOrError } from "../../util/deploy-target";
import { EXIT_CODE } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import { forceJsonLogging } from "../../util/logger";
import type { StudioServerHandle } from "../../util/studio-server";
import { startStudioServer } from "../../util/studio-server";
import { createTuiConfirm } from "../../util/tui-prompts";
import markWorkerReadyWhenServing from "../../util/worker-ready";
import { provisionBindings } from "../deploy/handler";
import type { DevOptions } from "./index";
import { codegenRequested, detectDevFlavor, reportExistingServer, runLifecycleSubcommand, startBackground } from "./lifecycle";
import { resolveTargetFlavor, startCelldWorker } from "./own-dev-server";
import { buildDevPlan } from "./plan";
import type { Teardown } from "./supervise";
import { defaultWorkerSpawner, startContainerLogStreaming, superviseWorkers, teardown, waitForInterrupt } from "./supervise";
import { normalizeAllowMail, printPublicWarning, startTunnelForPlan } from "./tunnel";
import type { DevCommandOptions, DevCommandPlan, DevTunnelRequest, WorkerProcess, WorkerSpawner } from "./types";

/** Print the Convex-style startup banner once the studio + worker URLs are known. */
const printBanner = (logger: Logger, plan: DevCommandPlan, studioUrl: string | undefined, manifestPath: string | undefined): void => {
    logger.info("");
    logger.success("Lunora dev");
    logger.info(`  ➜  Worker:     ${plan.workerOrigin}`);

    if (studioUrl !== undefined) {
        // Five spaces, like every other row: this one had two, so the value
        // column stepped left for exactly one line.
        logger.info(`  ➜  Studio:     ${studioUrl}`);
    }

    if (plan.runsCodegenWatch) {
        logger.info("  ➜  Codegen:    watching lunora/");
    }

    // The two files a task runner reads. The manifest is written whether or not
    // anyone asked, which is the point — but a file nobody knows about helps
    // nobody, and the flag it replaced had to be discovered before it could help.
    // One line, once, is the difference between "defaulted on" and "adopted".
    //
    // Only when one was actually written: a project with no wrangler config skips
    // the manifest, and pointing at a path that does not exist is worse than
    // saying nothing.
    if (manifestPath !== undefined) {
        logger.info(`  ➜  Supervisor: ${manifestPath} (needs) · ${DEV_STATE_FILE} (status)`);
    }

    if (plan.remote.enabled) {
        if (plan.remote.bindings.length > 0) {
            logger.info(`  ➜  Remote:     ${plan.remote.bindings.join(", ")} → deployed worker`);
        } else {
            logger.warn(`  ➜  Remote:     requested but inactive (${plan.remote.reason ?? "no eligible bindings"}) — running fully local`);
        }
    }

    logger.info("");
};

/**
 * When the Lunora agent skills ("rules") aren't installed in the project, nudge
 * the developer (and any cloud/headless coding agent reading stdout) to install
 * them so the AI knows how to use Lunora. Non-blocking — just one info line.
 */
const printAgentRulesHint = (logger: Logger, cwd: string): void => {
    if (detectAgentRules(cwd).installed || !claimAgentRulesHint()) {
        return;
    }

    logger.info(`  ⓘ  ${AGENT_RULES_HINT}`);
    logger.info("");
};

/**
 * Offer to scaffold `.dev.vars` before the worker starts — otherwise it throws
 * on the first required secret (e.g. `AUTH_SECRET is required`). Non-interactive
 * runs (CI) decline silently rather than block on a prompt, but we log an
 * actionable hint so the user knows how to set up their secrets.
 *
 * Phase 1 (package-aware): infer which `@lunora/*` packages the project imports,
 * then ensure `.dev.vars.example` contains placeholder entries for every secret
 * those packages require. This is idempotent — existing entries are never
 * overwritten or duplicated.
 *
 * Phase 2 (existing flow): offer to generate (or top up) `.dev.vars` from the
 * now-complete `.dev.vars.example`, then log the non-interactive hint if declined.
 */
const offerDevVariablesScaffold = async (options: DevCommandOptions, cwd: string): Promise<void> => {
    // Phase 1 — seed .dev.vars.example with any package-required secrets that
    // are not already listed there. Best-effort: a scan failure is non-fatal.
    try {
        const bindings = await inferLunoraBindings({ projectRoot: cwd });
        const packageNames = packageNamesFromBindings(bindings);
        const addedKeys = (options.ensureExample ?? ensureDevVarsExample)(cwd, packageNames);

        if (addedKeys.length > 0) {
            options.logger.info(`Updated .dev.vars.example with secrets for: ${packageNames.join(", ")} (${addedKeys.join(", ")})`);
        }
    } catch {
        // Non-fatal — scanning may fail in unusual project layouts.
    }

    // Phase 2 — offer to generate / top up .dev.vars from the example.
    const result = await (options.ensureEnv ?? ensureDevVariables)({
        confirm: createTuiConfirm(),
        cwd,
        info: (message) => {
            options.logger.info(message);
        },
    });

    // In CI / non-TTY contexts the scaffolder declines silently. Emit an
    // actionable hint so engineers know how to get their secrets in place —
    // otherwise the next failure is a cryptic runtime error from inside the
    // worker (e.g. `AUTH_SECRET is required`), not a setup prompt.
    if (result.status === "declined" && !isInteractive()) {
        options.logger.info(
            `hint: ${DEV_VARS_FILE} was not scaffolded (non-interactive run). ` +
                `Copy ${DEV_VARS_EXAMPLE_FILE} → ${DEV_VARS_FILE} and fill in secrets, ` +
                `or run \`lunora dev\` in an interactive terminal to scaffold automatically.`,
        );
    }

    // Phase 3 — fill any empty/placeholder secret already in .dev.vars (a
    // `lunora add`-scaffolded project writes secrets blank) and ensure the core
    // LUNORA_ADMIN_TOKEN is present + generated, so the worker boots with real
    // secrets and the Studio authenticates without its login gate. No prompt: it
    // only generates locally-derivable values and never overwrites a real one.
    // Best-effort — a write failure must not block dev startup.
    try {
        (options.fillSecrets ?? fillDevSecrets)({
            cwd,
            info: (message) => {
                options.logger.info(message);
            },
        });
    } catch {
        // Non-fatal — fall through to the worker, which will surface a missing secret itself.
    }
};

/**
 * Wrangler-flavor extras once the worker child is spawned: tail the dev
 * containers' Docker logs and print the banner. Skipped for the vite flavor,
 * where the plugin stack owns both. (The `.lunora/dev.json` record is claimed
 * earlier, before any sibling starts — see the claim in {@link runDevCommand}.)
 * Returns the container-log disposer for the caller's teardown set.
 */
const afterWorkerSpawn = (
    plan: DevCommandPlan,
    cwd: string,
    logger: Logger,
    studioUrl: string | undefined,
    manifestPath: string | undefined,
): ContainerLogStreamHandle | undefined => {
    if (plan.flavor !== "wrangler") {
        return undefined;
    }

    // Backfill the studio URL onto the record claimed before the siblings
    // started (it wasn't known at claim time).
    if (studioUrl !== undefined) {
        updateDevServerState(cwd, { studioUrl });
    }

    let containerLogs: ContainerLogStreamHandle | undefined;

    // Tail the local dev containers' own stdout/stderr (no-op when the project
    // declares none). Best-effort — a Docker hiccup must not break dev.
    try {
        containerLogs = startContainerLogStreaming(cwd, logger);
    } catch {
        /* never fatal */
    }

    printBanner(logger, plan, studioUrl, manifestPath);

    return containerLogs;
};

/**
 * Atomically claim `.lunora/dev.json` for a starting dev server. Closes the
 * check-then-write race where two simultaneous starts both pass the
 * read-based lock check. For the wrangler flavor this record is final; for
 * the vite flavor it is *provisional* — the pre-listen default URL under this
 * CLI's PID — and `@lunora/vite`'s dev-state plugin supersedes it with the
 * authoritative URL + Vite's PID (see {@link DEV_HANDOFF_ENV}). A daemon
 * re-invocation likewise supersedes the provisional record its background
 * parent claimed before spawning it. Returns the live incumbent on a lost
 * claim.
 */
const claimStartRecord = (plan: DevCommandPlan, cwd: string): { pid: number; url: string } | undefined => {
    const handoffPid = Number(process.env[DEV_HANDOFF_ENV]);
    const claim = claimDevServerState(
        cwd,
        {
            background: process.env[DEV_DAEMON_ENV] === "1",
            logFile: process.env[DEV_LOG_FILE_ENV],
            mode: "cli",
            pid: process.pid,
            startedAt: new Date().toISOString(),
            url: plan.workerOrigin,
        },
        Number.isInteger(handoffPid) && handoffPid > 0 ? { supersedePid: handoffPid } : undefined,
    );

    return claim.ok ? undefined : claim.existing;
};

/**
 * Write the binding manifest describing what this Worker needs and where it
 * serves.
 *
 * Written on EVERY dev start, not only when asked. `.lunora/dev.json` is already
 * produced unconditionally into the same gitignored directory and the manifest
 * carries no secrets — `vars` is key names only — so the cost is one small JSON
 * write against a real gain: the flag it replaces had to be discovered before it
 * could help, and a supervisor that does not know it exists hand-maintains a
 * second copy of these bindings until it finds out.
 *
 * The failure policy differs by who asked, deliberately. An explicit
 * `--emit-bindings` means something is WAITING on that file, so a project with no
 * readable `wrangler.jsonc` fails the run rather than starting a server whose
 * supervisor is pointed at nothing. The default write is a courtesy, so the same
 * condition is a debug line — defaulting a hard error would break every project
 * that has no wrangler config at all.
 *
 * Extracted from `runDevCommand` because that function is at the repo's
 * cognitive-complexity ceiling, and startup orchestration keeps being added.
 */
const emitDevBindingManifest = (options: {
    cwd: string;
    destination: string | undefined;
    logger: Logger;
    plan: DevCommandPlan;
}): { error?: string; written?: string } => {
    const { cwd, destination, logger, plan } = options;
    const requested = destination !== undefined;
    const target = destination ?? DEV_BINDINGS_FILE;
    const result = writeBindingManifestFile({
        destination: target,
        dev: {
            // Only where the CLI owns the port. On the Vite flavors
            // `workerOrigin` is a pre-listen guess — Vite resolves its own,
            // possibly after this file is written — so publishing it would aim a
            // supervisor's proxy at a port nothing is listening on. `statusFile`
            // carries the real URL there, from the record `@lunora/vite` writes
            // once it is up.
            ...(plan.flavor === "wrangler" ? { origin: plan.workerOrigin } : {}),
            statusFile: DEV_STATE_FILE,
        },
        // The default write must not announce itself on every `lunora dev`; the
        // requested one should say where it put the file.
        logger: requested ? logger : { ...logger, success: () => {}, warn: () => {} },
        projectRoot: cwd,
    });

    if (result.error !== undefined) {
        if (requested) {
            return result;
        }

        logger.debug?.(`skipped the default binding manifest: ${result.error}`);

        return {};
    }

    return { written: target };
};

/**
 * Start the embedded studio server for the wrangler/framework-worker flavors —
 * best-effort: a start failure is logged and dev continues without it. Returns
 * the handle (for teardown), or `undefined` when studio is disabled or failed.
 */
const startStudioBestEffort = async (
    options: DevCommandOptions,
    plan: DevCommandPlan,
    cwd: string,
    logger: Logger,
): Promise<StudioServerHandle | undefined> => {
    if (!plan.studioEnabled) {
        return undefined;
    }

    try {
        return await (options.startStudio ?? startStudioServer)({
            // The studio's schema-edit / policy-scaffold endpoints regenerate
            // in-process, so they need the SAME apiSpec this run's own codegen uses
            // — codegen deletes the spec file its mode does not name.
            apiSpec: options.apiSpec,
            cwd,
            logger: {
                warnOnce: (message) => {
                    logger.warn(message);
                },
            },
            port: plan.studioPort,
            workerOrigin: plan.workerOrigin,
        });
    } catch (error: unknown) {
        logger.warn(`studio server failed to start (${error instanceof Error ? error.message : String(error)}) — continuing without it`);

        return undefined;
    }
};

/**
 * What `--no-worker` leaves running, named from the flags rather than assumed.
 *
 * With `--no-codegen` (or `--no-studio`) alongside `--no-worker` this used to
 * name a service that was not running, and with all three off it named one
 * while nothing ran at all.
 */
const attachedModeNotice = (plan: DevCommandPlan): string => {
    const attached = [plan.runsCodegenWatch ? "codegen watch" : undefined, plan.studioEnabled ? "studio" : undefined].filter(
        (name): name is string => name !== undefined,
    );

    const running = attached.length > 0 ? `${attached.join(" + ")} running` : "nothing else to run";

    return `--no-worker: not starting wrangler. ${running}; your task runner owns the worker on ${plan.workerOrigin}.`;
};

/**
 * For the two-process framework-worker flavor (SvelteKit / Nuxt), regenerate
 * `_generated/*` once up front so the sidecar's `wrangler dev` can bundle
 * `lunora/server.ts` immediately — the framework's own `@lunora/vite` plugin
 * owns the ongoing watch, but there's a startup race. Best-effort + a no-op for
 * every single-process flavor. A failure is surfaced but non-fatal.
 */
const ensureSidecarGenerated = (plan: DevCommandPlan, options: DevCommandOptions, cwd: string, logger: Logger, target: string): void => {
    if (plan.sidecar === undefined || !codegenRequested(options)) {
        return;
    }

    try {
        runCodegen({ apiSpec: options.apiSpec, lunoraDirectory: "lunora", projectRoot: cwd, target });
    } catch (error: unknown) {
        logger.warn(`codegen (pre-sidecar) failed: ${error instanceof Error ? error.message : String(error)} — the framework dev server will retry`);
    }
};

/** The startup line: Vite owns everything on its flavor; otherwise it names the worker's dev server (the child's tag). */
const startBanner = (plan: DevCommandPlan): string =>
    plan.flavor === "vite" ? "starting vite dev (worker + studio + codegen run inside Vite via @lunora/vite)" : `starting ${plan.wrangler.tag} dev + studio`;

/**
 * The worker the plan runs — a celld dev session, else the planned dev server
 * process — or `undefined`, logged, when it cannot start.
 */
const startPlannedWorker = async (
    plan: DevCommandPlan,
    options: DevCommandOptions,
    spawn: WorkerSpawner,
    cwd: string,
    logger: Logger,
): Promise<WorkerProcess | undefined> => {
    try {
        return plan.celldSession === true
            ? await startCelldWorker({ logger, port: plan.workerPort, projectRoot: cwd, start: options.startCelldSession })
            : spawn(plan.wrangler, logger);
    } catch (error: unknown) {
        logger.error(`could not start the worker: ${error instanceof Error ? error.message : String(error)}`);

        return undefined;
    }
};

/**
 * Start codegen watch + the studio server, spawn `wrangler dev`, print the
 * banner, and resolve when the worker exits or the user interrupts — tearing
 * down the sibling servers either way. The three side-effecting pieces (worker,
 * studio, codegen) are injectable so this is testable without real I/O.
 */
const runDevCommand = async (options: DevCommandOptions): Promise<{ code: number; plan: DevCommandPlan }> => {
    const { logger } = options;
    // Resolved the same way `buildDevPlan` / `planDevCommand` resolve them, so
    // the pre-plan work below sees exactly the project (and flavor) the plan
    // will describe.
    const cwd = options.cwd ?? process.cwd();
    const detectedFlavor = options.flavor ?? detectDevFlavor(cwd);
    // Resolved for every flavor, not just the ones that run the codegen watcher:
    // the `vite` and `framework-worker` flavors have `runsCodegenWatch === false`,
    // so gating on it accepted `--target` and then used it nowhere — while
    // `lunora codegen --target <same typo>` exited 1. Resolving here also puts
    // the failure before the dev-vars prompt and the start-record claim, rather
    // than after them.
    //
    // `Runnable` rather than a bare resolve: a target whose driver ships no
    // toolchain has nothing for the sidecar (or the Vite plugin's worker) to
    // spawn, and `toolchain?.dev(...)` used to fall through to `wrangler dev` —
    // serving a Node-target app on Cloudflare's runtime, then hard-failing at
    // deploy.
    //
    // Ahead of `buildDevPlan`, so a bad `--target` throws before the `--remote`
    // temp config is written rather than orphaning that file in the project root
    // (where the templates' exact-name `.wrangler` ignore does not match it).
    // There is nothing to tear down yet on this path.
    const resolvedTarget = resolveRunnableTargetOrError(cwd, options.target);

    if (resolvedTarget.target === undefined) {
        throw new Error(resolvedTarget.error ?? "unknown deploy target");
    }

    const { target } = resolvedTarget;

    const flavor = resolveTargetFlavor(target, detectedFlavor, logger);

    // Auto-provision the bindings the project's code implies, the same way
    // `@lunora/vite` does on every dev-server start — for the wrangler flavor
    // there is no plugin to do it, so a newly exported `SchedulerDO` /
    // `defineWorkflow` / `defineQueue` used to get its binding only at
    // `lunora deploy`, and `lunora dev` ran a worker missing it until then.
    // Idempotent and best-effort (it logs and moves on), so it is safe on every
    // start. No cron argument: dev has no codegen result to prove the project's
    // cron set here, and clearing a committed `triggers.crons` on a guess would
    // stop production crons.
    //
    // BEFORE `buildDevPlan`, which under `--remote` snapshots `wrangler.jsonc`
    // into the temp config the spawned wrangler runs with (`--config`). Taken
    // first, that copy is a binding short — the worker booted without the
    // binding this call had just written. Same ordering the Vite plugin's remote
    // path had to adopt.
    if (flavor === "wrangler") {
        await provisionBindings(cwd, logger, undefined, target, undefined);
    }

    const plan = await buildDevPlan({ ...options, flavor, target });
    // Torn down on every exit path, including a throw during startup (the
    // `finally`).
    const handles: Teardown = { remoteCleanup: plan.remote.cleanup, serviceConfigCleanup: plan.serviceConfigCleanup };

    try {
        // Lockfile check: a live `.lunora/dev.json` means a dev server is
        // already running — report it and succeed (idempotent start) instead of
        // spawning a conflicting sibling. A stale record (dead PID) was already
        // cleared by the read.
        //
        // A background daemon inherits DEV_HANDOFF_ENV = its parent's PID, and
        // that parent wrote a PROVISIONAL record (its own PID) before spawning
        // us. Skip that record here — `claimStartRecord` below supersedes it via
        // `supersedePid`. Without this skip the daemon sees its own parent's
        // claim, reports "already running", and never starts (this is the path
        // `lunora dev` takes under AI-agent auto-background, so it would silently
        // fail to launch). A genuine other server has a PID that is neither ours
        // nor the handoff parent's, so it still short-circuits correctly.
        const handoffPid = Number(process.env[DEV_HANDOFF_ENV]);
        const existing = readLiveDevServerState(cwd);

        if (existing !== undefined && existing.pid !== process.pid && existing.pid !== handoffPid) {
            reportExistingServer(logger, existing);

            return { code: 0, plan };
        }

        // Atomically claim the record before ANY sibling starts (see
        // claimStartRecord); a lost claim means another start won the race.
        const incumbent = claimStartRecord(plan, cwd);

        if (incumbent !== undefined) {
            reportExistingServer(logger, incumbent);

            return { code: 0, plan };
        }

        if (plan.flavor === "vite" || plan.flavor === "framework-worker") {
            // Hand the provisional record down so the dev-state plugin inside
            // the framework's Vite child may supersede it (and only it) with the
            // authoritative resolved URL + Vite's own PID. For framework-worker
            // the front door is the framework dev server (`plan.wrangler`), not
            // the sidecar, so the handoff rides on it.
            plan.wrangler.env = { ...plan.wrangler.env, [DEV_HANDOFF_ENV]: String(process.pid) };
        }

        await offerDevVariablesScaffold(options, cwd);

        logger.info(startBanner(plan));

        if (plan.ipv4LoopbackForced) {
            logger.info(
                "no IPv6 loopback (::1) on this host — binding the worker to 127.0.0.1 (--ip) so wrangler dev doesn't crash. Pin `dev.ip` in wrangler.jsonc to override.",
            );
        }

        if (plan.runsCodegenWatch) {
            handles.codegen = (options.startCodegen ?? startCodegenWatch)({
                apiSpec: options.apiSpec,
                jsonLogs: options.jsonLogs,
                logger,
                projectRoot: cwd,
                target,
            });
        }

        handles.studio = await startStudioBestEffort(options, plan, cwd, logger);

        // Written before the worker starts, and before the readiness probe: a
        // supervisor needs to know what to provision and where to point BEFORE
        // the thing it is provisioning for is up. Readiness is deliberately not
        // in here — the manifest is written once and readiness arrives later, so
        // it names `.lunora/dev.json` rather than shipping a `ready: false` that
        // never changes.
        const emitted = emitDevBindingManifest({ cwd, destination: options.emitBindings, logger, plan });

        // Fatal, unlike most of dev's best-effort startup: the flag exists
        // because something else is waiting on this file, and starting the server
        // without it leaves that supervisor pointed at nothing while Lunora looks
        // healthy.
        if (emitted.error !== undefined) {
            logger.error(emitted.error);

            return { code: EXIT_CODE.USAGE, plan };
        }

        // After the studio start, so the two overlap, but before the worker below:
        // the startup `postcodegen` is what FINISHES generated output, and a
        // wrangler bundle taken while it is still running is the unfinished copy.
        // `runCodegen` itself already completed inside `startCodegenWatch`.
        await handles.codegen?.ready;

        const studioUrl = handles.studio?.url;

        // A Vite/meta-framework was detected: nudge the user to their framework
        // dev script for the full app before wrangler starts (the worker still runs).
        if (plan.frameworkHint !== undefined) {
            logger.warn(plan.frameworkHint);
        }

        // Stamp `readyAt` on `.lunora/dev.json` once the recorded origin answers,
        // so a task runner supervising Lunora alongside other workers waits on a
        // fact instead of a guessed sleep. Not awaited: readiness is metadata FOR
        // someone else, and blocking the banner on it would delay the very server
        // it reports.
        //
        // Only the wrangler flavor: on the Vite flavors `workerOrigin` is a
        // pre-listen guess and `@lunora/vite` writes the authoritative record,
        // stamping `readyAt` itself once Vite resolves its real URL.
        const startReadyProbe = (): void => {
            if (plan.flavor !== "wrangler") {
                return;
            }

            handles.readyProbe = new AbortController();

            // eslint-disable-next-line @typescript-eslint/no-floating-promises -- resolve-only by construction: the probe reports rather than throws, and teardown aborts it
            markWorkerReadyWhenServing({
                cwd,
                logger,
                origin: plan.workerOrigin,
                probe: options.probeReady,
                signal: handles.readyProbe.signal,
            });
        };

        if (!plan.workerEnabled) {
            // Attached mode: whatever is left after `--no-worker` keeps running
            // and an external runner owns the worker. Park until interrupted so
            // the supervisor sees a normal long-lived process.
            //
            // The probe still runs: somebody else starting the worker changes who
            // listens, not who reports, and this process still owns the record.
            // Skipping it here left `status` saying "starting" forever for a
            // server that had been serving for an hour.
            startReadyProbe();
            logger.info(attachedModeNotice(plan));
            handles.tunnel = startTunnelForPlan({ cwd, logger, plan, tunnel: options.tunnel });

            return { code: await (options.waitForInterrupt ?? waitForInterrupt)(logger), plan };
        }

        ensureSidecarGenerated(plan, options, cwd, logger, target);

        const spawn = options.startWorker ?? defaultWorkerSpawner;
        const worker = await startPlannedWorker(plan, options, spawn, cwd, logger);

        if (worker === undefined) {
            return { code: EXIT_CODE.FAILURE, plan };
        }
        // The Lunora realtime sidecar (`wrangler dev`, owns ShardDO) for the
        // framework-worker flavor — `undefined` for every single-process flavor.
        const sidecar = plan.sidecar === undefined ? undefined : spawn(plan.sidecar, logger);

        // After the spawn, not before: the probe cannot tell OUR worker from
        // anything else already listening on that origin. Started early, a
        // stale server or an unrelated process holding the port would answer
        // immediately, `readyAt` would be stamped for it, and `status` would
        // report ready while wrangler was still failing to bind — pointing every
        // dependent task at the wrong server. (Attached mode is the exception
        // above: there the worker is someone else's by definition.)
        startReadyProbe();

        handles.containerLogs = afterWorkerSpawn(plan, cwd, logger, studioUrl, emitted.written);
        handles.tunnel = startTunnelForPlan({ cwd, logger, plan, tunnel: options.tunnel });

        printAgentRulesHint(logger, cwd);

        const code = await superviseWorkers(worker, sidecar, logger);

        return { code, plan };
    } finally {
        // Always shut the siblings down + unlink the remote temp config, whether
        // the worker exited cleanly, the user interrupted, or startup threw.
        // The state record is only cleared while it still carries THIS process's
        // PID (the guard makes the vite flavor — where Vite's plugin owns the
        // record — and the already-running early return no-ops).
        // Abort first, THEN clear: the probe patches this record, so stopping it
        // before the file goes away is what makes the teardown ordering match
        // what its comment claims.
        handles.readyProbe?.abort();
        clearDevServerState(cwd, process.pid);
        await teardown(handles);
    }
};

/**
 * The three negatable `lunora dev` booleans, mapped from parsed cerebro options
 * onto {@link DevCommandOptions}.
 *
 * cerebro parses `--no-codegen` / `--no-studio` / `--no-worker` as the negation
 * of the positive boolean (the runtime key drops the `no-` prefix), so a passed
 * flag arrives as `false` and an absent one as `undefined` — which every reader
 * treats as "on" via `!== false`.
 *
 * All three map here, in one place returning the whole slice, because this is
 * exactly what went wrong: the mapping was written per flag and `worker` was
 * never added, so `--no-worker` was declared, documented and forwarded to the
 * daemon while the foreground path always spawned `wrangler dev` anyway — and
 * the documented monorepo recipe died with `EADDRINUSE`. A slice-shaped mapper
 * makes a missing key a type error rather than a silent no-op.
 */
const negatableDevFlags = (options: Pick<DevOptions, "codegen" | "studio" | "worker">): Pick<DevCommandOptions, "codegen" | "studio" | "worker"> => {
    return {
        codegen: options.codegen === false ? false : undefined,
        studio: options.studio === false ? false : undefined,
        worker: options.worker === false ? false : undefined,
    };
};

/**
 * The flag combinations `lunora dev` refuses as a usage error, or `undefined`.
 * `--local` is the opposite of `--remote`; `--allow-mail` protects a tunnel, so
 * without `--tunnel` there is nothing for it to protect, and an entry that is
 * not an email address (or `*@domain`) protects nothing either.
 */
const devFlagConflict = (options: Pick<DevOptions, "allowMail" | "local" | "remote" | "tunnel">): string | undefined => {
    if (options.local === true && options.remote === true) {
        return "`--local` and `--remote` are mutually exclusive — pass at most one.";
    }

    const { entries, invalid } = normalizeAllowMail(options.allowMail);

    if (invalid.length > 0) {
        return `\`--allow-mail\` takes email addresses or '*@domain' — not ${invalid.map((entry) => `"${entry}"`).join(", ")}.`;
    }

    if (entries.length > 0 && options.tunnel !== true) {
        return "`--allow-mail` only applies to a tunnel — add `--tunnel`.";
    }

    return undefined;
};

/** The `--tunnel` request, built once from the parsed flags; `undefined` without `--tunnel`. */
const tunnelRequest = (options: Pick<DevOptions, "allowMail" | "tunnel">): DevTunnelRequest | undefined =>
    options.tunnel === true ? { allowMail: normalizeAllowMail(options.allowMail).entries } : undefined;

/** `lunora dev` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<DevOptions> = defineHandler<DevOptions>(async ({ argument, cwd, logger, options }) => {
    const json = options.json === true;

    // `stop` / `status` / `logs` route to their lifecycle commands; `undefined`
    // means no subcommand — fall through to the start flow below.
    const dispatched = runLifecycleSubcommand({ cwd, json, lines: options.lines, logger, subcommand: argument[0] });

    if (dispatched !== undefined) {
        return dispatched;
    }

    // A daemon re-invocation IS the background server: it must run the plain
    // foreground path below (and never re-detect an agent and recurse).
    const isDaemon = process.env[DEV_DAEMON_ENV] === "1";
    const agent = isDaemon ? undefined : detectAiAgent();
    const jsonLogs = json || agent !== undefined;

    if (jsonLogs) {
        // Safe pre-first-log-line: the shared pail rebuilds with the JSON reporter.
        forceJsonLogging();
    }

    if (agent !== undefined && options.background !== true) {
        logger.info(
            `AI agent detected (${agent.name} via ${agent.variable}) — starting the dev server in background mode with JSON logs. Set LUNORA_AGENT_MODE=0 to opt out.`,
        );
    }

    // Remote-binding mode obeys a clear precedence: an explicit `--remote`
    // flag wins, then `LUNORA_REMOTE` in the environment, then the `remote`
    // key in the project's `lunora.config.*` (a project default). See
    // `resolveRemoteEnabled` in @lunora/config.
    // `--local` is the opposite request, so the two flags together are a usage
    // error; on its own it beats a remote default from the env or the config.
    const usageError = devFlagConflict(options);

    if (usageError !== undefined) {
        logger.error(`dev: ${usageError}`);

        return { code: EXIT_CODE.USAGE };
    }

    const tunnel = tunnelRequest(options);

    const remote =
        options.local === true
            ? false
            : resolveRemoteEnabled({
                  configPreference: readProjectRemotePreference(cwd),
                  envValue: process.env["LUNORA_REMOTE"],
                  flag: options.remote,
              });

    if (!isDaemon && (options.background === true || agent !== undefined)) {
        // Idempotent start: a live server means success, not a conflict.
        const existing = readLiveDevServerState(cwd);

        if (existing !== undefined) {
            reportExistingServer(logger, existing);

            return { code: 0 };
        }

        // The daemon prints the tunnel's own warning into its log file, which
        // nobody reads until something goes wrong — say it here, where the
        // person who asked for a public URL is looking.
        if (tunnel?.allowMail.length === 0) {
            printPublicWarning(logger);
        }

        return startBackground({ cwd, jsonLogs, logger, options, remote });
    }

    return runDevCommand({
        apiSpec: parseApiSpec(options.apiSpec),
        cwd,
        emitBindings: options.emitBindings,
        inspectorPort: options.inspectorPort,
        jsonLogs,
        local: options.local,
        logger,
        port: options.port,
        remote,
        target: options.target,
        tunnel,
        workerPort: options.workerPort,
        ...negatableDevFlags(options),
    });
});

export { execute };
export { devFlagConflict, negatableDevFlags, runDevCommand };
