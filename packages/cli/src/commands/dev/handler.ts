import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { runCodegen } from "@lunora/codegen";
import type { ContainerLogStreamHandle } from "@lunora/config";
import {
    AGENT_RULES_HINT,
    claimAgentRulesHint,
    claimDevServerState,
    clearDevServerState,
    detectAgentRules,
    detectAiAgent,
    detectFramework,
    DEV_BINDINGS_FILE,
    DEV_DAEMON_ENV,
    DEV_HANDOFF_ENV,
    DEV_LOG_FILE_ENV,
    DEV_STATE_FILE,
    DEV_VARS_EXAMPLE_FILE,
    DEV_VARS_FILE,
    discoverContainerInfo,
    ensureDevVariables,
    ensureDevVarsExample,
    fillDevSecrets,
    formatLunoraEvent,
    inferLunoraBindings,
    isInteractive,
    packageNamesFromBindings,
    readLiveDevServerState,
    readProjectRemotePreference,
    resolveDeployDriver,
    resolveProjectTarget,
    streamContainerLogs,
    updateDevServerState,
} from "@lunora/config";
import { findWranglerFile, materializeRemoteWranglerConfig, readWranglerJsonc, resolveRemoteEnabled } from "@lunora/config/cloudflare";

import type { ApiSpec } from "../../util/api-spec";
import { parseApiSpec } from "../../util/api-spec";
import { writeBindingManifestFile } from "../../util/binding-manifest-file";
import type { CodegenWatcherHandle } from "../../util/codegen-watch";
import { startCodegenWatch } from "../../util/codegen-watch";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { resolveRunnableTargetOrError } from "../../util/deploy-target";
import { detectPackageManager, execArgsFor, runScriptCommand } from "../../util/detect-package-manager";
import type { ReadinessProbe } from "../../util/dev-probe";
import { findAvailablePort } from "../../util/free-port";
import type { Logger } from "../../util/logger";
import { forceJsonLogging } from "../../util/logger";
import { hasIpv6Loopback } from "../../util/loopback";
import type { SpawnDescriptor } from "../../util/spawn";
import { spawnShellCompat } from "../../util/spawn";
import type { StudioServerHandle } from "../../util/studio-server";
import { startStudioServer } from "../../util/studio-server";
import { createTuiConfirm } from "../../util/tui-prompts";
import markWorkerReadyWhenServing from "../../util/worker-ready";
import type { DevOptions } from "./index";
import type { DevFlavor } from "./lifecycle";
import {
    codegenRequested,
    detectDevFlavor,
    reportExistingServer,
    runLifecycleSubcommand,
    startBackground,
    viteDevCommand,
    withViteChildEnv,
} from "./lifecycle";

/**
 * The dev-only wrangler config the `framework-worker` sidecar runs (`wrangler dev
 * -c wrangler.dev.jsonc`). Committed in the SvelteKit / Nuxt templates: its
 * `main` is the Lunora-only `lunora/server.ts` worker (`.build()`, exporting
 * `ShardDO`), and its `dev.port` pins the sidecar port the framework front end
 * proxies to (SvelteKit) or the client points at (Nuxt). Kept separate from the
 * deploy `wrangler.jsonc` (whose `main` is the framework adapter's built output,
 * which doesn't exist in dev).
 */
const DEV_WRANGLER_CONFIG = "wrangler.dev.jsonc";

