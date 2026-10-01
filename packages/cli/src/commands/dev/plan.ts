/**
 * Planning `lunora dev`: the worker and inspector ports, the loopback and
 * `--remote` resolution, the framework sidecar, and the per-flavor plan.
 * Pure apart from the port probes, so it is unit-testable.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readServiceBindings } from "@lunora/codegen";
import { detectFramework, DEV_VARS_FILE, parseDevVariableEntries, resolveDeployDriver, resolveProjectTarget, targetRunsOwnDevServer } from "@lunora/config";
import { findWranglerFile, materializeRemoteWranglerConfig, readWranglerJsonc } from "@lunora/config/cloudflare";

import { detectPackageManager, execArgsFor, runScriptCommand, toolchainExecArgs } from "../../util/detect-package-manager";
import { findAvailablePort } from "../../util/free-port";
import { hasIpv6Loopback } from "../../util/loopback";
import type { SpawnDescriptor } from "../../util/spawn";
import { codegenRequested, detectDevFlavor, viteDevCommand, withViteChildEnv } from "./lifecycle";
import { planOwnDevServer } from "./own-dev-server";
import type { DevCommandOptions, DevCommandPlan, DevRemotePlan } from "./types";

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
 * Extra `--config` args that run each `lunora.config` service (plan 457) in the
 * same `wrangler dev` session, so the app's `services[]` bindings resolve to
 * the local Workers. wrangler treats the first `--config` as the primary
 * Worker, so the app's own config leads when no remote temp config already
 * does. A declaration codegen rejects adds nothing here; codegen reports it.
 */
