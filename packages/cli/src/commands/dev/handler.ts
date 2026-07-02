import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ContainerLogStreamHandle } from "@lunora/config";
import {
    AGENT_RULES_HINT,
    claimAgentRulesHint,
    clearDevServerState,
    detectAgentRules,
    detectAiAgent,
    detectFramework,
    DEV_DAEMON_ENV,
    DEV_LOG_FILE_ENV,
    DEV_VARS_EXAMPLE_FILE,
    DEV_VARS_FILE,
    discoverContainerInfo,
    ensureDevVariables,
    ensureDevVarsExample,
    fillDevSecrets,
    formatLunoraEvent,
    inferLunoraBindings,
    isInteractive,
    materializeRemoteWranglerConfig,
    packageNamesFromBindings,
    readLiveDevServerState,
    readProjectDependencyNames,
    readProjectRemotePreference,
    resolveRemoteEnabled,
    streamContainerLogs,
    writeDevServerState,
} from "@lunora/config";

import type { ApiSpec } from "../../util/api-spec";
import { parseApiSpec } from "../../util/api-spec";
import type { CodegenWatcherHandle } from "../../util/codegen-watch";
import { startCodegenWatch } from "../../util/codegen-watch";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { PackageManager } from "../../util/detect-package-manager";
import { detectPackageManager, execArgsFor, runScriptCommand } from "../../util/detect-package-manager";
import type { Logger } from "../../util/logger";
import { forceJsonLogging } from "../../util/logger";
import type { SpawnDescriptor } from "../../util/spawn";
import type { StudioServerHandle } from "../../util/studio-server";
import { startStudioServer } from "../../util/studio-server";
import { createTuiConfirm } from "../../util/tui-prompts";
import type { DevOptions } from "./index";
import { runDevBackground, runDevLogs, runDevStatus, runDevStop } from "./lifecycle";

/** Default port the embedded studio server listens on (the URL you open). */
const DEFAULT_STUDIO_PORT = 6173;
/** Default port `wrangler dev` serves the worker on. */
const DEFAULT_WORKER_PORT = 8787;
/** Default port Vite serves on — the state record carries the real resolved URL. */
const DEFAULT_VITE_PORT = 5173;
/** Grace period after the first SIGINT before we force-kill the worker. */
const SIGINT_GRACE_MS = 5000;

/**
 * How the dev child runs. `wrangler` is the classic `lunora dev` stack
 * (wrangler worker + embedded studio + codegen watch). `vite` is a project on
 * `@lunora/vite`: the Vite plugin already runs the worker, studio, and codegen
 * inside the Vite dev server, so `lunora dev` runs the project's own dev
 * script and gets out of the way — that's what makes `--background` / `stop` /
 * `status` / `logs` work uniformly for Vite projects too.
 */
type DevFlavor = "vite" | "wrangler";

/** Detect the dev flavor: a declared `@lunora/vite` dependency means Vite owns the dev server. */
const detectDevFlavor = (cwd: string): DevFlavor => (readProjectDependencyNames(cwd).has("@lunora/vite") ? "vite" : "wrangler");

/**
 * Resolve the child command for the vite flavor. The project's own `dev`
 * script is the source of truth — for a meta-framework the dev server is the
 * framework CLI (`astro dev`, `nuxt dev`, …), not bare `vite dev`, and every
 * scaffolded template wires the right one into `scripts.dev`. Falls back to
 * `vite dev` when there is no usable script, or when the script mentions
 * `lunora` (it would re-enter this CLI and spawn itself forever).
 */
const resolveViteDevExec = (manager: PackageManager, cwd: string): { args: string[]; command: string } => {
    let script: string | undefined;

    try {
        const raw = readFileSync(join(cwd, "package.json"), "utf8");

        script = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts?.dev;
    } catch {
        // Missing / malformed package.json — fall through to the vite default.
    }

    if (script === undefined || script.trim() === "" || script.includes("lunora")) {
        return execArgsFor(manager, "vite", ["dev"]);
    }

    // `<manager> run dev` is valid for npm, pnpm, yarn, and bun alike.
    return { args: ["run", "dev"], command: manager };
};

