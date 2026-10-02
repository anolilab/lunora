/** The options `lunora dev` takes and the plan it builds — shared by the planner, the supervisor and the package API. */
import type { ensureDevVariables, ensureDevVarsExample, fillDevSecrets } from "@lunora/config";
import type { materializeRemoteWranglerConfig } from "@lunora/config/cloudflare";

import type { ApiSpec } from "../../util/api-spec";
import type { startCodegenWatch } from "../../util/codegen-watch";
import type { ReadinessProbe } from "../../util/dev-probe";
import type { Logger } from "../../util/logger";
import type { SpawnDescriptor } from "../../util/spawn";
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
    /** Deploy target the emitted `ctx.*` surface is tailored to. Resolved by the caller; falls back to `"target"` in `lunora.config.*`, then `"cloudflare"`. */
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
     * `lunora.config` services (plan 457) to boot once, in order, before the
     * worker on a host whose dev server resolves a service binding from a local
     * deployment record (celld): each runs until it answers on the worker port,
     * which records it, and is then stopped. Absent for every other host.
     */
    serviceRegistrations?: ReadonlyArray<SpawnDescriptor & { name: string; tag: string }>;

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

export type { DevCommandOptions, DevCommandPlan, DevRemotePlan, WorkerProcess, WorkerSpawner };