const resolveServiceArgs = (cwd: string, remoteArgs: ReadonlyArray<string>): string[] => {
    const { services } = readServiceBindings(cwd);
    const primary = findWranglerFile(cwd);

    if (services.length === 0 || primary === undefined) {
        return [];
    }

    return [...(remoteArgs.length > 0 ? [] : ["--config", primary]), ...services.flatMap((service) => ["--config", service.wranglerPath])];
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

/** Hosts a `.dev.vars` origin can name that resolve to this machine. */
const LOOPBACK_ORIGIN_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/**
 * `.dev.vars` keys whose value is a loopback origin on `port` — i.e. the keys
 * that pin the project to the worker serving there. `AUTH_URL`,
 * `BETTER_AUTH_URL` and the templates' app-origin vars are all written as
 * `http://localhost:8787` by the scaffolds.
 */
const devVariablesPinningPort = (cwd: string, port: number): string[] => {
    let content: string;

    try {
        content = readFileSync(join(cwd, DEV_VARS_FILE), "utf8");
    } catch {
        // No `.dev.vars` (or unreadable) — nothing is pinned.
        return [];
    }

    const pinned: string[] = [];

    for (const entry of parseDevVariableEntries(content)) {
        let parsed: URL;

        try {
            parsed = new URL(entry.value);
        } catch {
            continue;
        }

        if (LOOPBACK_ORIGIN_HOSTS.has(parsed.hostname) && parsed.port === String(port)) {
            pinned.push(entry.key);
        }
    }

    return pinned;
};

/**
 * Resolve the port `wrangler dev` binds, so Lunora knows the worker origin up
 * front (the studio proxies to it). Precedence — an explicit choice always wins:
 *
 * 1. `--worker-port` on the CLI (`options.workerPort`).
 * 2. `dev.port` pinned in the project's wrangler config.
 * 3. The first free port at/above 8787.
 *
 * Step 3 restores the free-port fallback that a fixed port would otherwise
 * disable: `wrangler dev` only auto-probes for an open port when none is passed,
 * so without this two projects both defaulting to 8787 would collide (the second
 * crashing with `EADDRINUSE`) instead of the second one landing on 8788.
 *
 * That fallback is silent, though, and a project whose `.dev.vars` names
 * `http://localhost:8787` has committed to that port: OAuth callbacks and the
 * client's own origin are registered against it, and a worker on 8788 answers
 * none of them. Refuse rather than drift, naming the keys that disagree —
 * `--worker-port` is the escape when the operator means it. Projects that pin
 * nothing keep the silent fallback, which is the case it was added for.
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

    const port = await (options.findFreePort ?? findAvailablePort)(DEFAULT_WORKER_PORT);

    if (port === DEFAULT_WORKER_PORT) {
        return port;
    }

    const pinned = devVariablesPinningPort(cwd, DEFAULT_WORKER_PORT);

    if (pinned.length > 0) {
        throw new Error(
            `port ${String(DEFAULT_WORKER_PORT)} is in use, but ${DEV_VARS_FILE} pins the worker origin to it (${pinned.join(", ")}). ` +
                `Serving on ${String(port)} would leave those URLs pointing at nothing. Stop whatever holds ${String(DEFAULT_WORKER_PORT)}, ` +
                `or run \`lunora dev --worker-port ${String(port)}\` and update those values to match.`,
        );
    }

    return port;
};

/**
 * Resolve the port `wrangler dev` exposes its devtools inspector on. Precedence
 * mirrors {@link resolveWorkerPort} — an explicit choice always wins:
 *
 * 1. `--inspector-port` on the CLI (`options.inspectorPort`).
 * 2. `dev.inspector_port` pinned in the project's wrangler config.
 * 3. `undefined` — no `--inspector-port` reaches wrangler, which keeps its own default: 9229, probing upward while that is taken.
 *
 * Step 3 is deliberately NOT the free-port probe the worker port falls back to.
 * Wrangler already walks upward on its own, and pinning a port from here would
 * claim one nothing asked for. The walk is what makes this worth configuring at
 * all: in a repo where other `wrangler dev` processes pin 9230+ in their own dev
 * scripts, an unpinned inspector climbs into one of THEIR ports and kills a
 * worker that named the port in its config — so the fix is to make pinning
 * possible, not to start pinning by default.
 */
const resolveInspectorPort = (options: DevCommandOptions, cwd: string): number | undefined => {
    if (options.inspectorPort !== undefined) {
        return options.inspectorPort;
    }

    const wranglerPath = findWranglerFile(cwd);

    if (wranglerPath === undefined) {
        return undefined;
    }

    const { parsed } = readWranglerJsonc<{ dev?: { inspector_port?: unknown } }>(wranglerPath);
    const pinned = parsed?.dev?.inspector_port;

    return typeof pinned === "number" ? pinned : undefined;
};

/**
 * The `framework-worker` flavor's `wrangler dev` sidecar, run from the
 * committed `wrangler.dev.jsonc`.
 */
const planWorkerSidecar = (options: DevCommandOptions, cwd: string, manager: ReturnType<typeof detectPackageManager>): SpawnDescriptor & { tag: string } => {
    // The sidecar runs `--config wrangler.dev.jsonc`, not the deploy
    // `wrangler.jsonc` — check its own `dev.ip` first.
    const loopbackArgs = resolveLoopbackArgs(cwd, options.hasIpv6Loopback ?? hasIpv6Loopback, DEV_WRANGLER_CONFIG);
    // The toolchain is the target's, not always wrangler's. `options.target` is
    // the resolved target when `runDevCommand` plans; the config's otherwise,
    // for a direct caller.
    const driver = resolveDeployDriver(options.target ?? resolveProjectTarget(cwd));

    // `runDevCommand` refuses a toolchain-less target before planning, so this
    // only guards a direct caller — and must not fall back to a bare `wrangler`.
    if (driver.toolchain === undefined) {
        throw new Error(`deploy target "${driver.id}" has no dev server to run the worker sidecar`);
    }

    const devCommand = driver.toolchain.dev({
        configPath: DEV_WRANGLER_CONFIG,
        extraArgs: [...loopbackArgs, "--var", "WORKER_ENV:development"],
    });
    const exec = toolchainExecArgs(manager, devCommand);

    return { args: exec.args, command: exec.command, cwd, tag: "worker" };
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
            sidecar = planWorkerSidecar(options, cwd, manager);
        }

        if (options.worker === false) {
            options.logger.warn(
                `--no-worker does not apply to the ${flavor} flavor: Vite owns the worker, codegen and studio in-process. Run your framework's dev script instead.`,
            );
        }

        // `--inspector-port` is a `wrangler dev` flag and this branch spawns no
        // `wrangler dev` of its own, so say where the knob actually lives rather
        // than accepting the flag and dropping it.
        if (options.inspectorPort !== undefined) {
            options.logger.warn(
                flavor === "framework-worker"
                    ? `--inspector-port does not apply to the ${flavor} flavor: pin \`dev.inspector_port\` in ${DEV_WRANGLER_CONFIG} — that is the config the worker sidecar runs.`
                    : `--inspector-port does not apply to the ${flavor} flavor: Vite owns the worker. Pin it in vite.config — \`lunora({ cloudflare: { inspectorPort: ${String(options.inspectorPort)} } })\`.`,
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
    // Only when something actually asked for a port. Passing wrangler's own
    // default here would pin 9229 for every project — including the ones relying
    // on wrangler walking off it — which is the opposite of what #689 needs.
    const inspectorArgs = options.inspectorPort === undefined ? [] : ["--inspector-port", String(options.inspectorPort)];
    const exec = execArgsFor(manager, "wrangler", [
        "dev",
        "--port",
        String(workerPort),
        ...inspectorArgs,
        ...loopbackArgs,
        "--var",
        "WORKER_ENV:development",
        ...remote.args,
        ...resolveServiceArgs(cwd, remote.args),
    ]);

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
 * Resolve the worker port (a free-port probe for the wrangler flavor, so the
 * origin stays deterministic without pinning a busy 8787) and build the dev
 * plan. Extracted from `runDevCommand` so its startup orchestration stays
 * legible — the async port resolution is the only reason planning isn't inline.
 */
const buildDevPlan = async (options: DevCommandOptions): Promise<DevCommandPlan> => {
    const cwd = options.cwd ?? process.cwd();

    // A host with its own dev server (celld) runs the standalone flavor
    // `resolveTargetFlavor` already picked, but none of the `wrangler dev`
    // planning below applies to it.
    if (options.target !== undefined && targetRunsOwnDevServer(options.target)) {
        return planOwnDevServer({
            cwd,
            driver: resolveDeployDriver(options.target),
            options,
            studioPort: options.port ?? DEFAULT_STUDIO_PORT,
            workerPort: await resolveWorkerPort(options, cwd),
        });
    }

    const flavor = options.flavor ?? detectDevFlavor(cwd);
    // The vite flavor lets Vite resolve its own port; only the wrangler flavor
    // needs a pre-picked free port passed through as `--port`.
    const workerPort = flavor === "wrangler" ? await resolveWorkerPort(options, cwd) : options.workerPort;
    // Same split for the inspector: the other flavors get the flag back as a
    // warning (see `planDevCommand`), so the wrangler-config fallback is only
    // read where a `wrangler dev` argv exists to carry it.
    const inspectorPort = flavor === "wrangler" ? resolveInspectorPort(options, cwd) : options.inspectorPort;

    return planDevCommand({ ...options, cwd, flavor, inspectorPort, workerPort });
};

export { buildDevPlan, planDevCommand, resolveInspectorPort, resolveWorkerPort };