/** Default port the embedded studio server listens on (the URL you open). */
const DEFAULT_STUDIO_PORT = 6173;
/** Default port `wrangler dev` serves the worker on. */
const DEFAULT_WORKER_PORT = 8787;
/** Default port Vite serves on — the state record carries the real resolved URL. */
const DEFAULT_VITE_PORT = 5173;
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

    /**
     * Override where the binding manifest is written. One is always produced at
     * {@link DEV_BINDINGS_FILE}; naming a path also makes a derivation failure
     * fatal, since a named path means something is waiting on it.
     */
    emitBindings?: string;
    /** Injection seam for tests — defaults to the real `.dev.vars` scaffolder. */
    ensureEnv?: typeof ensureDevVariables;
    /** Injection seam for tests — defaults to the real `.dev.vars.example` package-aware scaffolder. */
    ensureExample?: typeof ensureDevVarsExample;
    /** Injection seam for tests — defaults to the real empty-secret/admin-token filler. */
    fillSecrets?: typeof fillDevSecrets;
    /** Injection seam for tests — defaults to the real free-port probe ({@link findAvailablePort}). */
    findFreePort?: (preferred: number) => Promise<number>;
    /** Dev flavor override (tests / callers that already detected it) — defaults to {@link detectDevFlavor}. */
    flavor?: DevFlavor;
    /** Injection seam for tests — defaults to the real IPv6-loopback probe ({@link hasIpv6Loopback}). */
    hasIpv6Loopback?: () => boolean;

    /**
     * Logs are NDJSON on stdout (`--json`, or a detected AI agent). Forwarded to
     * the codegen watcher so a `postcodegen` script's own stdout is routed to
     * stderr instead of corrupting the stream.
     */
    jsonLogs?: boolean;

    logger: Logger;
    /** Injection seam for tests — defaults to the real remote-config materializer. */
    materializeRemote?: typeof materializeRemoteWranglerConfig;
    /** Studio server port. */
    port?: number;
    /** Injection seam for tests — defaults to the real HTTP readiness probe. Without it the suite issues live GETs to the dev port. */
    probeReady?: ReadinessProbe;
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
    /** Deploy target the emitted `ctx.*` surface is tailored to. Resolved by the caller; falls back to `"target"` in `lunora.json`, then `"cloudflare"`. */
    target?: string;

    /**
     * Injection seam for tests — defaults to parking until SIGINT.
     *
     * Attached mode (`--no-worker`) ends only on a signal, so without this the
     * whole branch is unreachable from a test. That is how the readiness probe
     * came to be wired after the early return, reported for a flavor it never
     * covered, and shipped.
     */
    waitForInterrupt?: (logger: Logger) => Promise<number>;
    /** Disable the `wrangler dev` spawn — an external task runner owns the worker. */
    worker?: boolean;
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

    /**
     * True when `wrangler dev` was given `--ip 127.0.0.1` because the host has no
     * IPv6 loopback (`::1`) — surfaced so the dev loop can note the rebind.
     * Always `false` for the vite flavor (the plugin owns its own bind).
     */
    ipv4LoopbackForced: boolean;

    /** The remote-binding decision: which D1/KV/R2 bindings hit the deployed worker. */
    remote: DevRemotePlan;
    runsCodegenWatch: boolean;

    /**
     * The `wrangler dev` sidecar for the `framework-worker` flavor (SvelteKit /
     * Nuxt): a second child that owns the real `ShardDO` in `workerd`, wired via
     * the committed `wrangler.dev.jsonc`. `undefined` for every other flavor —
     * only the two-process class-B stack has a sidecar. When present, `wrangler`
     * (above) is the framework's own dev server (the front door / HMR) and this
     * is the Lunora realtime plane.
     */
    sidecar?: SpawnDescriptor & { tag: string };
    studioEnabled: boolean;

    studioPort: number;

    /**
     * Whether this process spawns `wrangler dev`.
     *
     * `--no-worker` turns it off so an external task runner (Turbo, Nx, vis, a
     * Procfile) can own worker supervision while `lunora dev` still provides
     * codegen-watch and Studio. Without it, `lunora dev` insisted on being the
     * process root, which is what blocked running the Lunora worker as one node
     * in a larger dev graph.
     */
    workerEnabled: boolean;
    workerOrigin: string;
    workerPort: number;
    /** The primary child `lunora dev` spawns: `wrangler dev` (wrangler flavor) or the framework/`vite dev` server (vite / framework-worker). */
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

/** Read `dev.ip` from one wrangler config file, or `undefined` when unset / the file doesn't parse. */
const readDevIp = (wranglerPath: string): unknown => readWranglerJsonc<{ dev?: { ip?: unknown } }>(wranglerPath).parsed?.dev?.ip;

