/**
 * `lunora deploy --target node`: the app as a container build context.
 *
 * The Node driver has no control plane to publish to, so "deploying" means
 * producing something an operator can run anywhere: one bundled `server.mjs`
 * (a generated entry composing `@lunora/platform-node` around the app's worker
 * entry), a `package.json` carrying only the native `better-sqlite3` the bundle
 * cannot inline, a `Dockerfile` and a `.dockerignore`, plus a README naming the
 * environment the server reads. Nothing is pushed anywhere.
 *
 * esbuild and `@lunora/platform-node` are resolved from the project, as `lunora
 * dev --target node` resolves the latter: both are heavy (a per-platform binary
 * and a native addon), and every other `lunora` install would pay for them.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";

import { COMPOSED_WORKER_ENTRY, resolveSchemaDirectory } from "@lunora/config";
import { findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

import type { Spawner } from "../../util/spawn";

/** Where the build context is written, relative to the project root. `.lunora/` is already the CLI's gitignored state directory. */
const NODE_DEPLOY_DIRECTORY = join(".lunora", "deploy", "node");

/**
 * The image both stages build on: an exact Node LTS release, pinned by its multi-arch index digest so a rebuild months later runs
 * the same bytes even if the tag is re-pushed. Debian rather than Alpine because `better-sqlite3`'s native build and prebuilt
 * binaries both target glibc. Bump the tag and the digest together (`docker buildx imagetools inspect <tag>`).
 */
// eslint-disable-next-line no-secrets/no-secrets -- an image digest is a public content hash, not a secret
const NODE_IMAGE = "node:24.11.1-bookworm-slim@sha256:48abc13a19400ca3985071e287bd405a1d99306770eb81d61202fb6b65cf0b57";

/** How long a shutdown drains before it closes the databases anyway; under `docker stop`'s default 10 s grace. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8000;

/** The variable that overrides {@link DEFAULT_SHUTDOWN_TIMEOUT_MS}. */
const SHUTDOWN_TIMEOUT_VARIABLE = ["LUNORA", "SHUTDOWN", "TIMEOUT", "MS"].join("_");

/** The port the server listens on when `PORT` is unset, matching `wrangler dev`'s default. */
const DEFAULT_PORT = 8787;

/**
 * `ws`'s optional native add-ons. It loads each inside a `try`, so when the project does not install one, esbuild leaves that
 * guarded `require` in place and `ws` falls back at runtime, while a direct import in app code fails the bundle by name. When the
 * project does install one, it stays external and the image installs the same version, since a native addon cannot be bundled.
 */
const OPTIONAL_NATIVE_MODULES = ["bufferutil", "utf-8-validate"] as const;

/**
 * Top-level wrangler keys the generated entry composes, or that configure the Worker rather than bind something into `env`.
 * Every other declared key is reported at deploy time as unbound: an allowlist, so a binding section wrangler adds later is
 * named rather than silently missing from the container. `durable_objects` is checked per binding, since an external one is unbound.
 */
const COMPOSED_OR_CONFIG_KEYS: ReadonlySet<string> = new Set([
    "$schema",
    "account_id",
    "alias",
    "base_dir",
    "build",
    "cache",
    "compatibility_date",
    "compatibility_flags",
    "define",
    "dev",
    "durable_objects",
    "env",
    "find_additional_modules",
    "first_party_worker",
    "hyperdrive",
    "jsx_factory",
    "jsx_fragment",
    "keep_names",
    "keep_vars",
    "legacy_env",
    "limits",
    "logpush",
    "main",
    "migrations",
    "minify",
    "name",
    "no_bundle",
    "node_compat",
    "observability",
    "placement",
    "preserve_file_names",
    "preview_urls",
    "route",
    "routes",
    "rules",
    "secrets",
    "secrets_store_secrets",
    "send_metrics",
    "streaming_tail_consumers",
    "tail_consumers",
    "triggers",
    "tsconfig",
    "upload_source_maps",
    "usage_model",
    "vars",
    "workers_dev",
]);

/** An environment variable name as a container runtime sets one. */
const ENV_NAME = /^[A-Z_a-z]\w*$/u;

/** Wrangler's rule for a binding name: a JavaScript identifier. A Durable Object binding's name is also a directory on the data volume. */
const BINDING_NAME = /^[A-Za-z_$][\w$]*$/u;

/** The prefix of the env vars the runtime reads as plain strings; `createNodeSecretBindings` refuses it as a secret name. */
const RUNTIME_ENV_PREFIX = "LUNORA_";

interface NodeWranglerConfig {
    durable_objects?: { bindings?: ReadonlyArray<{ class_name?: unknown; name?: unknown; script_name?: unknown } | null> };
    hyperdrive?: ReadonlyArray<{ binding?: unknown } | null>;
    main?: unknown;
    secrets?: unknown;
    secrets_store_secrets?: ReadonlyArray<{ binding?: unknown } | null>;
    vars?: Record<string, unknown> | null;
}