/** A running worker child the orchestrator controls: send signals, await its exit. */
interface WorkerProcess {
    /** Resolves with the worker's exit code (1 if it failed to start). */
    exited: Promise<number>;
    kill: (signal: NodeJS.Signals) => void;
}

/** Spawns the worker child. Injectable so tests drive the orchestration without a real process. */
type WorkerSpawner = (descriptor: SpawnDescriptor & { tag: string }, logger: Logger) => WorkerProcess;

interface DevCommandOptions {
    /** Which API spec(s) the codegen watcher emits. Defaults to codegen's `"openapi"` when omitted. */
    apiSpec?: ApiSpec;
    /** Disable the codegen watch loop. */
    codegen?: boolean;
    cwd?: string;
    /** Injection seam for tests — defaults to the real `.dev.vars` scaffolder. */
    ensureEnv?: typeof ensureDevVariables;
    /** Injection seam for tests — defaults to the real `.dev.vars.example` package-aware scaffolder. */
    ensureExample?: typeof ensureDevVarsExample;
    /** Injection seam for tests — defaults to the real empty-secret/admin-token filler. */
    fillSecrets?: typeof fillDevSecrets;
    /** Dev flavor override (tests / callers that already detected it) — defaults to {@link detectDevFlavor}. */
    flavor?: DevFlavor;
    logger: Logger;
    /** Injection seam for tests — defaults to the real remote-config materializer. */
    materializeRemote?: typeof materializeRemoteWranglerConfig;
    /** Studio server port. */
    port?: number;
    /** Proxy D1/KV/R2 bindings to the deployed worker during dev (`LUNORA_REMOTE=1` / `--remote`); DO shards stay local. */
    remote?: boolean;
    /** Injection seam for tests — defaults to the real codegen watcher. */
    startCodegen?: typeof startCodegenWatch;
    /** Injection seam for tests — defaults to the real studio server. */
    startStudio?: typeof startStudioServer;
    /** Injection seam for tests — defaults to spawning a real `wrangler dev`. */
    startWorker?: WorkerSpawner;
    /** Disable the embedded studio server. */
    studio?: boolean;
    /** `wrangler dev` port. */
    workerPort?: number;
}

interface DevRemotePlan {
    /** Short binding labels remoted (e.g. `"DB (D1)"`), for the banner. */
    bindings: string[];

    /**
     * Removes the generated temp wrangler config when dev exits. Always present
     * and idempotent — a no-op when remote mode is off or nothing was
     * materialized. The dev loop calls it on every shutdown path.
     */
    cleanup: () => void;
    /** Whether remote mode was requested. */
    enabled: boolean;
    /** Why remote mode didn't take effect despite being requested, for logging. */
    reason?: string;
}

interface DevCommandPlan {
    codegenEnabled: boolean;
    /** Which stack the child runs — see {@link DevFlavor}. */
    flavor: DevFlavor;

    /**
     * One-line redirect hint printed when a meta-framework is detected on the
     * wrangler flavor: without `@lunora/vite` in the dependencies the worker
     * still runs *inside* the framework's dev server, so the user should run
     * their framework dev script for the full app. `undefined` for the vite
     * flavor (`lunora dev` already runs the project's dev script there) and
     * for a standalone project. Purely informational: the wrangler spawn runs
     * regardless.
     */
    frameworkHint?: string;
    /** The remote-binding decision: which D1/KV/R2 bindings hit the deployed worker. */
    remote: DevRemotePlan;
    studioEnabled: boolean;
    studioPort: number;
    workerOrigin: string;
    workerPort: number;
    /** The single child process `lunora dev` spawns: `wrangler dev` (or `vite dev` for the vite flavor). */
    wrangler: SpawnDescriptor & { tag: string };
}

/**
 * Resolve remote-binding mode into the extra `wrangler dev` args + a banner
 * summary. When `--remote`/`LUNORA_REMOTE` is set we materialize a temp wrangler
 * config with `"remote": true` on each D1/KV/R2 binding (Durable Object shards
 * stay local) and point `wrangler dev --config` at it, so the local worker reads
 * and writes the **deployed** resources. When disabled, or when there's nothing
 * to remote, the args stay empty and dev runs fully local.
 */
