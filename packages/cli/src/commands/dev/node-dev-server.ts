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
 * reconnect to the new code. Three things trigger one. A settled run of the
 * codegen watcher covers every file under `lunora/`; reloading on the raw file
 * event instead would import `_generated/*` while codegen is still rewriting
 * it. Files the entry loaded from outside `lunora/` (the entry itself and its
 * helpers) are watched here, because the codegen watcher never sees them. So
 * are the wrangler config and the files the env is read from (`.dev.vars`,
 * `.dev.vars.<env>`, `.env*`).
 *
 * Every load re-reads the wrangler config for the environment `CLOUDFLARE_ENV`
 * names, as `wrangler dev` does: that environment's `main` and bindings, its
 * `vars` and its `.dev.vars.<env>`.
 *
 * Besides the Durable Object bindings, each load binds what `@lunora/platform-node`
 * can stand in for: the declared crons (`_generated/crons.ts`), armed on the
 * scheduler and delivered to the shard; each `secrets_store_secrets` binding,
 * read from the dev env; and each `hyperdrive` binding, built from `DATABASE_URL`.
 */
import type { FSWatcher } from "node:fs";
import { existsSync, realpathSync, statSync, watch } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { resolveLocalWorkerEnv, resolveSchemaDirectory, wranglerDotenvFiles } from "@lunora/config";
import type { WranglerConfig } from "@lunora/config/cloudflare";
import { findWranglerFile, mergeWranglerEnvironment, readWranglerJsonc } from "@lunora/config/cloudflare";

import { BINDING_NAME, refuseWorkerEnvOverride, unboundSections, WORKER_ENV } from "../../util/node-target-bindings";
import { codegenRequested } from "./lifecycle";
import type {
    DevCommandOptions,
    DevCommandPlan,
    NodeAppHost,
    NodeAppHostCandidate,
    NodeDevHttpServer,
    NodeDevWorker,
    NodeDevWorkerInputs,
    PlatformNode,
} from "./types";

/** Where the shard databases persist between sessions; `.lunora/` is already the dev server's gitignored state directory. */
const NODE_DEV_STATE_DIRECTORY = join(".lunora", "node");

/** How long a burst of edits outside `lunora/` is coalesced into one reload. */
const RELOAD_DEBOUNCE_MS = 100;

/**
 * How long a reload or a stop waits for the previous version's in-flight work (its `waitUntil` promises, shard requests and
 * alarms) before closing it anyway. The port is closed for that long, so it is short: a dev loop waits on a save, not a deploy.
 */
const NODE_DEV_DRAIN_TIMEOUT_MS = 5000;

interface NodeWranglerConfig {
    durable_objects?: { bindings?: ReadonlyArray<{ class_name?: unknown; name?: unknown; script_name?: unknown }> };
    hyperdrive?: ReadonlyArray<{ binding?: unknown }>;
    main?: unknown;
    secrets?: { required?: unknown } | null;
    secrets_store_secrets?: ReadonlyArray<{ binding?: unknown }>;
    vars?: Record<string, unknown> | null;
}

/** A `durable_objects.bindings[]` entry the host constructs: the `env` key and the exported class behind it. */
interface DurableObjectBinding {
    className: string;
    name: string;
}

/** What the Node dev worker reads from the project's wrangler config, for the active wrangler environment. */
interface NodeDevProject {
    configPath: string;
    durableObjects: DurableObjectBinding[];
    entry: string;
    /** The wrangler environment the view was resolved for, or `undefined` for the top level. */
    environment: string | undefined;
    /** `hyperdrive[].binding` names. */
    hyperdrive: string[];
    /** The whole config as written; `resolveLocalWorkerEnv` picks the environment's `vars` and `secrets` from it itself. */
    parsed: NodeWranglerConfig;
    /** `secrets_store_secrets[].binding` names. */
    secrets: string[];
    /** Declared bindings with no Node composition in dev, by wrangler key. */
    unbound: string[];
}

const bindingNames = (entries: ReadonlyArray<{ binding?: unknown }> | undefined): string[] =>
    (entries ?? []).flatMap((entry) => (typeof entry.binding === "string" ? [entry.binding] : []));