/** What the generated server entry composes, read from the project's wrangler config. */
interface NodeDeployProject {
    /** The `durable_objects.bindings[]` the server constructs. The binding named `SHARD` (else the first) also carries crons. */
    durableObjects: { className: string; name: string }[];
    /** The worker entry wrangler's `main` names, absolute. */
    entry: string;
    /** The Hyperdrive binding built from `DATABASE_URL`, when the app declares one. */
    hyperdrive: string | undefined;
    /** `secrets_store_secrets[].binding`: the names `ctx.secrets` reads, bound over env vars of the same name. */
    storeSecrets: string[];
    /** Declared wrangler bindings the entry leaves unbound: a section key, or `durable_objects.NAME` for an external class. */
    unbound: string[];
    /** Wrangler `vars` as declared (a JSON object stays an object, as on Cloudflare), baked in as defaults the environment overrides. */
    vars: Record<string, unknown>;
    /** `secrets.required`: plain-string secrets the worker reads from `env`. */
    workerSecrets: string[];
}

/** An environment variable the server reads, as listed in the README and the CLI's summary. */
interface NodeDeployEnvVariable {
    description: string;
    name: string;
    required: boolean;
}

interface NodeContainerArtifact {
    /** The build context, absolute. */
    directory: string;
    env: NodeDeployEnvVariable[];
    /** Every file this run wrote, relative to {@link NodeContainerArtifact.directory}. */
    files: string[];
    /** Declared wrangler bindings the server does not compose. */
    unbound: string[];
}

/** Whether a declared section binds anything: an empty list or object is no binding. */
const isDeclared = (value: unknown): boolean => {
    if (Array.isArray(value)) {
        return value.length > 0;
    }

    if (typeof value === "object" && value !== null) {
        return Object.keys(value).length > 0;
    }

    return value !== undefined && value !== null;
};

/**
 * Refuse a worker the Node deploy cannot bundle. A framework project's worker is produced by a Cloudflare-targeted framework
 * build — `@lunora/vite` composing `virtual:lunora/worker`, or an adapter's output wrapped by the composed `src/worker.ts` — and
 * this deploy runs no framework build, so it would bundle a file that does not exist or the adapter without Lunora's routes.
 */
const frameworkRefusal = (projectRoot: string, main: string, configName: string): string | undefined => {
    const reason = (detail: string): string =>
        `--target node bundles the worker file \`main\` names in ${configName}, and ${detail}. The Node container deploy does not run framework builds: point \`main\` at a hand-written worker entry that default-exports the fetch handler and exports ShardDO (the standalone template's shape), or deploy this app to Cloudflare`;

    if (main.startsWith("virtual:")) {
        return reason(`\`${main}\` is composed by a framework build, not a file`);
    }

    const entry = resolve(projectRoot, main);

    if (existsSync(join(projectRoot, COMPOSED_WORKER_ENTRY)) && entry !== resolve(projectRoot, COMPOSED_WORKER_ENTRY)) {
        return reason(`\`${main}\` is a framework adapter's output, which ${COMPOSED_WORKER_ENTRY} wraps for Cloudflare`);
    }

    if (!existsSync(entry)) {
        return reason(`\`${main}\` does not exist (a framework build writes it)`);
    }

    return undefined;
};

const stringNames = (entries: ReadonlyArray<{ binding?: unknown } | null> | undefined): string[] =>
    (entries ?? []).flatMap((entry) => (typeof entry?.binding === "string" ? [entry.binding] : []));

/**
 * The `secrets.required` names, or a throw naming the field when it is not a list of names. Dropping a malformed value would
 * deploy a server that starts without the secrets the app needs, the failure this check exists to prevent.
 */
const requiredSecretNames = (secrets: unknown, configName: string): string[] => {
    if (secrets === undefined || secrets === null) {
        return [];
    }

    const refuse = (problem: string): never => {
        throw new Error(
            `--target node checks every secrets.required name at startup, and ${problem} in ${configName}: secrets must be { "required": [...] }, an array of environment variable names such as ["API_KEY"]`,
        );
    };

    if (typeof secrets !== "object" || Array.isArray(secrets)) {
        return refuse(`secrets is ${JSON.stringify(secrets)}`);
    }

    // `required` is the object's only field: a misspelling ("require") would otherwise read as "no secrets" and skip the check.
    const unknown = Object.keys(secrets).filter((key) => key !== "required");

    if (unknown.length > 0) {
        return refuse(`secrets has ${unknown.map((key) => JSON.stringify(key)).join(", ")} instead of "required"`);
    }

    const { required } = secrets as { required?: unknown };

    if (!Array.isArray(required)) {
        return refuse(`secrets.required is ${JSON.stringify(required)}`);
    }

    // An environment variable name: anything else could never be set on a container, so the server could never start.
    const invalid = required.filter((name) => typeof name !== "string" || !ENV_NAME.test(name));

    if (invalid.length > 0) {
        return refuse(
            `secrets.required lists ${invalid.map((name) => JSON.stringify(name)).join(", ")}, which ${invalid.length === 1 ? "is not" : "are not"} an environment variable name`,
        );
    }

    return required as string[];
};