const resolveRemotePlan = (options: DevCommandOptions, cwd: string): { args: string[]; plan: DevRemotePlan } => {
    // A disposer that does nothing — used whenever no temp config was written
    // (remote off, or a fall-through case), so `cleanup` is always callable.
    const noopCleanup = (): void => {};

    if (!options.remote) {
        return { args: [], plan: { bindings: [], cleanup: noopCleanup, enabled: false } };
    }

    const materialize = options.materializeRemote ?? materializeRemoteWranglerConfig;
    const result = materialize({ enabled: true, projectRoot: cwd });
    const bindings = result.remoteBindings.map((binding) => `${binding.binding} (${binding.kind})`);
    // The materializer always returns an idempotent, never-throwing `cleanup`.
    const { cleanup } = result;

    if (result.configPath === undefined) {
        return { args: [], plan: { bindings, cleanup, enabled: true, reason: result.reason } };
    }

    return { args: ["--config", result.configPath], plan: { bindings, cleanup, enabled: true } };
};

/**
 * Plan `lunora dev`. Wrangler flavor: the worker runs via `wrangler dev` and
 * nothing else as a child process. Vite flavor (`@lunora/vite` declared): the
 * plugin already runs the worker inside the Vite dev server, so the one child
 * is the project's own dev script (`vite dev`, `astro dev`, …) and every CLI
 * sibling is disabled. Pure + synchronous so it's unit-testable.
 */
const planDevCommand = (options: DevCommandOptions): DevCommandPlan => {
    const cwd = options.cwd ?? process.cwd();
    const manager = detectPackageManager(cwd);
    const flavor = options.flavor ?? detectDevFlavor(cwd);

    if (flavor === "vite") {
        // `@lunora/vite` already runs the worker + studio + codegen (and remote
        // bindings, dev vars, container logs) inside the Vite dev server — the
        // CLI's own siblings would duplicate them, so they're all disabled and
        // the one child is the project's own dev server. Remote mode is
        // forwarded as env (`LUNORA_REMOTE=1`) for the plugin's remote-bindings
        // handling; no temp wrangler config is materialized here. The Vite
        // plugin writes the authoritative `.lunora/dev.json` (real resolved URL
        // + Vite's PID) once the server listens; `workerOrigin` is only the
        // pre-listen default.
        const exec = resolveViteDevExec(manager, cwd);

        return {
            codegenEnabled: false,
            flavor,
            remote: { bindings: [], cleanup: () => {}, enabled: options.remote === true },
            studioEnabled: false,
            studioPort: options.port ?? DEFAULT_STUDIO_PORT,
            workerOrigin: `http://localhost:${String(DEFAULT_VITE_PORT)}`,
            workerPort: DEFAULT_VITE_PORT,
            wrangler: {
                args: exec.args,
                command: exec.command,
                cwd,
                ...(options.remote === true ? { env: { LUNORA_REMOTE: "1" } } : {}),
                tag: "vite",
            },
        };
    }

    // In a meta-framework project WITHOUT `@lunora/vite` (wrangler flavor, so
    // the vite branch above didn't take it) the worker still runs inside the
    // framework's dev server, so `lunora dev` (wrangler-only) gives just the
    // worker — no frontend, no HMR. Surface a one-line redirect hint; the
    // wrangler spawn still runs regardless (this is a hint, not a redirect).
    const detection = detectFramework(cwd);
    const frameworkHint =
        detection.framework === "none"
            ? undefined
            : `this project uses ${detection.framework} — the worker runs inside Vite there. run \`${runScriptCommand(manager, "dev")}\` for the full app (frontend + HMR); \`lunora dev\` starts only the worker.`;
    const workerPort = options.workerPort ?? DEFAULT_WORKER_PORT;
    const remote = resolveRemotePlan(options, cwd);
    // `--var WORKER_ENV:development` flags the worker as a dev deployment so the
    // runtime streams every RPC dispatch summary to the terminal by default
    // (`@lunora/do`'s `isDevEnvironment`). `wrangler dev` only — never `deploy` —
    // so it can't leak into production; a `WORKER_ENV` in wrangler config / a
    // `--var` the user passes still wins. Mirrors the Vite plugin's injection.
    // `--config <temp>` (when remote) points wrangler at a config whose D1/KV/R2
    // bindings carry `"remote": true`.
    const exec = execArgsFor(manager, "wrangler", ["dev", "--port", String(workerPort), "--var", "WORKER_ENV:development", ...remote.args]);

    return {
        codegenEnabled: options.codegen !== false,
        flavor,
        frameworkHint,
        remote: remote.plan,
        studioEnabled: options.studio !== false,
        studioPort: options.port ?? DEFAULT_STUDIO_PORT,
        workerOrigin: `http://localhost:${String(workerPort)}`,
        workerPort,
        wrangler: { args: exec.args, command: exec.command, cwd, tag: "wrangler" },
    };
};

