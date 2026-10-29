import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

import { acceptsConnection, formatLunoraEvent, lunoraLine, startDevProcess } from "@lunora/config";
import { findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

/**
 * Port the Worker serves on when nothing pins one. Wrangler's own default, and
 * what every Lunora scaffold writes into `.dev.vars` origins.
 */
const DEFAULT_WORKER_PORT = 8787;

/** How long to wait for `wrangler dev` to accept connections before giving up. */
const READY_TIMEOUT_MS = 30_000;

/** A running `wrangler dev`, and the handle to stop it. */
interface WorkerProcess {
    /** The port it serves on. */
    port: number;

    /** Terminate it; resolves once it has exited. */
    stop: () => Promise<void>;
}

/** The slice of a wrangler config this module reads. */
interface WranglerSlice {
    assets?: { directory?: unknown };
    dev?: { port?: unknown };
    env?: Record<string, { assets?: { directory?: unknown } } | undefined>;
}

/** The value of `--name value`, `--name=value` or `-n value` in `args`, last one winning, as a CLI parser reads it. */
const flagValue = (args: ReadonlyArray<string>, long: string, short: string): string | undefined => {
    let value: string | undefined;

    for (const [index, argument] of args.entries()) {
        if (argument.startsWith(`${long}=`)) {
            value = argument.slice(long.length + 1);
        } else if ((argument === long || argument === short) && index + 1 < args.length) {
            value = args[index + 1];
        }
    }

    return value;
};

/**
 * The wrangler config `wrangler dev` will actually load, given the arguments it
 * is spawned with: `--config`/`-c` picks the file (relative to the project), and
 * `--env`/`-e` the environment block — so what is read here is what wrangler
 * reads, not the default file next to a project that points somewhere else.
 */
const readWranglerTarget = (
    projectRoot: string,
    wranglerArgs: ReadonlyArray<string> = [],
): { config: WranglerSlice; env?: string; path: string } | undefined => {
    const explicit = flagValue(wranglerArgs, "--config", "-c");
    const path = explicit === undefined ? findWranglerFile(projectRoot) : resolvePath(projectRoot, explicit);

    // A `--config` naming a missing file is wrangler's to report — clearly, when
    // it starts — not a raw ENOENT from here, which would surface while the
    // Rsbuild config itself is still loading.
    if (path === undefined || !existsSync(path)) {
        return undefined;
    }

    const { parsed } = readWranglerJsonc<WranglerSlice>(path);

    return parsed === undefined ? undefined : { config: parsed, env: flagValue(wranglerArgs, "--env", "-e"), path };
};

/**
 * The port the Worker should serve on: an explicit option, then the wrangler
 * config's `dev.port`, then {@link DEFAULT_WORKER_PORT}.
 *
 * Deliberately NOT a free-port search. `lunora dev` does search, and needs ~100
 * lines to reconcile the result against `.dev.vars` origins that pin 8787 — a
 * moving port would leave `AUTH_URL` and friends pointing at nothing. A plugin
 * that picks one deterministic port has no such problem, and a port already in
 * use surfaces as wrangler's own clear error rather than a silent relocation.
 */
const resolveWorkerPort = (projectRoot: string, explicit?: number, wranglerArgs?: ReadonlyArray<string>): number => {
    if (explicit !== undefined) {
        return explicit;
    }

    // `dev` is top-level only in wrangler — an `env` block cannot override it.
    const port = readWranglerTarget(projectRoot, wranglerArgs)?.config.dev?.port;

    return typeof port === "number" ? port : DEFAULT_WORKER_PORT;
};

/**
 * Create the wrangler config's `assets.directory` when it does not exist yet.
 *
 * `wrangler dev` refuses to start without it, and under Rsbuild it is normally
 * absent: the dev server serves the client from memory, and the directory is the
 * gitignored build output — so a fresh clone of any app that binds assets would
 * die here before its first `rsbuild build`. An empty directory is exactly what
 * the Worker should see in dev; the dev server, not wrangler, serves the client.
 */
const ensureAssetsDirectory = (projectRoot: string, wranglerArgs?: ReadonlyArray<string>): void => {
    const target = readWranglerTarget(projectRoot, wranglerArgs);

    if (target === undefined) {
        return;
    }

    // An `--env` block's own `assets` replaces the top-level one.
    const envAssets = target.env === undefined ? undefined : target.config.env?.[target.env]?.assets;
    const directory = (envAssets ?? target.config.assets)?.directory;

    if (typeof directory === "string") {
        // Relative to the config file, as wrangler resolves it.
        mkdirSync(resolvePath(dirname(target.path), directory), { recursive: true });
    }
};

/**
 * Print a worker output line, routing Lunora's structured events through the
 * shared formatter so `ctx.log.*` calls and RPC dispatch summaries read the same
 * here as under `lunora dev`. Anything else passes through untouched — wrangler's
 * own startup banner and errors are worth seeing verbatim.
 */
const printWorkerLine = (line: string): void => {
    const event = formatLunoraEvent(line);

    if (event === undefined) {
        if (line.trim() !== "") {
            // eslint-disable-next-line no-console -- dev-server passthrough of the worker's own output
            console.log(line);
        }

        return;
    }

    const text = lunoraLine(event.text);

    if (event.level === "error") {
        // eslint-disable-next-line no-console -- dev-server passthrough of the worker's own output
        console.error(text);
    } else if (event.level === "warn") {
        // eslint-disable-next-line no-console -- dev-server passthrough of the worker's own output
        console.warn(text);
    } else {
        // eslint-disable-next-line no-console -- dev-server passthrough of the worker's own output
        console.info(text);
    }
};

interface StartWorkerOptions {
    /** Port to serve on. */
    port: number;

    /** Absolute project root; the child's cwd. */
    projectRoot: string;

    /** Extra arguments appended to `wrangler dev`. */
    wranglerArgs?: ReadonlyArray<string>;
}

/**
 * Spawn `wrangler dev` and resolve once it accepts connections.
 *
 * Waiting for readiness is what makes the proxy injected alongside it safe: the
 * dev server starts accepting browser traffic the moment this resolves, and a
 * request proxied to a port nothing listens on fails outright rather than
 * retrying — so the first page load would otherwise race the Worker's boot.
 *
 * `--var WORKER_ENV:development` flags the deployment as development so the
 * runtime streams RPC dispatch summaries and keeps argument/error detail
 * unredacted — the same flag `lunora dev` passes.
 */
const startWorker = async (options: StartWorkerOptions): Promise<WorkerProcess> => {
    // Before spawning, not after. The readiness probe cannot tell OUR worker
    // from anyone else's, so a port already held — an orphaned wrangler, a
    // second `rsbuild dev`, `lunora dev` in another terminal — would satisfy it
    // on its first poll. The dev server would then proxy `/_lunora/*` to a
    // foreign process while the wrangler spawned here quietly died of "port in
    // use", and the session would look perfectly healthy.
    if (await acceptsConnection(options.port)) {
        throw new Error(
            `could not start the worker: port ${String(options.port)} is already in use. Stop whatever is serving there (another \`rsbuild dev\` or \`lunora dev\`?), or set \`workerPort\`.`,
        );
    }

    ensureAssetsDirectory(options.projectRoot, options.wranglerArgs);

    // Package managers install `wrangler.cmd` on Windows, and Node will not launch
    // a `.cmd` shim without a shell — the failure surfaces as ENOENT, telling the
    // developer wrangler is not installed when it is. Argv stays fixed either way:
    // the port is a number and `wranglerArgs` is the project's own config.
    const isWindows = process.platform === "win32";
    const started = await startDevProcess({
        args: ["dev", "--port", String(options.port), "--var", "WORKER_ENV:development", ...(options.wranglerArgs ?? [])],
        command: isWindows ? "wrangler.cmd" : "wrangler",
        cwd: options.projectRoot,
        label: "wrangler dev",
        notFound:
            "could not start the worker: `wrangler` was not found on PATH. Add it to the project (`npm install -D wrangler`), or pass `worker: false` to run the worker yourself.",
        onLine: printWorkerLine,
        port: options.port,
        readyTimeoutMs: READY_TIMEOUT_MS,
        shell: isWindows,
    });

    return { port: options.port, stop: started.stop };
};

export type { StartWorkerOptions, WorkerProcess };
export { DEFAULT_WORKER_PORT, printWorkerLine, resolveWorkerPort, startWorker };