/**
 * Read what the server entry has to compose, or throw naming what is missing or unservable. Reads the wrangler config only, so the
 * deploy runs it before codegen writes anything.
 * @param projectRoot Directory containing the wrangler config.
 */
const readNodeDeployProject = (projectRoot: string): NodeDeployProject => {
    const configPath = findWranglerFile(projectRoot);

    if (configPath === undefined) {
        throw new Error("--target node bundles the worker entry wrangler.jsonc names in `main`, and this project has no wrangler config");
    }

    const configName = relative(projectRoot, configPath);
    const { parsed } = readWranglerJsonc<NodeWranglerConfig>(configPath);

    if (parsed === undefined || typeof parsed.main !== "string") {
        throw new Error(`--target node bundles the worker entry \`main\` names, and ${configName} has no \`main\``);
    }

    const refusal = frameworkRefusal(projectRoot, parsed.main, configName);

    if (refusal !== undefined) {
        throw new Error(refusal);
    }

    const durableObjects: NodeDeployProject["durableObjects"] = [];
    const external: string[] = [];

    for (const binding of parsed.durable_objects?.bindings ?? []) {
        if (typeof binding?.name !== "string" || typeof binding.class_name !== "string") {
            continue;
        }

        // The name becomes a directory under LUNORA_DATA_DIR: anything but an identifier ("..", "a/b") could put shard files
        // outside the data volume, where a replaced container loses them.
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

    if (durableObjects.length === 0) {
        throw new Error(`--target node serves the app's shard Durable Object, and ${configName} declares no durable_objects binding of its own`);
    }

    const hyperdrive = stringNames(parsed.hyperdrive);

    // One process has one DATABASE_URL; a second binding would need a naming scheme nothing reads yet.
    if (hyperdrive.length > 1) {
        throw new Error(
            `--target node builds the Hyperdrive binding from DATABASE_URL, so it serves one binding, and the app declares ${hyperdrive.join(", ")}`,
        );
    }

    const storeSecrets = stringNames(parsed.secrets_store_secrets);
    const reserved = storeSecrets.filter((name) => name.startsWith(RUNTIME_ENV_PREFIX));

    // `createNodeSecretBindings` throws on these at startup; refusing here keeps the deploy from writing an image that cannot start.
    if (reserved.length > 0) {
        throw new Error(
            `--target node binds secrets_store_secrets over env vars of the same name, and ${reserved.join(", ")} uses the reserved ${RUNTIME_ENV_PREFIX} prefix, which the runtime reads as a plain string. Rename the binding in ${configName}`,
        );
    }

    const workerSecrets = requiredSecretNames(parsed.secrets, configName);
    const declared = parsed as Record<string, unknown>;

    return {
        durableObjects,
        entry: resolve(projectRoot, parsed.main),
        hyperdrive: hyperdrive[0],
        storeSecrets,
        unbound: [...Object.keys(declared).filter((key) => !COMPOSED_OR_CONFIG_KEYS.has(key) && isDeclared(declared[key])), ...external],
        vars: { ...parsed.vars },
        workerSecrets,
    };
};

/** The environment the generated server reads, in the order the README lists it. */
const nodeDeployEnv = (project: NodeDeployProject): NodeDeployEnvVariable[] => [
    {
        description: "The public URL users open, e.g. `https://app.example`. Required whenever `HOST` is not loopback, which the image's `0.0.0.0` is.",
        name: "LUNORA_ORIGIN_URL",
        required: true,
    },
    { description: `Port to listen on (default \`${String(DEFAULT_PORT)}\`).`, name: "PORT", required: false },
    { description: "Interface to bind (default `127.0.0.1`; the image sets `0.0.0.0`).", name: "HOST", required: false },
    {
        description: `How long a shutdown waits for in-flight work before closing the databases anyway (default \`${String(DEFAULT_SHUTDOWN_TIMEOUT_MS)}\`). Keep it below the container's stop timeout.`,
        name: SHUTDOWN_TIMEOUT_VARIABLE,
        required: false,
    },
    {
        description: "Directory the SQLite databases live in (default `./data`; the image sets `/data`, its volume). Back it up; it is the app's data.",
        name: "LUNORA_DATA_DIR",
        required: false,
    },
    ...(project.hyperdrive === undefined
        ? []
        : [
              {
                  description: `Postgres or MySQL URL the \`${project.hyperdrive}\` Hyperdrive binding connects to. The server refuses to start without it.`,
                  name: "DATABASE_URL",
                  required: true,
              },
          ]),
    ...project.storeSecrets.map((name) => {
        return { description: "Read through `ctx.secrets`; rejected when unset or empty.", name, required: true };
    }),
    ...project.workerSecrets.map((name) => {
        return { description: "Worker secret (`secrets.required` in wrangler.jsonc). The server refuses to start without it.", name, required: true };
    }),
    ...Object.keys(project.vars).map((name) => {
        return { description: "A wrangler `var`; the bundled value applies unless this is set (an override is a string).", name, required: false };
    }),
];

/** A relative `import` specifier for `path`, resolved from the project root: esbuild resolves stdin there and takes no file URLs. */
const projectSpecifier = (projectRoot: string, path: string): string => `./${relative(projectRoot, path).split(sep).join("/")}`;

/**
 * The server entry: one process serving the worker over `@lunora/platform-node`.
 *
 * The shard binding's registry is the one `createNodePlatform` builds, so a cron tick reaches the same `ShardDO` instances HTTP
 * requests do. Every other binding gets a registry of its own. One instance per shard lives for the process, as the runtime keeps
 * one per object: an instance built per request would lose its in-memory subscribers between a subscribe and the write that
 * should reach them.
 *
 * Shutdown runs in a fixed order, each step whether or not an earlier one failed: refuse new requests, wait for the in-flight
 * ones to be written, close the listener (ending event streams and WebSockets), drain the worker's `waitUntil` work, drain every shard (in-flight requests, alarms, cron deliveries
 * and their `waitUntil` work), then close the databases. Only names reach this file, never a secret's value.
 */
const renderServerEntry = (projectRoot: string, project: NodeDeployProject, cronsModule: string): string => {
    const config = {
        durableObjects: project.durableObjects,
        hyperdrive: project.hyperdrive,
        requiredEnv: [...project.workerSecrets, ...(project.hyperdrive === undefined ? [] : ["DATABASE_URL"])],
        workerSecrets: project.workerSecrets,
        storeSecrets: project.storeSecrets,
        vars: project.vars,
    };
    const primary = project.durableObjects.find((binding) => binding.name === "SHARD") ?? project.durableObjects[0];
    // Named, not a namespace import: esbuild then fails the bundle when the entry does not export one of them, so an entry that
    // is not a Lunora worker (a framework adapter exporting only \`fetch\`) is refused at deploy time instead of at startup.
    const classNames = [...new Set(project.durableObjects.map((binding) => binding.className))];
    const classImports = classNames.map((className, index) => `${className} as __lunoraDurableObject${String(index)}`).join(", ");
    const classTable = classNames.map((className, index) => `${JSON.stringify(className)}: __lunoraDurableObject${String(index)}`).join(", ");

    return `import { mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import {
    bindShardSockets,
    createNodeHttpServer,
    createNodeHyperdrive,
    createNodePlatform,
    createNodeSecretBindings,
    createNodeShardNamespace,
    createNodeShardRegistry,
    createNodeShardState,
} from "@lunora/platform-node";

import handler, { ${classImports} } from ${JSON.stringify(projectSpecifier(projectRoot, project.entry))};
import { LUNORA_CRONS } from ${JSON.stringify(projectSpecifier(projectRoot, cronsModule))};

const CONFIG = ${JSON.stringify(config, undefined, 4)};
const PRIMARY_BINDING = ${JSON.stringify(primary?.name)};

// The error object, not its message: console.error prints its stack and its cause chain. Every log here passes a literal
// format string and its values as arguments, so a value that contains %s or %o prints as itself.
const logError = (message, error) => {
    console.error("lunora: %s", message, error);
};

const missing = CONFIG.requiredEnv.filter((name) => process.env[name] === undefined || process.env[name] === "");

if (missing.length > 0) {
    console.error("lunora: refusing to start, these required environment variables are not set: %s", missing.join(", "));
    process.exit(1);
}

// The whole drain shares one deadline, kept under \`docker stop\`'s default 10 s grace so the databases are closed before a kill.
// Checked here, before anything listens: Number() reads "8s" as NaN and "" as 0, either of which would skip the drain entirely.
const timeoutName = ${JSON.stringify(SHUTDOWN_TIMEOUT_VARIABLE)};
const rawShutdownTimeout = process.env[timeoutName];

// Node runs any timer delay above 2147483647 ms after 1 ms, so a larger value would cut the drain off at once.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

if (rawShutdownTimeout !== undefined && !(/^\\d+$/u.test(rawShutdownTimeout) && Number(rawShutdownTimeout) <= MAX_TIMER_DELAY_MS)) {
    console.error(
        "lunora: refusing to start, %s must be a whole number of milliseconds from 0 to %d, such as ${String(DEFAULT_SHUTDOWN_TIMEOUT_MS)}, and it is %j",
        timeoutName,
        MAX_TIMER_DELAY_MS,
        rawShutdownTimeout,
    );
    process.exit(1);
}

const shutdownTimeoutMs = rawShutdownTimeout === undefined ? ${String(DEFAULT_SHUTDOWN_TIMEOUT_MS)} : Number(rawShutdownTimeout);

const DURABLE_OBJECT_CLASSES = { ${classTable} };

if (typeof handler?.fetch !== "function") {
    throw new TypeError("lunora: the worker entry has no default export with a fetch handler");
}

const dataDirectory = resolve(process.env.LUNORA_DATA_DIR ?? "data");

mkdirSync(dataDirectory, { recursive: true });

// Only declared names reach env, as on Cloudflare: the wrangler vars, the secrets.required names, and what the runtime reads
// itself (LUNORA_*, PORT, DATABASE_URL). A container host's other variables (cloud credentials, another service's token) stay
// out of reach of app code. A var set in the environment overrides the bundled value as a string.
const RUNTIME_ENV = ["PORT", "DATABASE_URL"];
const env = { WORKER_ENV: "production", ...CONFIG.vars };
const declaredNames = new Set([
    ...Object.keys(CONFIG.vars),
    ...CONFIG.workerSecrets,
    ...RUNTIME_ENV,
    ...Object.keys(process.env).filter((name) => name.startsWith("LUNORA_")),
]);

for (const name of declaredNames) {
    const value = process.env[name];

    if (value !== undefined) {
        env[name] = value;
    }
}

Object.assign(env, createNodeSecretBindings(CONFIG.storeSecrets));

if (CONFIG.hyperdrive !== undefined) {
    env[CONFIG.hyperdrive] = createNodeHyperdrive(process.env.DATABASE_URL);
}

const instanceFactory = (className) => {
    const DurableObject = DURABLE_OBJECT_CLASSES[className];

    if (typeof DurableObject !== "function") {
        throw new TypeError(\`lunora: the worker entry does not export Durable Object class \${className}\`);
    }

    const instances = new WeakMap();

    return (shard) => {
        let instance = instances.get(shard);

        if (instance === undefined) {
            instance = new DurableObject(createNodeShardState(shard), env);
            instances.set(shard, instance);

            if (instance.webSocketClose !== undefined && instance.webSocketMessage !== undefined) {
                bindShardSockets(
                    { webSocketClose: instance.webSocketClose.bind(instance), webSocketMessage: instance.webSocketMessage.bind(instance) },
                    shard.inbound,
                );
            }
        }

        return instance;
    };
};

let platform;
const registries = [];

for (const binding of CONFIG.durableObjects) {
    const instanceFor = instanceFactory(binding.className);
    // Checked again here: the binding name was validated at deploy time, and the data directory must contain every shard file.
    const shardDirectory = resolve(dataDirectory, binding.name);

    if (!shardDirectory.startsWith(dataDirectory + sep)) {
        throw new Error(\`lunora: Durable Object binding \${JSON.stringify(binding.name)} would store shards outside \${dataDirectory}\`);
    }

    const handlers = {
        directory: shardDirectory,
        // The platform's own host fires this with no shard; only registry shards carry a Durable Object.
        onAlarm: async (shard) => {
            if (shard !== undefined) {
                await instanceFor(shard).alarm?.();
            }
        },
        onFetch: async (request, shard) => instanceFor(shard).fetch(request),
    };

    if (binding.name === PRIMARY_BINDING) {
        platform = createNodePlatform({ ...handlers, crons: LUNORA_CRONS, path: join(dataDirectory, "platform.sqlite3") });
        env[binding.name] = createNodeShardNamespace(platform.directory);
    } else {
        const registry = createNodeShardRegistry(handlers);

        registries.push(registry);
        env[binding.name] = createNodeShardNamespace(registry.directory);
    }
}

// Each set holds a settled-only copy of the work, so draining it never rejects; the work itself still reports its failure.
const track = (set, work) => {
    const settled = work.then(
        () => undefined,
        () => undefined,
    );

    set.add(settled);
    settled.finally(() => set.delete(settled));
};

/** Wait until \`set\` stays empty (work can add more work while it runs), or until the deadline passes. */
const drainSet = async (set, { timeoutMs }) => {
    let timer;
    const expired = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
    });

    try {
        while (set.size > 0) {
            if (!(await Promise.race([Promise.all(set).then(() => true), expired]))) {
                console.error("lunora: shutdown deadline passed with %d waitUntil task(s) still running", set.size);

                return { pending: [...set].map(() => "waitUntil work"), timedOut: true };
            }
        }

        return { pending: [], timedOut: false };
    } finally {
        clearTimeout(timer);
    }
};

const background = new Set();
const context = {
    passThroughOnException: () => undefined,
    waitUntil: (promise) => {
        track(
            background,
            Promise.resolve(promise).catch((error) => {
                logError("work handed to waitUntil failed", error);
            }),
        );
    },
};

let stopping = false;

const server = await createNodeHttpServer({
    fetch: async (request) => {
        if (stopping) {
            return new Response("lunora: shutting down", { headers: { connection: "close", "retry-after": "1" }, status: 503 });
        }

        return handler.fetch(request, env, context);
    },
    host: process.env.HOST,
    origin: process.env.LUNORA_ORIGIN_URL,
    port: Number(process.env.PORT ?? ${String(DEFAULT_PORT)}),
});

// One exit code for the whole process: a fatal error raised while a shutdown is already running must still end it non-zero.
let exitCode = 0;

const markFailed = () => {
    exitCode = 1;
};

const shutdown = async (code) => {
    if (code !== 0) {
        markFailed();
    }

    if (stopping) {
        return;
    }

    stopping = true;
    console.log("lunora: shutting down, draining in-flight work");

    // Until the last step has run, any exit is an incomplete shutdown: if the event loop runs empty while a step still waits
    // (a promise nothing will ever settle), Node ends the process itself, and it must neither look successful nor go unexplained.
    let currentStep = "starting the shutdown";
    let finished = false;

    process.exitCode = 1;
    process.once("exit", () => {
        if (!finished) {
            console.error("lunora: the process exited before the shutdown finished, while %s; the databases may not have been closed", currentStep);
        }
    });

    const deadlineAt = Date.now() + shutdownTimeoutMs;
    const remaining = () => ({ timeoutMs: Math.max(0, deadlineAt - Date.now()) });

    // A failed step is logged and the rest still run, so the databases are closed whatever went wrong before them. A drain that
    // ran out of time counts as a failure: the work it names was cut off.
    const step = async (label, run) => {
        currentStep = label;

        try {
            const results = [await run()].flat();

            if (results.some((result) => result?.timedOut === true)) {
                markFailed();
            }
        } catch (error) {
            markFailed();
            logError(\`\${label} failed during shutdown\`, error);
        }
    };

    // Stops the listener, then waits for the responses in flight when it began; event streams and WebSockets are left to close().
    await step("waiting for in-flight requests", () => server.drain(remaining()));
    await step("closing the HTTP server", () => server.close());
    await step("draining waitUntil work", () => drainSet(background, remaining()));
    await step("draining shards", () => Promise.all([platform?.drain(remaining()), ...registries.map((registry) => registry.drain(remaining()))]));
    await step("closing shards", () => {
        for (const registry of registries) {
            registry.close();
        }

        platform?.close();
    });

    // The last steps can settle on microtasks alone, and Node reports an unhandled rejection only once the event loop turns:
    // one turn here lets a fatal error raised at the very end of the drain reach its handler and the exit code.
    await new Promise((resolve) => {
        setImmediate(resolve);
    });

    finished = true;
    console.log("lunora: stopped");
    process.exit(exitCode);
};

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        if (stopping) {
            // A second signal is the operator insisting: stop waiting for work that may never settle.
            console.error("lunora: %s again, exiting without waiting", signal);
            process.exit(1);
        }

        void shutdown(0);
    });
}

process.on("unhandledRejection", (reason) => {
    logError("unhandled rejection", reason);
    void shutdown(1);
});

process.on("uncaughtException", (error) => {
    logError("uncaught exception", error);
    void shutdown(1);
});

// Printed last, once the signal and error handlers exist: a SIGTERM sent as soon as this line appears must reach the graceful
// shutdown, not the default action that kills the process outright.
const publicUrl = process.env.LUNORA_ORIGIN_URL;

if (publicUrl === undefined || publicUrl === "") {
    console.log("lunora: listening on %s", server.origin);
} else {
    console.log("lunora: listening on %s (public URL %s)", server.origin, publicUrl);
}
`;
};

const renderDockerfile = (): string => `# Generated by \`lunora deploy --target node\`. Build: docker build -t <image> .
#
# The build stage compiles better-sqlite3 from source against this image's Node and libc, the one
# native module the bundled server.mjs leaves to node_modules. npm ci installs exactly the tree
# package-lock.json pins, so a rebuild of this context installs the same dependencies.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN apt-get update \\
    && apt-get install -y --no-install-recommends g++ make python3 \\
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --build-from-source --no-audit --no-fund

FROM ${NODE_IMAGE}
ENV NODE_ENV=production HOST=0.0.0.0 PORT=${String(DEFAULT_PORT)} LUNORA_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json server.mjs ./
# The official image ships an unprivileged \`node\` user; the data volume must be writable by it.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE ${String(DEFAULT_PORT)}
CMD ["node", "server.mjs"]
`;

// An allowlist: the context is reused across deploys, so a file left in it (a copied database, a .env) must not reach the builder.
const DOCKERIGNORE = `# Generated by \`lunora deploy --target node\`. Only what the Dockerfile copies reaches the build context.
*
!package.json
!package-lock.json
!server.mjs
`;

const renderReadme = (env: ReadonlyArray<NodeDeployEnvVariable>): string => {
    const rows = env.map((variable) => `| \`${variable.name}\` | ${variable.required ? "yes" : "no"} | ${variable.description} |`);

    return `# Lunora Node container

Generated by \`lunora deploy --target node\`; rerun it to rebuild. Every file here is overwritten.

\`\`\`sh
docker build -t my-app .
docker run -p ${String(DEFAULT_PORT)}:${String(DEFAULT_PORT)} -v my-app-data:/data -e LUNORA_ORIGIN_URL=http://localhost:${String(DEFAULT_PORT)} my-app
\`\`\`

Without Docker: \`npm install\` here, then \`node server.mjs\`.

## Data

Every shard, the scheduler and the crons live in SQLite files under \`LUNORA_DATA_DIR\` (\`/data\` in the
image, declared as a volume). Mount a persistent volume there; a container without one loses every row when
it is removed. Run one container per volume: two processes on the same files both fire every cron.

The image runs as its \`node\` user (uid 1000). A named volume inherits the image's \`/data\` ownership; a
bind-mounted host directory must be writable by uid 1000, or the server fails at startup.

## Shutdown

On SIGTERM or SIGINT the server stops accepting connections, waits for the requests in flight at that moment,
then waits for background work, alarms and cron runs before closing the databases and exiting. Event streams
and WebSockets are closed rather than waited for. The whole drain is bounded by \`${SHUTDOWN_TIMEOUT_VARIABLE}\`
(default ${String(DEFAULT_SHUTDOWN_TIMEOUT_MS)} ms, under \`docker stop\`'s 10 s grace); work still running then is logged by name
and the server exits with code 1. A second signal exits without waiting.

## Environment

Only declared names reach the worker's \`env\`, as on Cloudflare: the wrangler \`vars\`, the \`secrets.required\`
names, the \`secrets_store_secrets\` bindings, and what the runtime reads itself (\`LUNORA_*\`, \`PORT\`,
\`DATABASE_URL\`). Any other variable on the container stays out of reach of app code, so a secret the app reads
must be listed in \`secrets.required\` in wrangler.jsonc. No value is baked into \`server.mjs\`, this README or
the Dockerfile; they carry names only.

| Variable | Required | |
| --- | --- | --- |
${rows.join("\n")}
`;
};

/** Resolve `specifier` as the project would, or `undefined` when it is not installed there. */
const resolveFromProject = (projectRoot: string, specifier: string): string | undefined => {
    try {
        return createRequire(join(projectRoot, "package.json")).resolve(specifier);
    } catch {
        return undefined;
    }
};

/** The installed version of `specifier`, resolved from `from` (a file inside the package that depends on it). */
const installedVersion = (from: string, specifier: string): string | undefined => {
    try {
        const manifest = createRequire(from).resolve(`${specifier}/package.json`);

        return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
    } catch {
        return undefined;
    }
};

/** The esbuild error for a module nothing installs, named so the deploy can say which dependency to add. */
const UNRESOLVED_MODULE = /^Could not resolve "([^"]+)"$/u;

