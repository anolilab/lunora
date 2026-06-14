import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";

import {
    AGENT_RULES_HINT,
    claimAgentRulesHint,
    createConfirm,
    detectAgentRules,
    ensureDevVariables,
    formatCirrusEvent,
    materializeRemoteWranglerConfig,
    readProjectRemotePreference,
    resolveRemoteEnabled,
} from "@cirrus/config";

import type { ApiSpec } from "../../util/api-spec";
import { parseApiSpec } from "../../util/api-spec";
import type { CodegenWatcherHandle } from "../../util/codegen-watch";
import { startCodegenWatch } from "../../util/codegen-watch";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { detectPackageManager, execArgsFor } from "../../util/detect-package-manager";
import type { Logger } from "../../util/logger";
import type { SpawnDescriptor } from "../../util/spawn";
import type { StudioServerHandle } from "../../util/studio-server";
import { startStudioServer } from "../../util/studio-server";
import type { DevOptions } from "./index";

/** Default port the embedded studio server listens on (the URL you open). */
const DEFAULT_STUDIO_PORT = 6173;
/** Default port `wrangler dev` serves the worker on. */
const DEFAULT_WORKER_PORT = 8787;
/** Grace period after the first SIGINT before we force-kill the worker. */
const SIGINT_GRACE_MS = 5000;

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
    logger: Logger;
    /** Injection seam for tests — defaults to the real remote-config materializer. */
    materializeRemote?: typeof materializeRemoteWranglerConfig;
    /** Studio server port. */
    port?: number;
    /** Proxy D1/KV/R2 bindings to the deployed worker during dev (`CIRRUS_REMOTE=1` / `--remote`); DO shards stay local. */
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
    /** The remote-binding decision: which D1/KV/R2 bindings hit the deployed worker. */
    remote: DevRemotePlan;
    studioEnabled: boolean;
    studioPort: number;
    workerOrigin: string;
    workerPort: number;
    /** The single child process `cirrus dev` spawns: `wrangler dev`. */
    wrangler: SpawnDescriptor & { tag: string };
}

/**
 * Resolve remote-binding mode into the extra `wrangler dev` args + a banner
 * summary. When `--remote`/`CIRRUS_REMOTE` is set we materialize a temp wrangler
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
 * Plan `cirrus dev`: it runs the worker via `wrangler dev` and nothing else as a
 * child process. Vite is intentionally NOT spawned — a project may not use Vite,
 * and when it does, the `@cirrus/vite` plugin already runs the worker inside
 * Vite, so the user runs `vite` themselves. Pure + synchronous so it's unit-testable.
 */
const planDevCommand = (options: DevCommandOptions): DevCommandPlan => {
    const cwd = options.cwd ?? process.cwd();
    const workerPort = options.workerPort ?? DEFAULT_WORKER_PORT;
    const manager = detectPackageManager(cwd);
    const remote = resolveRemotePlan(options, cwd);
    // `--var WORKER_ENV:development` flags the worker as a dev deployment so the
    // runtime streams every RPC dispatch summary to the terminal by default
    // (`@cirrus/do`'s `isDevEnvironment`). `wrangler dev` only — never `deploy` —
    // so it can't leak into production; a `WORKER_ENV` in wrangler config / a
    // `--var` the user passes still wins. Mirrors the Vite plugin's injection.
    // `--config <temp>` (when remote) points wrangler at a config whose D1/KV/R2
    // bindings carry `"remote": true`.
    const exec = execArgsFor(manager, "wrangler", ["dev", "--port", String(workerPort), "--var", "WORKER_ENV:development", ...remote.args]);

    return {
        codegenEnabled: options.codegen !== false,
        remote: remote.plan,
        studioEnabled: options.studio !== false,
        studioPort: options.port ?? DEFAULT_STUDIO_PORT,
        workerOrigin: `http://localhost:${String(workerPort)}`,
        workerPort,
        wrangler: { args: exec.args, command: exec.command, cwd, tag: "wrangler" },
    };
};

/**
 * Emit one already-split output line. A Cirrus structured event
 * (`source: "cirrus"`) is rewritten as a tagged, attributed `[cirrus]` line at
 * its own severity; everything else passes through tagged with the child's name
 * (`[wrangler]`), stderr at warn level.
 */
const emitChildLine = (line: string, tag: string, kind: "stderr" | "stdout", logger: Logger): void => {
    if (line.length === 0) {
        return;
    }

    const formatted = formatCirrusEvent(line);

    if (formatted) {
        // `formatted.level` is exactly the `error | info | warn` union of the
        // logger's channels, so index straight into it — no branch ladder.
        logger[formatted.level](`[cirrus] ${formatted.text}`);

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
 * and reformatting Cirrus structured log events along the way. Output is
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
        env: process.env,
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
    logger.success("Cirrus dev");
    logger.info(`  ➜  Worker:     ${plan.workerOrigin}`);

    if (studioUrl !== undefined) {
        logger.info(`  ➜  Studio:  ${studioUrl}`);
    }

    if (plan.codegenEnabled) {
        logger.info("  ➜  Codegen:    watching cirrus/");
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
 * When the Cirrus agent skills ("rules") aren't installed in the project, nudge
 * the developer (and any cloud/headless coding agent reading stdout) to install
 * them so the AI knows how to use Cirrus. Non-blocking — just one info line.
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
    /** Disposer for the materialized remote wrangler temp config (idempotent, never throws). */
    remoteCleanup?: () => void;
    studio?: StudioServerHandle;
}

/** Best-effort shutdown of the studio server, codegen watcher, and remote temp config. */
const teardown = async (handles: Teardown): Promise<void> => {
    handles.codegen?.close();
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
 * runs (CI) decline silently rather than block on a prompt.
 */
const offerDevVariablesScaffold = async (options: DevCommandOptions, cwd: string): Promise<void> => {
    await (options.ensureEnv ?? ensureDevVariables)({
        confirm: createConfirm(),
        cwd,
        info: (message) => {
            options.logger.info(message);
        },
    });
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
        await offerDevVariablesScaffold(options, cwd);

        logger.info("starting wrangler dev + studio");

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

        const worker = (options.startWorker ?? defaultWorkerSpawner)(plan.wrangler, logger);

        printBanner(logger, plan, studioUrl);
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
        await teardown(handles);
    }
};

/** `cirrus dev` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<DevOptions> = defineHandler<DevOptions>(({ cwd, logger, options }) =>
    runDevCommand({
        apiSpec: parseApiSpec(options.apiSpec),
        // cerebro parses `--no-codegen`/`--no-studio` as the negation of the
        // `codegen`/`studio` booleans (runtime key drops the `no-` prefix), so a
        // passed flag arrives as `false`, absent as `true` (the option default).
        codegen: options.codegen === false ? false : undefined,
        cwd,
        logger,
        port: options.port,
        // Remote-binding mode obeys a clear precedence: an explicit `--remote`
        // flag wins, then `CIRRUS_REMOTE` in the environment, then the `remote`
        // key in the project's `cirrus.json` (a project default). See
        // `resolveRemoteEnabled` in @cirrus/config.
        remote: resolveRemoteEnabled({
            configPreference: readProjectRemotePreference(cwd),
            envValue: process.env["CIRRUS_REMOTE"],
            flag: options.remote,
        }),
        studio: options.studio === false ? false : undefined,
        workerPort: options.workerPort,
    }),
);

export { execute };
export type { DevCommandOptions, DevCommandPlan, DevRemotePlan, WorkerProcess, WorkerSpawner };
export { planDevCommand, resolveRemotePlan, runDevCommand };