/**
 * The wrangler environment `lunora dev` runs, read as `wrangler dev` reads it: `CLOUDFLARE_ENV`, empty meaning none. Read on
 * every load, as the rest of the config is.
 */
const activeWranglerEnvironment = (): string | undefined => {
    const environment = process.env["CLOUDFLARE_ENV"];

    return environment === "" ? undefined : environment;
};

/**
 * Read the worker entry and its bindings for `environment`, or throw naming what is missing. `main` is inherited from the top
 * level and the bindings are not, as `mergeWranglerEnvironment` resolves them for `wrangler deploy --env`.
 */
const readNodeDevProject = (projectRoot: string, environment: string | undefined): NodeDevProject => {
    const configPath = findWranglerFile(projectRoot);

    if (configPath === undefined) {
        throw new Error("--target node serves the worker entry wrangler.jsonc names in `main`, and this project has no wrangler config");
    }

    const { parsed } = readWranglerJsonc<NodeWranglerConfig>(configPath);

    if (parsed === undefined) {
        throw new Error(`--target node could not read ${relative(projectRoot, configPath)} as JSONC`);
    }

    const { error, merged } = mergeWranglerEnvironment(parsed as WranglerConfig, environment);

    if (error !== undefined) {
        throw new Error(`CLOUDFLARE_ENV: ${error}`);
    }

    const view = merged as NodeWranglerConfig;

    if (typeof view.main !== "string") {
        throw new TypeError(`--target node serves the worker entry \`main\` names, and ${relative(projectRoot, configPath)} has no \`main\``);
    }

    const configName = relative(projectRoot, configPath);
    const durableObjects: DurableObjectBinding[] = [];
    const external: string[] = [];

    for (const binding of view.durable_objects?.bindings ?? []) {
        if (typeof binding.name !== "string" || typeof binding.class_name !== "string") {
            continue;
        }

        // The name becomes a directory under `.lunora/node/`: anything but an identifier ("..", "a/b") could put shard files
        // outside it.
        if (!BINDING_NAME.test(binding.name)) {
            throw new Error(
                `--target node stores each Durable Object binding's shards in a directory named after it, and the binding ${JSON.stringify(binding.name)} in ${configName} is not a valid binding name (a JavaScript identifier such as SHARD)`,
            );
        }

        // A binding to another worker's class has no class in this entry to construct, and no other worker runs here.
        if (binding.script_name === undefined) {
            durableObjects.push({ className: binding.class_name, name: binding.name });
        } else {
            external.push(`durable_objects.${binding.name}`);
        }
    }

    const hyperdrive = bindingNames(view.hyperdrive);
    const secrets = bindingNames(view.secrets_store_secrets);

    // `WORKER_ENV` is set to `development` on the env these bindings are spread over; a binding of that name would replace it.
    refuseWorkerEnvOverride(
        [
            { names: secrets, source: "secrets_store_secrets" },
            { names: hyperdrive, source: "hyperdrive" },
            { names: durableObjects.map((binding) => binding.name), source: "durable_objects.bindings" },
        ],
        configName,
        "development",
    );

    const unbound = [...unboundSections(view as Record<string, unknown>), ...external];

    return {
        configPath,
        durableObjects,
        entry: resolve(projectRoot, view.main),
        environment,
        hyperdrive,
        parsed,
        secrets,
        unbound,
    };
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
        // The address `createNodeHttpServer` binds. `localhost` can resolve to ::1 first, where the readiness probe, the Studio
        // proxy and the tunnel would find nothing listening.
        workerOrigin: `http://127.0.0.1:${String(workerPort)}`,
        workerPort,
        // Names the worker in the startup line; nothing is spawned from it.
        wrangler: { args: [], command: "node", cwd, tag: "node" },
    };
};

/** The string values of a dev env, which are what a secret or `DATABASE_URL` can be read from. */
const stringValues = (env: Record<string, unknown>): Record<string, string> =>
    Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));

const isUnder = (path: string, directory: string): boolean => path === directory || path.startsWith(`${directory}${sep}`);