/**
 * Emit one already-split output line. A Lunora structured event
 * (`source: "lunora"`) is rewritten as a tagged, attributed `[lunora]` line at
 * its own severity; everything else passes through tagged with the child's name
 * (`[wrangler]`), stderr at warn level.
 */
const emitChildLine = (line: string, tag: string, kind: "stderr" | "stdout", logger: Logger): void => {
    if (line.length === 0) {
        return;
    }

    const formatted = formatLunoraEvent(line);

    if (formatted) {
        // `formatted.level` is exactly the `error | info | warn` union of the
        // logger's channels, so index straight into it — no branch ladder.
        logger[formatted.level](`[lunora] ${formatted.text}`);

        return;
    }

    const prefixed = `[${tag}] ${line}`;

    if (kind === "stderr") {
        logger.warn(prefixed);
    } else {
        logger.info(prefixed);
    }
};

/**
 * Pipe a child's stdout/stderr through the logger, tagged by name, recognising
 * and reformatting Lunora structured log events along the way. Output is
 * line-buffered per stream so a structured event split across two `data` chunks
 * is still parsed as one line; the trailing partial is flushed on stream end.
 */
const pipeChildOutput = (child: ChildProcess, tag: string, logger: Logger): void => {
    const pumpStream = (stream: NodeJS.ReadableStream | null, kind: "stderr" | "stdout"): void => {
        if (!stream) {
            return;
        }

        let buffer = "";

        stream.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");

            const lines = buffer.split("\n");

            // Keep the last element as the (possibly incomplete) pending line.
            buffer = lines.pop() ?? "";

            for (const line of lines) {
                emitChildLine(line.trimEnd(), tag, kind, logger);
            }
        });

        stream.on("end", () => {
            emitChildLine(buffer.trimEnd(), tag, kind, logger);
            buffer = "";
        });
    };

    pumpStream(child.stdout, "stdout");
    pumpStream(child.stderr, "stderr");
};

/** Real worker spawner: runs the descriptor as a child and pipes its output through the logger. */
const defaultWorkerSpawner: WorkerSpawner = (descriptor, logger) => {
    const child = nodeSpawn(descriptor.command, [...descriptor.args], {
        cwd: descriptor.cwd ?? process.cwd(),
        env: descriptor.env ? { ...process.env, ...descriptor.env } : process.env,
        stdio: ["inherit", "pipe", "pipe"],
    });

    pipeChildOutput(child, descriptor.tag, logger);

    return {
        exited: new Promise<number>((resolve) => {
            child.on("error", (error) => {
                logger.error(`[${descriptor.tag}] failed to start: ${error.message}`);
                resolve(1);
            });
            child.on("exit", (code) => {
                resolve(code ?? 0);
            });
        }),
        kill: (signal) => {
            try {
                child.kill(signal);
            } catch {
                /* already gone */
            }
        },
    };
};

