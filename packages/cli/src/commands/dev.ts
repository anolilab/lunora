import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";

import type { CodegenWatcherHandle } from "../util/codegen-watch.js";
import { startCodegenWatch } from "../util/codegen-watch.js";
import type { DashboardServerHandle } from "../util/dashboard-server.js";
import { startDashboardServer } from "../util/dashboard-server.js";
import { detectPackageManager, execArgsFor } from "../util/detect-package-manager.js";
import type { Logger } from "../util/logger.js";
import type { SpawnDescriptor } from "../util/spawn.js";

/** Default port the embedded dashboard server listens on (the URL you open). */
const DEFAULT_DASHBOARD_PORT = 6173;
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
    /** Disable the codegen watch loop. */
    codegen?: boolean;
    cwd?: string;
    /** Disable the embedded dashboard server. */
    dashboard?: boolean;
    logger: Logger;
    /** Dashboard server port. */
    port?: number;
    /** Injection seam for tests — defaults to the real codegen watcher. */
    startCodegen?: typeof startCodegenWatch;
    /** Injection seam for tests — defaults to the real dashboard server. */
    startDashboard?: typeof startDashboardServer;
    /** Injection seam for tests — defaults to spawning a real `wrangler dev`. */
    startWorker?: WorkerSpawner;
    /** `wrangler dev` port. */
    workerPort?: number;
}

interface DevCommandPlan {
    codegenEnabled: boolean;
    dashboardEnabled: boolean;
    dashboardPort: number;
    workerOrigin: string;
    workerPort: number;
    /** The single child process `cirrus dev` spawns: `wrangler dev`. */
    wrangler: SpawnDescriptor & { tag: string };
}

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
    const exec = execArgsFor(manager, "wrangler", ["dev", "--port", String(workerPort)]);

    return {
        codegenEnabled: options.codegen !== false,
        dashboardEnabled: options.dashboard !== false,
        dashboardPort: options.port ?? DEFAULT_DASHBOARD_PORT,
        workerOrigin: `http://localhost:${String(workerPort)}`,
        workerPort,
        wrangler: { args: exec.args, command: exec.command, cwd, tag: "wrangler" },
    };
};

/** Pipe a child's stdout/stderr through the logger, tagged by name. */
const pipeChildOutput = (child: ChildProcess, tag: string, logger: Logger): void => {
    const onLine = (chunk: Buffer, kind: "stderr" | "stdout"): void => {
        const text = chunk.toString("utf8").trimEnd();

        if (text.length === 0) {
            return;
        }

        for (const line of text.split("\n")) {
            const prefixed = `[${tag}] ${line}`;

            if (kind === "stderr") {
                logger.warn(prefixed);
            } else {
                logger.info(prefixed);
            }
        }
    };

    child.stdout?.on("data", (chunk: Buffer) => { onLine(chunk, "stdout"); });
    child.stderr?.on("data", (chunk: Buffer) => { onLine(chunk, "stderr"); });
};

/** Real worker spawner: runs the descriptor as a child and pipes its output through the logger. */
const defaultWorkerSpawner: WorkerSpawner = (descriptor, logger) => {
    const child = nodeSpawn(descriptor.command, [...descriptor.args], { cwd: descriptor.cwd ?? process.cwd(), env: process.env, stdio: ["inherit", "pipe", "pipe"] });

    pipeChildOutput(child, descriptor.tag, logger);

    return {
        exited: new Promise<number>((resolve) => {
            child.on("error", (error) => {
                logger.error(`[${descriptor.tag}] failed to start: ${error.message}`);
                resolve(1);
            });
            child.on("exit", (code) => { resolve(code ?? 0); });
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

/** Print the Convex-style startup banner once the dashboard + worker URLs are known. */
const printBanner = (logger: Logger, plan: DevCommandPlan, dashboardUrl: string | undefined): void => {
    logger.info("");
    logger.success("Cirrus dev");
    logger.info(`  ➜  Worker:     ${plan.workerOrigin}`);

    if (dashboardUrl !== undefined) {
        logger.info(`  ➜  Dashboard:  ${dashboardUrl}`);
    }

    if (plan.codegenEnabled) {
        logger.info("  ➜  Codegen:    watching cirrus/");
    }

    logger.info("");
};

interface Teardown {
    codegen?: CodegenWatcherHandle;
    dashboard?: DashboardServerHandle;
}

/** Best-effort shutdown of the dashboard server + codegen watcher. */
const teardown = async (handles: Teardown): Promise<void> => {
    handles.codegen?.close();
    await handles.dashboard?.close().catch(() => undefined);
};

/**
 * Start codegen watch + the dashboard server, spawn `wrangler dev`, print the
 * banner, and resolve when the worker exits or the user interrupts — tearing
 * down the sibling servers either way. The three side-effecting pieces (worker,
 * dashboard, codegen) are injectable so this is testable without real I/O.
 */
const runDevCommand = async (options: DevCommandOptions): Promise<{ code: number; plan: DevCommandPlan }> => {
    const plan = planDevCommand(options);
    const { logger } = options;
    const cwd = plan.wrangler.cwd ?? process.cwd();
    const handles: Teardown = {};

    logger.info("starting wrangler dev + dashboard");

    if (plan.codegenEnabled) {
        handles.codegen = (options.startCodegen ?? startCodegenWatch)({ logger, projectRoot: cwd });
    }

    let dashboardUrl: string | undefined;

    if (plan.dashboardEnabled) {
        try {
            handles.dashboard = await (options.startDashboard ?? startDashboardServer)({
                cwd,
                logger: { warnOnce: (message) => { logger.warn(message); } },
                port: plan.dashboardPort,
                workerOrigin: plan.workerOrigin,
            });
            dashboardUrl = handles.dashboard.url;
        } catch (error: unknown) {
            logger.warn(`dashboard server failed to start (${error instanceof Error ? error.message : String(error)}) — continuing without it`);
        }
    }

    const worker = (options.startWorker ?? defaultWorkerSpawner)(plan.wrangler, logger);

    printBanner(logger, plan, dashboardUrl);

    let sigintCount = 0;
    let escalationTimer: NodeJS.Timeout | undefined;

    const onSigint = (): void => {
        sigintCount += 1;

        if (sigintCount === 1) {
            logger.info("received SIGINT — shutting down (press Ctrl-C again to force-kill)");
            worker.kill("SIGTERM");
            escalationTimer = setTimeout(() => { worker.kill("SIGKILL"); }, SIGINT_GRACE_MS);
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

    await teardown(handles);

    return { code, plan };
};

export type { DevCommandOptions, DevCommandPlan, WorkerProcess, WorkerSpawner };
export { planDevCommand, runDevCommand };