/**
 * Generate `package-lock.json` for the build context, so the image's `npm ci` installs exactly this tree: `better-sqlite3`'s
 * own dependencies (`prebuild-install` and its install script among them) would otherwise float on every rebuild. Resolved
 * from the registry, so it needs npm and network access at deploy time; without them the deploy stops rather than shipping an
 * unpinned build.
 */
const writeLockfile = async (directory: string, spawner: Spawner): Promise<void> => {
    const result = await spawner({
        args: ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
        captureStderrSilently: true,
        captureStdoutSilently: true,
        command: "npm",
        cwd: directory,
    });

    if (result.code !== 0 || !existsSync(join(directory, "package-lock.json"))) {
        throw new Error(
            `--target node pins the image's build dependencies in a package-lock.json, and \`npm install --package-lock-only\` could not write one (exit ${String(result.code)}${result.stderr === undefined || result.stderr.trim() === "" ? "" : `: ${result.stderr.trim().split("\n").at(-1) ?? ""}`}). It needs npm and access to the registry.`,
        );
    }
};

interface EsbuildApi {
    build: (options: Record<string, unknown>) => Promise<{ errors: unknown[] }>;
}

interface EsbuildFailure {
    errors?: ReadonlyArray<{ text?: string }>;
}

const MISSING_EXPORT = /^No matching export in "[^"]+" for import "([^"]+)"$/u;

/**
 * The deploy's own message for an entry that lacks the default fetch handler or a bound Durable Object class: esbuild's
 * "No matching export" names the symptom, this names the cause and the fix. `undefined` for any other failure.
 */
const missingExportRefusal = (error: unknown, project: NodeDeployProject, projectRoot: string): Error | undefined => {
    const missing = ((error as EsbuildFailure).errors ?? []).flatMap((entry) => {
        const name = MISSING_EXPORT.exec(entry.text ?? "")?.[1];

        if (name === undefined) {
            return [];
        }

        return [name === "default" ? "a default export with the fetch handler" : name];
    });

    if (missing.length === 0) {
        return undefined;
    }

    return new Error(
        `--target node serves the worker entry \`main\` names (${relative(projectRoot, project.entry)}), and it does not export ${missing.join(", ")}. The entry must default-export the fetch handler and export every Durable Object class wrangler binds, as the standalone template's src/server.ts does. A framework adapter's output is not such an entry: the Node container deploy does not run framework builds, so deploy this app to Cloudflare or point \`main\` at a hand-written worker entry`,
        { cause: error },
    );
};

/** The deploy's message for an app import of an optional native module the project does not install. */
const unresolvedOptionalRefusal = (error: unknown): Error | undefined => {
    const missing = ((error as EsbuildFailure).errors ?? [])
        .map((entry) => UNRESOLVED_MODULE.exec(entry.text ?? "")?.[1])
        .filter((name): name is string => name !== undefined && (OPTIONAL_NATIVE_MODULES as ReadonlyArray<string>).includes(name));

    if (missing.length === 0) {
        return undefined;
    }

    return new Error(
        `--target node bundles the app, and it imports ${missing.join(", ")}, which this project does not install. Add it as a dependency so the image builds it.`,
        {
            cause: error,
        },
    );
};

/** Bundle the generated entry and the app into `server.mjs`. */
const bundleServer = async (esbuild: EsbuildApi, directory: string, contents: string, projectRoot: string, external: ReadonlyArray<string>): Promise<void> => {
    await esbuild.build({
        // CommonJS dependencies bundled into ESM still call `require` for Node built-ins.
        banner: { js: `import { createRequire as __lunoraCreateRequire } from "node:module";\nconst require = __lunoraCreateRequire(import.meta.url);` },
        bundle: true,
        external: [...external],
        format: "esm",
        legalComments: "none",
        logLevel: "silent",
        outfile: join(directory, "server.mjs"),
        platform: "node",
        stdin: { contents, loader: "js", resolveDir: projectRoot, sourcefile: "lunora-node-server.mjs" },
        target: "node22",
    });
};

/**
 * Build the container context for the app at `projectRoot`. Codegen must already have run for the node target: the entry imports
 * `_generated/*`.
 * @throws when the wrangler config names no entry or no Durable Object, or esbuild or `@lunora/platform-node` is not installed.
 */
const buildNodeContainer = async (projectRoot: string, spawner: Spawner): Promise<NodeContainerArtifact> => {
    const project = readNodeDeployProject(projectRoot);
    const platformNodeManifest = resolveFromProject(projectRoot, "@lunora/platform-node/package.json");

    if (platformNodeManifest === undefined) {
        throw new Error("--target node runs the app on @lunora/platform-node, which this project does not install. Add it as a dependency.");
    }

    const esbuildPath = resolveFromProject(projectRoot, "esbuild");

    if (esbuildPath === undefined) {
        throw new Error("--target node bundles the server with esbuild, which this project does not install. Add it as a dev dependency.");
    }

    // esbuild ships CommonJS, and a `require` scoped to the project needs no dynamic `import()` of a computed path, which the
    // CLI's bundler cannot analyse.
    const esbuild = createRequire(join(projectRoot, "package.json"))(esbuildPath) as EsbuildApi;
    const cronsModule = join(resolve(projectRoot, resolveSchemaDirectory(projectRoot)), "_generated", "crons.ts");

    if (!existsSync(cronsModule)) {
        throw new Error(`--target node bundles ${relative(projectRoot, cronsModule)}, which codegen did not write — run \`lunora codegen --target node\``);
    }

    const directory = join(projectRoot, NODE_DEPLOY_DIRECTORY);

    mkdirSync(directory, { recursive: true });

    // Optional native modules the project installs stay external and ship in the image at the same version.
    const optional = Object.fromEntries(
        OPTIONAL_NATIVE_MODULES.flatMap((name) => {
            const version = installedVersion(join(projectRoot, "package.json"), name);

            return version === undefined ? [] : [[name, version]];
        }),
    );

    try {
        await bundleServer(esbuild, directory, renderServerEntry(projectRoot, project, cronsModule), projectRoot, ["better-sqlite3", ...Object.keys(optional)]);
    } catch (error: unknown) {
        throw missingExportRefusal(error, project, projectRoot) ?? unresolvedOptionalRefusal(error) ?? error;
    }

    const sqliteVersion = installedVersion(platformNodeManifest, "better-sqlite3");

    if (sqliteVersion === undefined) {
        throw new Error("--target node installs the better-sqlite3 the project's @lunora/platform-node runs on, and it cannot be resolved from there.");
    }

    const env = nodeDeployEnv(project);
    const manifest = {
        dependencies: { "better-sqlite3": sqliteVersion, ...optional },
        engines: { node: ">=22.15.0" },
        name: "lunora-node-server",
        private: true,
        type: "module",
    };

    writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, undefined, 4)}\n`, "utf8");
    // A previous deploy's lockfile would pin the previous manifest; npm would reuse what still fits rather than resolve afresh.
    rmSync(join(directory, "package-lock.json"), { force: true });
    await writeLockfile(directory, spawner);
    writeFileSync(join(directory, "Dockerfile"), renderDockerfile(), "utf8");
    writeFileSync(join(directory, ".dockerignore"), DOCKERIGNORE, "utf8");
    writeFileSync(join(directory, "README.md"), renderReadme(env), "utf8");

    return { directory, env, files: [".dockerignore", "Dockerfile", "package-lock.json", "package.json", "README.md", "server.mjs"], unbound: project.unbound };
};

export type { NodeContainerArtifact, NodeDeployEnvVariable };
export { buildNodeContainer, NODE_DEPLOY_DIRECTORY, NODE_IMAGE, readNodeDeployProject };