/** Print the Convex-style startup banner once the studio + worker URLs are known. */
const printBanner = (logger: Logger, plan: DevCommandPlan, studioUrl: string | undefined): void => {
    logger.info("");
    logger.success("Lunora dev");
    logger.info(`  ➜  Worker:     ${plan.workerOrigin}`);

    if (studioUrl !== undefined) {
        logger.info(`  ➜  Studio:  ${studioUrl}`);
    }

    if (plan.codegenEnabled) {
        logger.info("  ➜  Codegen:    watching lunora/");
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

interface Teardown {
    codegen?: CodegenWatcherHandle;
    /** Disposer for the dev container log stream (stops polling Docker + detaches). */
    containerLogs?: ContainerLogStreamHandle;
    /** Disposer for the materialized remote wrangler temp config (idempotent, never throws). */
    remoteCleanup?: () => void;
    studio?: StudioServerHandle;
}

/**
 * Follow the local Docker logs of every declared container and surface each
 * output line on the dev logger, tagged `[container:&lt;name>]`. Returns a disposer
 * (or `undefined` when there are no containers, so no Docker work ever starts).
 *
 * wrangler builds + runs each declared container locally but only forwards the
 * worker's console; the container process's own stdout/stderr would otherwise be
 * invisible. Set `LUNORA_CONTAINER_LOGS=0` to opt out.
 */
const startContainerLogStreaming = (cwd: string, logger: Logger): ContainerLogStreamHandle | undefined => {
    if (process.env.LUNORA_CONTAINER_LOGS === "0") {
        return undefined;
    }

    const discovery = discoverContainerInfo(cwd, "lunora");
    const containers = discovery.containers.map((container) => {
        return { className: container.className, exportName: container.exportName };
    });

    if (containers.length === 0) {
        return undefined;
    }

    return streamContainerLogs({
        containers,
        onLine: (line) => {
            const tagged = `[container:${line.name}] ${line.text}`;

            if (line.level === "error") {
                logger.warn(tagged);
            } else {
                logger.info(tagged);
            }
        },
        onUnavailable: (message) => {
            logger.warn(`[container] Docker engine unreachable — container logs unavailable (${message})`);
        },
    });
};

/** Best-effort shutdown of the studio server, codegen watcher, container logs, and remote temp config. */
const teardown = async (handles: Teardown): Promise<void> => {
    handles.codegen?.close();
    handles.containerLogs?.close();
    await handles.studio?.close().catch(() => undefined);
    // Unlink the generated remote wrangler config last; the disposer is itself
    // idempotent + swallows errors, but guard the call site too for safety.
    try {
        handles.remoteCleanup?.();
    } catch {
        /* already gone */
    }
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

/** Report an already-running dev server + the lifecycle hints (the idempotent-start path). */
const reportExistingServer = (logger: Logger, existing: { pid: number; url: string }): void => {
    logger.warn(`Dev server already running at ${existing.url} (pid ${String(existing.pid)})`);
    logger.info("  Stop:   lunora dev stop");
    logger.info("  Status: lunora dev status");
    logger.info("  Logs:   lunora dev logs");
};

/**
 * Wrangler-flavor extras once the worker child is spawned: write the
 * `.lunora/dev.json` record (so `dev stop|status|logs` + the duplicate-start
 * lock resolve this server), tail the dev containers' Docker logs, and print
 * the banner. All skipped for the vite flavor, where `@lunora/vite`'s
 * dev-state plugin writes the record itself (authoritative resolved URL +
 * Vite's own PID) and the plugin stack owns container logs and the banner.
 * Returns the container-log disposer for the caller's teardown set.
 */
const afterWorkerSpawn = (plan: DevCommandPlan, cwd: string, logger: Logger, studioUrl: string | undefined): ContainerLogStreamHandle | undefined => {
    if (plan.flavor !== "wrangler") {
        return undefined;
    }

    writeDevServerState(cwd, {
        background: process.env[DEV_DAEMON_ENV] === "1",
        logFile: process.env[DEV_LOG_FILE_ENV],
        mode: "cli",
        pid: process.pid,
        startedAt: new Date().toISOString(),
        studioUrl,
        url: plan.workerOrigin,
    });

    let containerLogs: ContainerLogStreamHandle | undefined;

    // Tail the local dev containers' own stdout/stderr (no-op when the project
    // declares none). Best-effort — a Docker hiccup must not break dev.
    try {
        containerLogs = startContainerLogStreaming(cwd, logger);
    } catch {
        /* never fatal */
    }

    printBanner(logger, plan, studioUrl);

    return containerLogs;
};

/**
 * Start codegen watch + the studio server, spawn `wrangler dev`, print the
 * banner, and resolve when the worker exits or the user interrupts — tearing
 * down the sibling servers either way. The three side-effecting pieces (worker,
 * studio, codegen) are injectable so this is testable without real I/O.
 */
const runDevCommand = async (options: DevCommandOptions): Promise<{ code: number; plan: DevCommandPlan }> => {
    const plan = planDevCommand(options);
    const { logger } = options;
    const cwd = plan.wrangler.cwd ?? process.cwd();
    // Register the remote temp-config disposer up front so it's torn down on
    // every exit path — including a throw during startup below (the `finally`).
    const handles: Teardown = { remoteCleanup: plan.remote.cleanup };

    try {
        // Lockfile check: a live `.lunora/dev.json` means a dev server is
        // already running — report it and succeed (idempotent start) instead of
        // spawning a conflicting sibling. A stale record (dead PID) was already
        // cleared by the read.
        const existing = readLiveDevServerState(cwd);

        if (existing !== undefined && existing.pid !== process.pid) {
            reportExistingServer(logger, existing);

            return { code: 0, plan };
        }

        await offerDevVariablesScaffold(options, cwd);

        logger.info(plan.flavor === "vite" ? "starting vite dev (worker + studio + codegen run inside Vite via @lunora/vite)" : "starting wrangler dev + studio");

        if (plan.codegenEnabled) {
            handles.codegen = (options.startCodegen ?? startCodegenWatch)({ apiSpec: options.apiSpec, logger, projectRoot: cwd });
        }

        let studioUrl: string | undefined;

        if (plan.studioEnabled) {
            try {
                handles.studio = await (options.startStudio ?? startStudioServer)({
                    cwd,
                    logger: {
                        warnOnce: (message) => {
                            logger.warn(message);
                        },
                    },
                    port: plan.studioPort,
                    workerOrigin: plan.workerOrigin,
                });
                studioUrl = handles.studio.url;
            } catch (error: unknown) {
                logger.warn(`studio server failed to start (${error instanceof Error ? error.message : String(error)}) — continuing without it`);
            }
        }

        // A Vite/meta-framework was detected: nudge the user to their framework
        // dev script for the full app before wrangler starts (the worker still runs).
        if (plan.frameworkHint !== undefined) {
            logger.warn(plan.frameworkHint);
        }

        const worker = (options.startWorker ?? defaultWorkerSpawner)(plan.wrangler, logger);

        handles.containerLogs = afterWorkerSpawn(plan, cwd, logger, studioUrl);
        printAgentRulesHint(logger, cwd);

        let sigintCount = 0;
        let escalationTimer: NodeJS.Timeout | undefined;

        const onSigint = (): void => {
            sigintCount += 1;

            if (sigintCount === 1) {
                logger.info("received SIGINT — shutting down (press Ctrl-C again to force-kill)");
                worker.kill("SIGTERM");
                escalationTimer = setTimeout(() => {
                    worker.kill("SIGKILL");
                }, SIGINT_GRACE_MS);
                escalationTimer.unref();
            } else {
                worker.kill("SIGKILL");
            }
        };
        const onSigterm = (): void => {
            worker.kill("SIGTERM");
        };

        process.on("SIGINT", onSigint);
        process.on("SIGTERM", onSigterm);

        const code = await worker.exited;

        if (escalationTimer) {
            clearTimeout(escalationTimer);
        }

        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);

        return { code, plan };
    } finally {
        // Always shut the siblings down + unlink the remote temp config, whether
        // the worker exited cleanly, the user interrupted, or startup threw.
        // The state record is only cleared while it still carries THIS process's
        // PID (the guard makes the vite flavor — where Vite's plugin owns the
        // record — and the already-running early return no-ops).
        clearDevServerState(cwd, process.pid);
        await teardown(handles);
    }
};

/**
 * Rebuild the argv a detached daemon `lunora dev` re-invocation needs, from the
 * already-parsed options. `--background`/`--json` are deliberately NOT
 * forwarded: the daemon must run the foreground path (its detachment marker is
 * {@link DEV_DAEMON_ENV}), and JSON logging travels as `LUNORA_LOG_JSON=1` env.
 */
const daemonArguments = (options: DevOptions, remote: boolean): string[] => {
    const args = ["dev"];

    if (options.apiSpec !== undefined) {
        args.push("--api-spec", options.apiSpec);
    }

    if (options.port !== undefined) {
        args.push("--port", String(options.port));
    }

    if (options.workerPort !== undefined) {
        args.push("--worker-port", String(options.workerPort));
    }

    if (options.codegen === false) {
        args.push("--no-codegen");
    }

    if (options.studio === false) {
        args.push("--no-studio");
    }

    if (remote) {
        args.push("--remote");
    }

    return args;
};

/**
 * Detach the dev server as a managed background process and block until it is
 * ready: the project's dev script directly for a Vite project (its dev-state
 * plugin writes the record), else this same CLI re-invoked as the daemon.
 */
const startBackground = (context: { cwd: string; jsonLogs: boolean; logger: Logger; options: DevOptions; remote: boolean }): Promise<{ code: number }> => {
    const { cwd, jsonLogs, logger, options, remote } = context;

    if (detectDevFlavor(cwd) === "vite") {
        const exec = resolveViteDevExec(detectPackageManager(cwd), cwd);

        return runDevBackground({
            command: { args: exec.args, command: exec.command },
            cwd,
            ...(remote ? { env: { LUNORA_REMOTE: "1" } } : {}),
            json: jsonLogs,
            logger,
        });
    }

    // Re-invoke this same CLI entry as the detached daemon.
    return runDevBackground({
        command: { args: [process.argv[1] ?? "lunora", ...daemonArguments(options, remote)], command: process.execPath },
        cwd,
        json: jsonLogs,
        logger,
    });
};

/** `lunora dev` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<DevOptions> = defineHandler<DevOptions>(async ({ argument, cwd, logger, options }) => {
    const subcommand = argument[0];
    const json = options.json === true;

    if (subcommand === "stop") {
        return runDevStop({ cwd, json, logger });
    }

    if (subcommand === "status") {
        return runDevStatus({ cwd, json, logger });
    }

    if (subcommand === "logs") {
        return runDevLogs({ cwd, lines: options.lines, logger });
    }

    if (subcommand !== undefined) {
        logger.error(`dev: unknown subcommand "${subcommand}" — expected stop | status | logs (or no subcommand to start the dev server)`);

        return { code: 1 };
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
        logger.info(`AI agent detected (${agent.name} via ${agent.variable}) — starting the dev server in background mode with JSON logs. Set LUNORA_AGENT_MODE=0 to opt out.`);
    }

    // Remote-binding mode obeys a clear precedence: an explicit `--remote`
    // flag wins, then `LUNORA_REMOTE` in the environment, then the `remote`
    // key in the project's `lunora.json` (a project default). See
    // `resolveRemoteEnabled` in @lunora/config.
    const remote = resolveRemoteEnabled({
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

        return startBackground({ cwd, jsonLogs, logger, options, remote });
    }

    return runDevCommand({
        apiSpec: parseApiSpec(options.apiSpec),
        // cerebro parses `--no-codegen`/`--no-studio` as the negation of the
        // `codegen`/`studio` booleans (runtime key drops the `no-` prefix), so a
        // passed flag arrives as `false`, absent as `true` (the option default).
        codegen: options.codegen === false ? false : undefined,
        cwd,
        logger,
        port: options.port,
        remote,
        studio: options.studio === false ? false : undefined,
        workerPort: options.workerPort,
    });
});

export { execute };
export type { DevCommandOptions, DevCommandPlan, DevFlavor, DevRemotePlan, WorkerProcess, WorkerSpawner };
export { detectDevFlavor, planDevCommand, resolveRemotePlan, runDevCommand };
