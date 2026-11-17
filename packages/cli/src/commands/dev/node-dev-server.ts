/**
 * `lunora dev --target node`: the app's worker entry served in this process on
 * `@lunora/platform-node`, in place of `wrangler dev`.
 *
 * The Node driver ships no toolchain, so there is no child to spawn. The entry
 * (wrangler's `main`) is loaded through jiti, composed with
 * `createNodeAppHost`, and served with `createNodeHttpServer` on the planned
 * worker port. `@lunora/platform-node` is resolved from the project, as celld's
 * binary is: it carries `better-sqlite3`, a native build every other `lunora`
 * install would otherwise pay for.
 *
 * A reload is a full restart of the listener and the host, the same thing
 * `wrangler dev` does on a rebuild: open sockets and streams close and clients
 * reconnect to the new code. Two things trigger one. A settled run of the
 * codegen watcher covers every file under `lunora/`; reloading on the raw file
 * event instead would import `_generated/*` while codegen is still rewriting
 * it. Files the entry loaded from outside `lunora/` (the entry itself and its
 * helpers) are watched here, because the codegen watcher never sees them.
 */
import type { FSWatcher } from "node:fs";
import { realpathSync, watch } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { resolveLocalWorkerEnv, resolveSchemaDirectory } from "@lunora/config";
import { findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

import { codegenRequested } from "./lifecycle";
import type { DevCommandOptions, DevCommandPlan, NodeDevWorker, NodeDevWorkerInputs } from "./types";

/** Where the shard databases persist between sessions; `.lunora/` is already the dev server's gitignored state directory. */
const NODE_DEV_STATE_DIRECTORY = join(".lunora", "node");

/** How long a burst of edits outside `lunora/` is coalesced into one reload. */
const RELOAD_DEBOUNCE_MS = 100;

/**
 * Wrangler keys that declare a binding this host does not compose in dev. Each is named once at startup, so a request
 * that reads one fails where the developer was already told it would.
 */
const UNBOUND_BINDING_KEYS = [
    "ai",
    "analytics_engine_datasets",
    "browser",
    "containers",
    "d1_databases",
    "hyperdrive",
    "images",
    "kv_namespaces",
    "pipelines",
    "queues",
    "r2_buckets",
    "secrets_store_secrets",
    "send_email",
    "services",
    "vectorize",
    "workflows",
] as const;

interface NodeWranglerConfig {
    durable_objects?: { bindings?: ReadonlyArray<{ class_name?: unknown; name?: unknown; script_name?: unknown }> };
    main?: unknown;
    secrets?: { required?: unknown } | null;
    vars?: Record<string, unknown> | null;
}

/** A `durable_objects.bindings[]` entry the host constructs: the `env` key and the exported class behind it. */
interface DurableObjectBinding {
    className: string;
    name: string;
}

/** What the Node dev worker reads from the project's wrangler config. */
interface NodeDevProject {
    configPath: string;
    durableObjects: DurableObjectBinding[];
    entry: string;
    parsed: NodeWranglerConfig;
    /** Declared bindings with no Node composition in dev, by wrangler key. */
    unbound: string[];
}

const isPresent = (value: unknown): boolean => (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null);

/** Read the worker entry and its Durable Object bindings, or throw naming what is missing. */
const readNodeDevProject = (projectRoot: string): NodeDevProject => {
    const configPath = findWranglerFile(projectRoot);

    if (configPath === undefined) {
        throw new Error("--target node serves the worker entry wrangler.jsonc names in `main`, and this project has no wrangler config");
    }

    const { parsed } = readWranglerJsonc<NodeWranglerConfig>(configPath);

    if (parsed === undefined || typeof parsed.main !== "string") {
        throw new Error(`--target node serves the worker entry \`main\` names, and ${relative(projectRoot, configPath)} has no \`main\``);
    }

    const durableObjects: DurableObjectBinding[] = [];

    for (const binding of parsed.durable_objects?.bindings ?? []) {
        // A binding to another worker's class has no class in this entry to construct.
        if (typeof binding.name === "string" && typeof binding.class_name === "string" && binding.script_name === undefined) {
            durableObjects.push({ className: binding.class_name, name: binding.name });
        }
    }

    const unbound = UNBOUND_BINDING_KEYS.filter((key) => isPresent((parsed as Record<string, unknown>)[key]));

    return { configPath, durableObjects, entry: resolve(projectRoot, parsed.main), parsed, unbound };
};

/**
 * The plan for `--target node`: codegen watch and the studio as on the wrangler flavor, and this process's Node host as
 * the worker. None of the `wrangler dev` machinery applies — no remote bindings, no inspector, no IPv4 loopback fallback.
 * @throws for `--remote`, which this host has no equivalent for.
 */
const planNodeDevServer = (inputs: { cwd: string; options: DevCommandOptions; studioPort: number; workerPort: number }): DevCommandPlan => {
    const { cwd, options, studioPort, workerPort } = inputs;

    if (options.remote === true) {
        throw new Error("--remote proxies bindings to Cloudflare; the Node target has no remote bindings to proxy to");
    }

    if (options.inspectorPort !== undefined) {
        options.logger.warn("--inspector-port is a wrangler dev flag; the Node target runs in this process — use `node --inspect` on lunora instead");
    }

    return {
        flavor: "wrangler",
        ipv4LoopbackForced: false,
        nodeHost: true,
        remote: { bindings: [], cleanup: () => {}, enabled: false, withheld: [] },
        runsCodegenWatch: codegenRequested(options),
        studioEnabled: options.studio !== false,
        studioPort,
        workerEnabled: options.worker !== false,
        workerOrigin: `http://localhost:${String(workerPort)}`,
        workerPort,
        // Names the worker in the startup line; nothing is spawned from it.
        wrangler: { args: [], command: "node", cwd, tag: "node" },
    };
};

/** A composed app on the project's `@lunora/platform-node` (`createNodeAppHost`). */
interface NodeAppHost {
    close: () => Promise<void>;
    fetch: (request: Request) => Promise<Response>;
}

/**
 * The slice of the project's copy of `@lunora/platform-node` this file calls, loaded through the same jiti instance
 * as the app so both share one module graph. Declared rather than imported: the package is resolved from the project
 * at run time, and importing its types would pull its whole dependency tree into this package's declarations.
 */
interface PlatformNode {
    createNodeAppHost: (options: {
        dataDirectory?: string;
        durableObjects: ReadonlyArray<DurableObjectBinding>;
        env?: Record<string, unknown>;
        worker: Record<string, unknown>;
    }) => NodeAppHost;
    createNodeHttpServer: (options: { fetch: (request: Request) => Promise<Response>; port?: number }) => Promise<{ close: () => Promise<void> }>;
}

const isUnder = (path: string, directory: string): boolean => path === directory || path.startsWith(`${directory}${sep}`);

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Start the Node dev worker and serve the app on `port`.
 * @throws when `@lunora/platform-node` is not installed, the wrangler config names no entry, or the first load fails —
 * a later load that fails keeps the running version and reports instead.
 */
const startNodeDevWorker = async (inputs: NodeDevWorkerInputs): Promise<NodeDevWorker> => {
    const { logger, port } = inputs;
    // jiti keys its cache by real path, and the eviction below matches project files against this root.
    const projectRoot = realpathSync(inputs.projectRoot);
    const project = readNodeDevProject(projectRoot);
    const { createJiti } = await import("jiti");
    const jiti = createJiti(join(projectRoot, "package.json"), { interopDefault: false });
    const schemaDirectory = resolve(projectRoot, resolveSchemaDirectory(projectRoot));

    let platform: PlatformNode;

    try {
        platform = await jiti.import<PlatformNode>("@lunora/platform-node");
    } catch (error: unknown) {
        throw new Error(
            `--target node runs the app on @lunora/platform-node, which this project cannot load (${errorMessage(error)}). Install it as a dev dependency.`,
            {
                cause: error,
            },
        );
    }

    if (project.unbound.length > 0) {
        logger.warn(`Node dev binds only Durable Objects and vars; these wrangler bindings are not bound, so reading one fails: ${project.unbound.join(", ")}`);
    }

    const isProjectSource = (path: string): boolean => isUnder(path, projectRoot) && !path.split(sep).includes("node_modules");

    let watchers: FSWatcher[] = [];
    let debounce: NodeJS.Timeout | undefined;
    let running: { host: NodeAppHost; server: { close: () => Promise<void> } } | undefined;
    let stopped = false;

    const unwatch = (): void => {
        for (const watcher of watchers) {
            watcher.close();
        }

        watchers = [];
    };

    // Every project file the last load evaluated outside `lunora/`; the codegen watcher already covers the rest.
    const watchLoadedSources = (): void => {
        unwatch();

        for (const path of Object.keys(jiti.cache)) {
            if (isProjectSource(path) && !isUnder(path, schemaDirectory)) {
                const watcher = watch(path, () => {
                    clearTimeout(debounce);
                    debounce = setTimeout(() => {
                        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- the reload and the watch reference each other
                        reload();
                    }, RELOAD_DEBOUNCE_MS);
                });

                // A deleted file raises an error event; the next load re-reads the set, so it is only dropped here.
                watcher.on("error", () => {
                    watcher.close();
                });
                watchers.push(watcher);
            }
        }
    };

    const load = async (): Promise<Record<string, unknown>> => {
        // Only the project's own modules are evicted: packages under node_modules load natively once and stay, so a reload
        // re-evaluates the app and nothing else.
        for (const path of Object.keys(jiti.cache)) {
            if (isProjectSource(path)) {
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- jiti's module cache is keyed by file path
                delete jiti.cache[path];
            }
        }

        try {
            return await jiti.import<Record<string, unknown>>(project.entry);
        } finally {
            // Also after a failed load: the file that broke it is in the set, and its next save is the fix.
            watchLoadedSources();
        }
    };

    // Loads and composes without touching the running version: a host opens no shard database until a request reaches one,
    // so a module that cannot be composed (a removed Durable Object export, a broken wrangler config) is caught while the
    // previous version still serves.
    const prepare = async (): Promise<NodeAppHost> => {
        const worker = await load();
        const current = readNodeDevProject(projectRoot);
        const { env } = resolveLocalWorkerEnv({ config: current.parsed, configPath: current.configPath, projectRoot, vars: { WORKER_ENV: "development" } });

        return platform.createNodeAppHost({
            dataDirectory: join(projectRoot, NODE_DEV_STATE_DIRECTORY),
            durableObjects: current.durableObjects,
            env,
            worker,
        });
    };

    const serve = async (host: NodeAppHost): Promise<void> => {
        try {
            running = { host, server: await platform.createNodeHttpServer({ fetch: host.fetch, port }) };
        } catch (error: unknown) {
            await host.close();

            throw error;
        }
    };

    const shutdown = async (): Promise<void> => {
        const previous = running;

        running = undefined;
        await previous?.server.close();
        await previous?.host.close();
    };

    try {
        await serve(await prepare());
    } catch (error: unknown) {
        unwatch();

        throw error;
    }

    logger.info(`node: serving ${relative(projectRoot, project.entry)} on @lunora/platform-node at http://localhost:${String(port)}`);

    let settle: (code: number) => void = () => {};
    const exited = new Promise<number>((_resolve) => {
        settle = _resolve;
    });

    // One reload in flight, at most one queued: a later reload reads every file an earlier queued one would have.
    let reloading: Promise<void> | undefined;
    let queued = false;
    // A call, not a read: `reloadOnce` sets `queued` across an await, which narrowing at the loop condition cannot see.
    const takeQueued = (): boolean => {
        const next = queued && !stopped;

        queued = false;

        return next;
    };

    const reloadOnce = async (): Promise<void> => {
        let host: NodeAppHost;

        try {
            host = await prepare();
        } catch (error: unknown) {
            logger.error(`node: reload failed, still serving the previous version: ${errorMessage(error)}`);

            return;
        }

        await shutdown();

        try {
            await serve(host);
            logger.info("node: reloaded");
        } catch (error: unknown) {
            logger.error(`node: could not serve the reloaded worker: ${errorMessage(error)}`);
            settle(1);
        }
    };

    const reload = (): void => {
        if (stopped) {
            return;
        }

        if (reloading !== undefined) {
            queued = true;

            return;
        }

        reloading = (async () => {
            do {
                // eslint-disable-next-line no-await-in-loop -- reloads are serialized: two would race for the one port
                await reloadOnce();
            } while (takeQueued());
        })().finally(() => {
            reloading = undefined;
        });
    };

    return {
        exited,
        kill: (signal) => {
            // The supervisor's second Ctrl-C: a shutdown waiting on a `waitUntil` that never settles must not hold the
            // process, so the worker reports itself gone without waiting for it.
            if (signal === "SIGKILL") {
                settle(1);
            }

            if (stopped) {
                return;
            }

            stopped = true;
            clearTimeout(debounce);
            unwatch();
            (reloading ?? Promise.resolve())
                .then(shutdown)
                .then(
                    () => 0,
                    () => 1,
                )
                .then(settle)
                .catch(() => undefined);
        },
        reload,
    };
};

export { planNodeDevServer, startNodeDevWorker };