/** A reload whose load a codegen run overlapped; that run's settlement reloads again. */
class SupersededLoad extends Error {
    public constructor() {
        super("a codegen run started during the load");
        this.name = "SupersededLoad";
    }
}

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
    const project = readNodeDevProject(projectRoot, activeWranglerEnvironment());
    const { createJiti } = await import("jiti");
    const jiti = createJiti(join(projectRoot, "package.json"), { interopDefault: false });
    const schemaDirectory = resolve(projectRoot, resolveSchemaDirectory(projectRoot));
    // The generated cron map; absent until codegen has run once, and an app with no `crons.ts` declares none either way.
    const cronsModule = join(schemaDirectory, "_generated", "crons.ts");

    let platform: PlatformNode;

    try {
        platform = inputs.platform ?? (await jiti.import<PlatformNode>("@lunora/platform-node"));
    } catch (error: unknown) {
        throw new Error(
            `--target node runs the app on @lunora/platform-node, which this project cannot load (${errorMessage(error)}). Install it as a dev dependency.`,
            {
                cause: error,
            },
        );
    }

    // The peer range admits only releases that have them, but a project can pin an older one and skip the peer check.
    if (
        typeof (platform as Partial<PlatformNode>).createNodeAppHost !== "function" ||
        typeof (platform as Partial<PlatformNode>).checkNodeAppHost !== "function"
    ) {
        throw new TypeError(
            "--target node needs a @lunora/platform-node that exports createNodeAppHost and checkNodeAppHost (1.0.0-alpha.220 or later); upgrade it in this project",
        );
    }

    if (project.unbound.length > 0) {
        logger.warn(
            `Node dev binds Durable Objects, vars, crons, Secrets Store secrets and Hyperdrive; these wrangler bindings are not bound, so reading one fails: ${project.unbound.join(", ")}`,
        );
    }

    // The project and, when `main` sits outside it (a worker shared between apps), the entry's own directory: both are source
    // the developer edits. Packages are not, wherever they resolve to, since a workspace package's realpath is outside
    // `node_modules`; they load once and stay.
    let sourceRoots: string[] = [projectRoot];
    const isProjectSource = (path: string): boolean => sourceRoots.some((root) => isUnder(path, root)) && !path.split(sep).includes("node_modules");

    let watchers: FSWatcher[] = [];
    let debounce: NodeJS.Timeout | undefined;
    let running: { host: NodeAppHost; server: NodeDevHttpServer } | undefined;
    let stopped = false;
    // Until the first version serves, a change only marks a reload for afterwards: one started mid-startup would race it for
    // the port, and one left armed after a failed start would compose a host nobody stops.
    let starting = true;
    let reloadAfterStart = false;
    // The source set of the last load that succeeded, kept until another one does: a load that fails on a moved file has none
    // of the files it could not import, and restoring one must still reload.
    let lastLoadedSources = new Set<string>();
    // The modification time each watched source had when it was last checked, so a reload follows each change once.
    const seenModified = new Map<string, number>();

    const unwatch = (): void => {
        for (const watcher of watchers) {
            watcher.close();
        }

        watchers = [];
    };

    const scheduleReload = (): void => {
        if (starting) {
            reloadAfterStart = true;

            return;
        }

        clearTimeout(debounce);
        debounce = setTimeout(() => {
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- the reload and the watch reference each other
            reload();
        }, RELOAD_DEBOUNCE_MS);
    };

    /** Watch `paths` through their directories, so a file deleted and restored, or replaced by an editor's rename, is still seen. */
    const watchThroughDirectories = (paths: ReadonlySet<string>): void => {
        const byDirectory = new Map<string, Set<string>>();

        for (const path of paths) {
            const names = byDirectory.get(dirname(path)) ?? new Set<string>();

            names.add(basename(path));
            byDirectory.set(dirname(path), names);
        }

        for (const [directory, names] of byDirectory) {
            try {
                const watcher = watch(directory, (_event, filename) => {
                    // Node does not promise a name; an unnamed event in a watched directory may be one of these files.
                    if (filename === null || names.has(filename)) {
                        scheduleReload();
                    }
                });

                watcher.on("error", () => {
                    watcher.close();
                });
                watchers.push(watcher);
            } catch {
                // The directory is gone; the next load re-reads the set.
            }
        }
    };

    // Every project file the load evaluated. Files under `lunora/` are left to the codegen watcher when it runs, whose settled run
    // reloads after `_generated/*` is rewritten; without it (`--no-codegen`) nothing else would see them.
    const watchLoadedSources = (loadStartedAt: number, loaded: boolean): void => {
        unwatch();

        // A stop during the load already closed the watches; new ones would outlive the worker.
        if (stopped) {
            return;
        }

        const watchable = (path: string): boolean => !(inputs.codegenWatch && isUnder(path, schemaDirectory));
        // The generated cron map is read after the entry, and without the codegen watcher nothing else reloads on it. Watched by
        // name even before it exists, so a first `crons.ts` is seen too.
        const current = [
            ...Object.keys(jiti.cache).filter((path) => isProjectSource(path) && watchable(path)),
            ...(watchable(cronsModule) ? [cronsModule] : []),
        ];
        const sources = loaded ? new Set(current) : new Set([...lastLoadedSources, ...current]);

        if (loaded) {
            lastLoadedSources = sources;
        }

        watchThroughDirectories(sources);

        let changedDuringLoad = false;

        for (const path of sources) {
            // A watcher reports only what happens after it starts, and the load read this file before then: an edit in between
            // would otherwise go unseen until the next save. Once per modification time, so a clock skewed ahead of this one
            // reloads once rather than on every reload.
            try {
                const modified = statSync(path).mtimeMs;

                changedDuringLoad ||= modified > loadStartedAt && seenModified.get(path) !== modified;
                seenModified.set(path, modified);
            } catch {
                // Deleted since the load; its directory watch sees it come back.
            }
        }

        if (changedDuringLoad) {
            scheduleReload();
        }
    };

    const load = async (entry: string): Promise<{ crons: Readonly<Record<string, ReadonlyArray<unknown>>> | undefined; worker: Record<string, unknown> }> => {
        // The wall clock the file system stamps mtimes with, read without `Date`: a clock an app or a test moves would make every
        // file look changed, or none.
        const loadStartedAt = performance.timeOrigin + performance.now();

        // Only the project's own modules are evicted: packages under node_modules load natively once and stay, so a reload
        // re-evaluates the app and nothing else.
        const entryDirectory = dirname(existsSync(entry) ? realpathSync(entry) : entry);

        // The previous load's roots still apply to what it cached, so an entry that moved back inside the project still evicts
        // the shared one's modules.
        const previousRoots = sourceRoots;

        sourceRoots = isUnder(entryDirectory, projectRoot) ? [projectRoot] : [projectRoot, entryDirectory];

        for (const path of Object.keys(jiti.cache)) {
            if (isProjectSource(path) || previousRoots.some((root) => isUnder(path, root) && !path.split(sep).includes("node_modules"))) {
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- jiti's module cache is keyed by file path
                delete jiti.cache[path];
            }
        }

        let loaded = false;

        try {
            const worker = await jiti.import<Record<string, unknown>>(entry);
            // After the entry, which evicted it with the rest of the project, so a schedule edit lands with the reload codegen
            // triggers. Absent until codegen has run once; an app with no `crons.ts` declares none either way.
            const generated = existsSync(cronsModule)
                ? await jiti.import<{ LUNORA_CRONS?: Readonly<Record<string, ReadonlyArray<unknown>>> }>(cronsModule)
                : undefined;

            loaded = true;

            return { crons: generated?.LUNORA_CRONS, worker };
        } finally {
            // Also after a failed load: the file that broke it is in the set, and its next save is the fix.
            watchLoadedSources(loadStartedAt, loaded);
        }
    };

    let hyperdriveWarned = false;

    // `.dev.vars` (or `.env`) over the shell, as the worker's own env has them. Read without a `secrets` block's filter, which
    // decides what reaches the worker as a plain var, not where a Secrets Store binding or `DATABASE_URL` may come from.
    const bindPlatformEnv = (current: NodeDevProject, env: Record<string, unknown>): Record<string, unknown> => {
        const local = resolveLocalWorkerEnv({ config: undefined, configPath: current.configPath, environment: current.environment, projectRoot });
        const source = { ...process.env, ...stringValues(local.env), ...stringValues(env) };
        const hyperdrive: Record<string, unknown> = {};
        const url = source["DATABASE_URL"];

        if (current.hyperdrive.length > 0 && (url === undefined || url === "")) {
            if (!hyperdriveWarned) {
                hyperdriveWarned = true;
                logger.warn(`node: Hyperdrive ${current.hyperdrive.join(", ")} is not bound — set DATABASE_URL in .dev.vars or the shell to bind it`);
            }
        } else {
            for (const name of current.hyperdrive) {
                hyperdrive[name] = platform.createNodeHyperdrive(url);
            }
        }

        return { ...env, ...platform.createNodeSecretBindings(current.secrets, source), ...hyperdrive };
    };

    // A run of the codegen watcher, waited out before a load reads `_generated/*`: one that is running or queued can rewrite it
    // under the import.
    const settledGeneration = async (): Promise<{ sequence: number; usable: boolean } | undefined> => {
        let state = inputs.generation?.();

        while (state?.busy === true) {
            // eslint-disable-next-line no-await-in-loop -- each wait covers the runs queued when it was read
            await state.idle;
            state = inputs.generation?.();
        }

        return state;
    };

    /**
     * Load the current sources and check them, without touching the running version: the candidate is only composed once the
     * previous host has drained, so the two never run schedulers over the same database at once, and a candidate that cannot
     * be composed is refused while the previous version still serves.
     */
    const prepare = async (kind: "reload" | "start"): Promise<NodeAppHostCandidate> => {
        const generation = await settledGeneration();

        if (generation?.usable === false) {
            throw new Error(
                `the last postcodegen hook failed, so _generated/* may be half-written — fix it and ${kind === "reload" ? "save to reload" : "start lunora dev again"}`,
            );
        }

        // Read first, so an edited `main` is the entry this load imports.
        const current = readNodeDevProject(projectRoot, activeWranglerEnvironment());
        const { crons, worker } = await load(current.entry);
        const { env } = resolveLocalWorkerEnv({
            config: current.parsed,
            configPath: current.configPath,
            environment: current.environment,
            projectRoot,
            vars: { [WORKER_ENV]: "development" },
        });

        // A run that started during the load may have rewritten what it read: the load is redone once that run has finished.
        if (generation !== undefined && inputs.generation?.().sequence !== generation.sequence) {
            throw new SupersededLoad();
        }

        const candidate: NodeAppHostCandidate = {
            crons,
            dataDirectory: join(projectRoot, NODE_DEV_STATE_DIRECTORY),
            durableObjects: current.durableObjects,
            env: bindPlatformEnv(current, env),
            worker,
        };

        platform.checkNodeAppHost(candidate);

        return candidate;
    };

    const serve = async (host: NodeAppHost): Promise<void> => {
        try {
            running = { host, server: await platform.createNodeHttpServer({ fetch: host.fetch, port }) };
        } catch (error: unknown) {
            await host.close();

            throw error;
        }
    };

    // The host closes whether or not the listener did: its shard databases must not stay open under the next version.
    // One deadline for the whole shutdown: the responses in flight finish first (the listener stops accepting at once), then the
    // listener closes, ending event streams and WebSockets, then the host drains what is left. The host closes whether or not
    // the listener did: its shard databases must not stay open under the next version.
    const shutdown = async (): Promise<void> => {
        const previous = running;

        running = undefined;

        if (previous === undefined) {
            return;
        }

        const deadlineAt = performance.now() + NODE_DEV_DRAIN_TIMEOUT_MS;
        const remaining = (): { timeoutMs: number } => {
            return { timeoutMs: Math.max(0, Math.round(deadlineAt - performance.now())) };
        };
        const cutOff: string[] = [];

        try {
            const responses = await previous.server.drain(remaining());

            cutOff.push(...responses.pending);
            await previous.server.close();
        } finally {
            const drained = await previous.host.close(remaining());

            cutOff.push(...drained.pending);

            if (cutOff.length > 0) {
                logger.warn(`node: closed the previous version with work still running: ${cutOff.join(", ")}`);
            }
        }
    };

    // The first load, redone while a codegen run overlaps it: there is no previous version to keep serving instead.
    const prepareStart = async (): Promise<NodeAppHostCandidate> => {
        for (;;) {
            try {
                // eslint-disable-next-line no-await-in-loop -- each attempt waits out the run that overlapped the last
                return await prepare("start");
            } catch (error: unknown) {
                if (!(error instanceof SupersededLoad)) {
                    throw error;
                }
            }
        }
    };

    let configWatcher: FSWatcher | undefined;

    try {
        // The files the env is read from, and the wrangler config itself when no codegen watcher does (it reruns on a config edit
        // and its settled run reloads here), watched through their directory so a file created or replaced later is seen too.
        // The name set is rebuilt per event, so it follows CLOUDFLARE_ENV. Installed before the listener, so a watch that
        // cannot be opened fails the start with nothing bound.
        configWatcher = watch(dirname(project.configPath), (_event, filename) => {
            const environment = activeWranglerEnvironment();
            const watched = new Set([
                ...(inputs.codegenWatch ? [] : [basename(project.configPath), "wrangler.json", "wrangler.jsonc"]),
                ".dev.vars",
                ...(environment === undefined ? [] : [`.dev.vars.${environment}`]),
                ...wranglerDotenvFiles(environment),
            ]);

            // Node does not promise a name; an unnamed event in this directory may be one of these files.
            if (filename === null || watched.has(filename)) {
                scheduleReload();
            }
        });
        configWatcher.on("error", () => {
            configWatcher?.close();
        });

        await serve(platform.createNodeAppHost(await prepareStart()));
    } catch (error: unknown) {
        stopped = true;
        clearTimeout(debounce);
        unwatch();
        configWatcher?.close();

        throw error;
    }

    // After serving, not in `prepare`: a reload opens shards only once the previous version has closed them.
    running?.host.rearmPersistedAlarms();

    logger.info(`node: serving ${relative(projectRoot, project.entry)} on @lunora/platform-node at http://127.0.0.1:${String(port)}`);

    starting = false;

    // A read through a call: the watchers set the flag across the awaits above, which narrowing here cannot see.
    const reloadMarked = (): boolean => reloadAfterStart;

    if (reloadMarked()) {
        scheduleReload();
    }

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
        let candidate: NodeAppHostCandidate;

        try {
            candidate = await prepare("reload");
        } catch (error: unknown) {
            if (error instanceof SupersededLoad) {
                // Redone once the run has finished, whether or not it succeeded: a failed codegen run settles nothing, and the
                // edit that started this reload must not wait for the next one that does.
                logger.info("node: codegen ran during the reload; reloading once it finishes");
                await settledGeneration();
                queued = true;
            } else {
                logger.error(`node: reload failed, still serving the previous version: ${errorMessage(error)}`);
            }

            return;
        }

        // Stopped while loading: the stop is closing the running version, and nothing new may start behind it.
        if (stopped) {
            return;
        }

        try {
            await shutdown();
        } catch (error: unknown) {
            // Still serving the new version: if the old listener kept the port, `serve` fails below and says so.
            logger.error(`node: closing the previous version failed: ${errorMessage(error)}`);
        }

        let host: NodeAppHost;

        try {
            host = platform.createNodeAppHost(candidate);
            await serve(host);
        } catch (error: unknown) {
            // The session stays up and the next save reloads again. The previous version cannot keep serving meanwhile: it held the
            // same port and the same shard databases, and both were released for this one.
            logger.error(
                `node: could not serve the reloaded worker on port ${String(port)}: ${errorMessage(error)}. Nothing is serving until a reload succeeds — fix the cause (another process on the port?) and save a file to retry.`,
            );

            return;
        }

        host.rearmPersistedAlarms();
        logger.info("node: reloaded");
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
            configWatcher.close();
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