/**
 * Extra `wrangler dev` args that pin the worker to the IPv4 loopback
 * (`--ip 127.0.0.1`) when the host has no IPv6 loopback (`::1`) — without which
 * `workerd`'s default `[::1]` bind aborts on startup with `Cannot assign
 * requested address`. Returns nothing (leaving wrangler's default) when the host
 * has `::1`, or when the wrangler config the `wrangler dev` process actually
 * runs with already pins `dev.ip` — an explicit user choice always wins over
 * the auto-detection.
 *
 * `sidecarConfigFile`, when given, names the config `wrangler dev` is actually
 * invoked with (e.g. the `framework-worker` flavor's sidecar runs `--config
 * wrangler.dev.jsonc`, not the project's default `wrangler.jsonc`) — it is
 * checked FIRST, since that's the file whose `dev.ip` the spawned process
 * would honor. The project's default wrangler config is still checked after
 * (a `dev.ip` pinned there is a reasonable project-wide default), but a
 * `dev.ip` in the wrong file must never suppress the flag the sidecar actually
 * needs.
 */
const resolveLoopbackArgs = (cwd: string, hasLoopback: () => boolean, sidecarConfigFile?: string): string[] => {
    if (sidecarConfigFile !== undefined) {
        const sidecarConfigPath = join(cwd, sidecarConfigFile);

        if (existsSync(sidecarConfigPath) && readDevIp(sidecarConfigPath) !== undefined) {
            return [];
        }
    }

    const wranglerPath = findWranglerFile(cwd);

    if (wranglerPath !== undefined && readDevIp(wranglerPath) !== undefined) {
        return [];
    }

    return hasLoopback() ? [] : ["--ip", "127.0.0.1"];
};

/**
 * Resolve the port `wrangler dev` binds, so Lunora knows the worker origin up
 * front (the studio proxies to it). Precedence — an explicit choice always wins:
 *
 * 1. `--port` / `--worker-port` on the CLI (`options.workerPort`).
 * 2. `dev.port` pinned in the project's wrangler config.
 * 3. The first free port at/above 8787.
 *
 * Step 3 restores the free-port fallback that a fixed `--port` would otherwise
 * disable: `wrangler dev` only auto-probes for an open port when none is passed,
 * so without this two projects both defaulting to 8787 would collide (the second
 * crashing with `EADDRINUSE`) instead of the second one landing on 8788.
 */
