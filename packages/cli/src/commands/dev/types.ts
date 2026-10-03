/** The options `lunora dev` takes and the plan it builds — shared by the planner, the supervisor and the package API. */
import type { ensureDevVariables, ensureDevVarsExample, fillDevSecrets, startCelldDevSession } from "@lunora/config";
import type { materializeRemoteWranglerConfig, materializeServiceDevConfigs } from "@lunora/config/cloudflare";

import type { ApiSpec } from "../../util/api-spec";
import type { startCodegenWatch } from "../../util/codegen-watch";
import type { ReadinessProbe } from "../../util/dev-probe";
import type { Logger } from "../../util/logger";
import type { SpawnDescriptor, Spawner } from "../../util/spawn";
import type { startStudioServer } from "../../util/studio-server";
import type { DevFlavor } from "./lifecycle";

/** A running worker child the orchestrator controls: send signals, await its exit. */
interface WorkerProcess {
    /** Resolves with the worker's exit code (1 if it failed to start). */
    exited: Promise<number>;
    kill: (signal: NodeJS.Signals) => void;
}

/** Spawns the worker child. Injectable so tests drive the orchestration without a real process. */
type WorkerSpawner = (descriptor: SpawnDescriptor & { tag: string }, logger: Logger) => WorkerProcess;

/** What a long-lived child runs: the one-shot descriptor's command/args/cwd/env, plus how to spawn it. */
interface LongLivedDescriptor {
    args: ReadonlyArray<string>;
    command: string;
    cwd?: string;
    /** A real executable, never a package-manager shim — spawned without a shell, with stdin ignored. */
    direct?: boolean;
    env?: Readonly<Record<string, string>>;
}

/** Spawns a long-lived child and streams its output line by line. Injectable for tests. */
type LongLivedSpawner = (
    descriptor: LongLivedDescriptor,
    onLine: (line: string, kind: "stderr" | "stdout") => void,
    onError?: (error: Error) => void,
) => WorkerProcess;

/** A `--tunnel` request, built once from the parsed flags. */
interface DevTunnelRequest {
    /** Normalized `--allow-mail` entries, passed to cloudflared as `--allowed-mail`; empty opens a PUBLIC tunnel. */
    allowMail: ReadonlyArray<string>;
    /** Injection seam for tests — the one-shot spawner the `cloudflared --version` probe runs through. */
    spawner?: Spawner;
    /** Injection seam for tests — starts the long-lived `cloudflared tunnel` child. */
    startChild?: LongLivedSpawner;
}

interface DevCommandOptions {
    /** Which API spec(s) the codegen watcher emits. Defaults to codegen's `"openapi"` when omitted. */
    apiSpec?: ApiSpec;
    /** Disable the codegen watch loop. */
    codegen?: boolean;
    cwd?: string;

    /**
     * Override where the binding manifest is written. One is always produced at
     * `DEV_BINDINGS_FILE`; naming a path also makes a derivation failure
     * fatal, since a named path means something is waiting on it.
     */
    emitBindings?: string;
    /** Injection seam for tests — defaults to the real `.dev.vars` scaffolder. */
    ensureEnv?: typeof ensureDevVariables;
    /** Injection seam for tests — defaults to the real `.dev.vars.example` package-aware scaffolder. */
    ensureExample?: typeof ensureDevVarsExample;
    /** Injection seam for tests — defaults to the real empty-secret/admin-token filler. */
    fillSecrets?: typeof fillDevSecrets;
    /** Injection seam for tests — defaults to the real free-port probe (`findAvailablePort`). */
    findFreePort?: (preferred: number) => Promise<number>;
    /** Dev flavor override (tests / callers that already detected it) — defaults to `detectDevFlavor`. */
    flavor?: DevFlavor;
    /** Injection seam for tests — defaults to the real IPv6-loopback probe (`hasIpv6Loopback`). */
    hasIpv6Loopback?: () => boolean;
    /** `wrangler dev` devtools inspector port (`--inspector-port`). Wrangler flavor only — see `resolveInspectorPort`. */
    inspectorPort?: number;

    /**
     * Logs are NDJSON on stdout (`--json`, or a detected AI agent). Forwarded to
     * the codegen watcher so a `postcodegen` script's own stdout is routed to
     * stderr instead of corrupting the stream.
     */
    jsonLogs?: boolean;

    /** Pass `--local` to `wrangler dev`: no remote proxy session, so a binding with no local mode (`ai`) cannot stop the session from starting. */
    local?: boolean;
    logger: Logger;
    /** Injection seam for tests — defaults to the real remote-config materializer. */
    materializeRemote?: typeof materializeRemoteWranglerConfig;
    /** Injection seam for tests — defaults to the real per-service dev-config materializer. */
    materializeServiceConfigs?: typeof materializeServiceDevConfigs;
    /** Studio server port. */
    port?: number;
    /** Injection seam for tests — defaults to the real HTTP readiness probe. Without it the suite issues live GETs to the dev port. */
    probeReady?: ReadinessProbe;
    /** Proxy D1/KV/R2 bindings to the deployed worker during dev (`LUNORA_REMOTE=1` / `--remote`); DO shards stay local. */
    remote?: boolean;
    /** Starts the celld dev session for the celld target; injected in tests. */
    startCelldSession?: typeof startCelldDevSession;
    /** Injection seam for tests — defaults to the real codegen watcher. */
    startCodegen?: typeof startCodegenWatch;
    /** Injection seam for tests — defaults to the real studio server. */
    startStudio?: typeof startStudioServer;
    /** Injection seam for tests — defaults to spawning a real `wrangler dev`. */
    startWorker?: WorkerSpawner;

    /** Disable the embedded studio server. */
    studio?: boolean;
    /** Deploy target the emitted `ctx.*` surface is tailored to. Resolved by the caller; falls back to `"target"` in `lunora.config.*`, then `"cloudflare"`. */
    target?: string;

    /** `--tunnel`: share the worker's origin through a Cloudflare quick tunnel. Absent means no tunnel. */
    tunnel?: DevTunnelRequest;

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
    /**
     * `true` when the worker is a celld dev session (a target running its own
     * dev server) rather than {@link DevCommandPlan.wrangler}'s process: services
     * registered first, a service edit re-registering it and restarting the app.
     */
    celldSession?: true;

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
     * Unlinks the copies of service configs written so a service's custom build
     * runs in its own folder (`materializeServiceDevConfigs`). Idempotent; absent
     * for a flavor that runs no services through a `wrangler dev` of its own.
     */
    serviceConfigCleanup?: () => void;

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

export type { DevCommandOptions, DevCommandPlan, DevRemotePlan, DevTunnelRequest, LongLivedDescriptor, LongLivedSpawner, WorkerProcess, WorkerSpawner };