const resolveWorkerPort = async (options: DevCommandOptions, cwd: string): Promise<number> => {
    if (options.workerPort !== undefined) {
        return options.workerPort;
    }

    const wranglerPath = findWranglerFile(cwd);

    if (wranglerPath !== undefined) {
        const { parsed } = readWranglerJsonc<{ dev?: { port?: unknown } }>(wranglerPath);

        if (typeof parsed?.dev?.port === "number") {
            return parsed.dev.port;
        }
    }

    return (options.findFreePort ?? findAvailablePort)(DEFAULT_WORKER_PORT);
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

    if (flavor === "vite" || flavor === "framework-worker") {
        // `@lunora/vite` already runs the worker + studio + codegen (and remote
        // bindings, dev vars, container logs) inside the Vite dev server — the
        // CLI's own siblings would duplicate them, so they're all disabled and
        // the primary child is the project's own dev server. Remote mode is
        // forwarded as env (`LUNORA_REMOTE=1`) for the plugin's remote-bindings
        // handling; no temp wrangler config is materialized here. The Vite
        // plugin writes the authoritative `.lunora/dev.json` (real resolved URL
        // + Vite's PID) once the server listens; `workerOrigin` is only the
        // pre-listen default.
        const exec = viteDevCommand(cwd);

        // The `framework-worker` flavor (SvelteKit / Nuxt) adds a `wrangler dev`
        // sidecar that owns the real `ShardDO`, run from the committed
        // `wrangler.dev.jsonc` (its `dev.port` pins the port). On a host without
        // IPv6 loopback, prepend `--ip 127.0.0.1` so workerd doesn't abort
        // binding its default `[::1]`. `--var WORKER_ENV:development` streams the
        // sidecar's RPC dispatch summaries to the terminal (mirrors the wrangler
        // flavor). One-shot codegen runs in `runDevCommand` before the sidecar
        // spawns, so `lunora/server.ts`'s `_generated` imports resolve.
        let sidecar: (SpawnDescriptor & { tag: string }) | undefined;

        if (flavor === "framework-worker") {
            // The sidecar runs `--config wrangler.dev.jsonc`, not the deploy
            // `wrangler.jsonc` — check its own `dev.ip` first.
            const loopbackArgs = resolveLoopbackArgs(cwd, options.hasIpv6Loopback ?? hasIpv6Loopback, DEV_WRANGLER_CONFIG);
            // The toolchain is the target's, not always wrangler's — resolving from the
            // project keeps a non-default target from shelling out to the wrong CLI.
            const devCommand = resolveDeployDriver(resolveProjectTarget(cwd)).toolchain?.dev({
                configPath: DEV_WRANGLER_CONFIG,
                extraArgs: [...loopbackArgs, "--var", "WORKER_ENV:development"],
            });
            const sidecarExec = execArgsFor(manager, devCommand?.tool ?? "wrangler", devCommand?.args ?? []);

            sidecar = { args: sidecarExec.args, command: sidecarExec.command, cwd, tag: "worker" };
        }

        if (options.worker === false) {
            options.logger.warn(
                `--no-worker does not apply to the ${flavor} flavor: Vite owns the worker, codegen and studio in-process. Run your framework's dev script instead.`,
            );
        }

        return {
            runsCodegenWatch: false,
            flavor,
            ipv4LoopbackForced: false,
            remote: { bindings: [], cleanup: () => {}, enabled: options.remote === true },
            ...(sidecar ? { sidecar } : {}),
            studioEnabled: false,
            studioPort: options.port ?? DEFAULT_STUDIO_PORT,
            // Always true here. On these flavors the child is the FRAMEWORK dev
            // server (Vite runs the worker, codegen and studio in-process), not
            // the standalone `wrangler dev` this command owns — so there is
            // nothing for `--no-worker` to hand to an external runner, and
            // honouring it would park the process having started nothing.
            workerEnabled: true,
            workerOrigin: `http://localhost:${String(DEFAULT_VITE_PORT)}`,
            workerPort: DEFAULT_VITE_PORT,
            wrangler: {
                args: exec.args,
                command: exec.command,
                cwd,
                ...withViteChildEnv(options),
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
    // On a host without IPv6 loopback, prepend `--ip 127.0.0.1` so workerd doesn't
    // abort trying to bind its default `[::1]` (see resolveLoopbackArgs).
    const loopbackArgs = resolveLoopbackArgs(cwd, options.hasIpv6Loopback ?? hasIpv6Loopback);
    const exec = execArgsFor(manager, "wrangler", ["dev", "--port", String(workerPort), ...loopbackArgs, "--var", "WORKER_ENV:development", ...remote.args]);

    return {
        runsCodegenWatch: codegenRequested(options),
        flavor,
        frameworkHint,
        ipv4LoopbackForced: loopbackArgs.length > 0,
        remote: remote.plan,
        studioEnabled: options.studio !== false,
        studioPort: options.port ?? DEFAULT_STUDIO_PORT,
        workerEnabled: options.worker !== false,
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
    // Windows can't spawn the package-manager .cmd shims without a shell — see
    // spawnShellCompat. POSIX passes through untouched.
    const exec = spawnShellCompat(descriptor.command, descriptor.args);
    const child = nodeSpawn(exec.command, exec.args, {
        cwd: descriptor.cwd ?? process.cwd(),
        env: descriptor.env ? { ...process.env, ...descriptor.env } : process.env,
        shell: exec.shell,
        stdio: ["inherit", "pipe", "pipe"],
    });

    pipeChildOutput(child, descriptor.tag, logger);

    return {
        exited: new Promise<number>((resolve) => {
            child.on("error", (error) => {
                logger.error(`[${descriptor.tag}] failed to start: ${error.message}`);
                resolve(1);
            });
            child.on("exit", (code, signal) => {
                // A signal-killed child reports `code === null`; treat that as a
                // failure rather than a clean exit, matching `util/spawn.ts` and
                // `lifecycle.ts`. An OOM-SIGKILLed or segfaulting `wrangler dev`
                // used to make `lunora dev` exit 0, so a task runner supervising
                // it saw a crashed worker as a successful run.
                resolve(code ?? (signal ? 1 : 0));
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

interface Teardown {
    codegen?: CodegenWatcherHandle;
    /** Disposer for the dev container log stream (stops polling Docker + detaches). */
    containerLogs?: ContainerLogStreamHandle;
    /** Cancels the worker readiness probe, so it stops with the server instead of on its own timeout. */
    readyProbe?: AbortController;
    /** Disposer for the materialized remote wrangler temp config (idempotent, never throws). */
    remoteCleanup?: () => void;
    studio?: StudioServerHandle;
}

/**
 * Follow the local Docker logs of every declared container and surface each
 * output line on the dev logger, tagged `[container:<name>]`. Returns a disposer
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
    // Idempotent second call: `runDevCommand`'s `finally` aborts before clearing
    // the state record, and this covers the paths that tear down without going
    // through it. `AbortController.abort()` on an already-aborted controller is a
    // no-op.
    handles.readyProbe?.abort();

    // Awaited: `close()` stops the watch loop immediately but resolves only once
    // a regeneration already in flight is done, and that run may have spawned
    // the project's `postcodegen`. `defineHandler` calls `process.exit` right
    // after this, so not awaiting leaves that child running, mid-write, against
    // a shell that already has its prompt back — the terminal Ctrl-C case is
    // covered by the signal reaching the whole process group, but a worker crash
    // or a SIGTERM to the daemon PID is not.
    await handles.codegen?.close().catch(() => undefined);
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
 * Resolve the worker port (a free-port probe for the wrangler flavor, so the
 * origin stays deterministic without pinning a busy 8787) and build the dev
 * plan. Extracted from {@link runDevCommand} so its startup orchestration stays
 * legible — the async port resolution is the only reason planning isn't inline.
 */
const buildDevPlan = async (options: DevCommandOptions): Promise<DevCommandPlan> => {
    const cwd = options.cwd ?? process.cwd();
    const flavor = options.flavor ?? detectDevFlavor(cwd);
    // The vite flavor lets Vite resolve its own port; only the wrangler flavor
    // needs a pre-picked free port passed through as `--port`.
    const workerPort = flavor === "wrangler" ? await resolveWorkerPort(options, cwd) : options.workerPort;

    return planDevCommand({ ...options, cwd, flavor, workerPort });
};

/**
 * Block until SIGINT/SIGTERM, then resolve 0.
 *
 * The `--no-worker` counterpart to {@link superviseWorkers}: with no child to
 * await, the process would otherwise fall out of `runDevCommand` immediately
 * and take codegen-watch and Studio down with it.
 */
const waitForInterrupt = async (logger: Logger): Promise<number> =>
    await new Promise<number>((resolve) => {
        // Held in a record so `stop` can detach both handlers without a forward
        // reference to bindings declared after it.
        const handlers: { sigint?: () => void; sigterm?: () => void } = {};

        const stop = (signal: NodeJS.Signals): void => {
            logger.info(`received ${signal} — shutting down`);

            if (handlers.sigint) {
                process.off("SIGINT", handlers.sigint);
            }

            if (handlers.sigterm) {
                process.off("SIGTERM", handlers.sigterm);
            }

            resolve(0);
        };

        const onSigint = (): void => {
            stop("SIGINT");
        };
        const onSigterm = (): void => {
            stop("SIGTERM");
        };

        handlers.sigint = onSigint;
        handlers.sigterm = onSigterm;
        process.on("SIGINT", onSigint);
        process.on("SIGTERM", onSigterm);
    });

/**
 * Supervise the spawned dev children until dev ends. Wires SIGINT/SIGTERM to
 * signal BOTH the framework dev server and the sidecar together (Ctrl-C once →
 * SIGTERM, again → SIGKILL; a grace timer escalates the first SIGINT), then
 * resolves when the FIRST child exits — a stopped framework dev server and a
 * crashed sidecar both mean "dev is over" — tearing the other down and awaiting
 * it so neither is orphaned holding a port. Returns that first child's exit
 * code. With no sidecar (single-process flavors) this collapses to plain
 * single-child supervision. Extracted from {@link runDevCommand} to keep its
 * orchestration legible (and under the cognitive-complexity budget).
 */
const superviseWorkers = async (worker: WorkerProcess, sidecar: WorkerProcess | undefined, logger: Logger): Promise<number> => {
    let sigintCount = 0;
    let escalationTimer: NodeJS.Timeout | undefined;

    const killChildren = (signal: NodeJS.Signals): void => {
        worker.kill(signal);
        sidecar?.kill(signal);
    };
    const onSigint = (): void => {
        sigintCount += 1;

        if (sigintCount === 1) {
            logger.info("received SIGINT — shutting down (press Ctrl-C again to force-kill)");
            killChildren("SIGTERM");
            escalationTimer = setTimeout(() => {
                killChildren("SIGKILL");
            }, SIGINT_GRACE_MS);
            escalationTimer.unref();
        } else {
            killChildren("SIGKILL");
        }
    };
    const onSigterm = (): void => {
        killChildren("SIGTERM");
    };

    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    const first = await Promise.race([
        worker.exited.then((code) => {
            return { code, who: "worker" as const };
        }),
        ...(sidecar === undefined
            ? []
            : [
                  sidecar.exited.then((code) => {
                      return { code, who: "sidecar" as const };
                  }),
              ]),
    ]);

    if (sidecar !== undefined) {
        if (first.who === "sidecar") {
            logger.warn("[worker] the Lunora sidecar (wrangler dev) exited — shutting down the framework dev server");
            worker.kill("SIGTERM");
        } else {
            sidecar.kill("SIGTERM");
        }

        await Promise.allSettled([worker.exited, sidecar.exited]);
    }

    if (escalationTimer) {
        clearTimeout(escalationTimer);
    }

    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);

    return first.code;
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

/**
 * Start codegen watch + the studio server, spawn `wrangler dev`, print the
 * banner, and resolve when the worker exits or the user interrupts — tearing
 * down the sibling servers either way. The three side-effecting pieces (worker,
 * studio, codegen) are injectable so this is testable without real I/O.
 */
const runDevCommand = async (options: DevCommandOptions): Promise<{ code: number; plan: DevCommandPlan }> => {
    const plan = await buildDevPlan(options);
    const { logger } = options;
    const cwd = plan.wrangler.cwd ?? process.cwd();
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
    const resolvedTarget = resolveRunnableTargetOrError(cwd, options.target);

    if (resolvedTarget.target === undefined) {
        throw new Error(resolvedTarget.error ?? "unknown deploy target");
    }

    const { target } = resolvedTarget;
    // Register the remote temp-config disposer up front so it's torn down on
    // every exit path — including a throw during startup below (the `finally`).
    const handles: Teardown = { remoteCleanup: plan.remote.cleanup };

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

        logger.info(
            plan.flavor === "vite" ? "starting vite dev (worker + studio + codegen run inside Vite via @lunora/vite)" : "starting wrangler dev + studio",
        );

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

            return { code: 1, plan };
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

            return { code: await (options.waitForInterrupt ?? waitForInterrupt)(logger), plan };
        }

        ensureSidecarGenerated(plan, options, cwd, logger, target);

        const spawn = options.startWorker ?? defaultWorkerSpawner;
        const worker = spawn(plan.wrangler, logger);
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
        emitBindings: options.emitBindings,
        jsonLogs,
        logger,
        port: options.port,
        remote,
        studio: options.studio === false ? false : undefined,
        target: options.target,
        workerPort: options.workerPort,
    });
});

export { execute };
export type { DevCommandOptions, DevCommandPlan, DevRemotePlan, WorkerProcess, WorkerSpawner };
// `DevFlavor` / `detectDevFlavor` live in `./lifecycle`; re-exported here so the
// planning surface (`planDevCommand` and friends) stays importable from one module.
export type { DevFlavor } from "./lifecycle";
export { detectDevFlavor } from "./lifecycle";
export { defaultWorkerSpawner, planDevCommand, resolveWorkerPort, runDevCommand };
