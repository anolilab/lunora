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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";

import { resolveSchemaDirectory } from "@lunora/config";
import { findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

/** Where the build context is written, relative to the project root. `.lunora/` is already the CLI's gitignored state directory. */
const NODE_DEPLOY_DIRECTORY = join(".lunora", "deploy", "node");

/**
 * The image both stages build on: an exact Node LTS release, so a rebuild months later runs the same runtime. Debian rather than
 * Alpine because `better-sqlite3`'s native build and prebuilt binaries both target glibc.
 */
const NODE_IMAGE = "node:24.11.1-bookworm-slim";

/** The port the server listens on when `PORT` is unset, matching `wrangler dev`'s default. */
const DEFAULT_PORT = 8787;

/** Native or optional modules the bundle leaves to `node_modules`: `better-sqlite3` is a native addon; `ws` probes the other two. */
const EXTERNAL_MODULES = ["better-sqlite3", "bufferutil", "utf-8-validate"] as const;

/**
 * Wrangler keys that declare a binding the generated entry does not compose. Each is named at deploy time, so a request that
 * reads one fails where the operator was already told it would rather than in production.
 */
const UNBOUND_BINDING_KEYS = [
    "ai",
    "analytics_engine_datasets",
    "assets",
    "browser",
    "containers",
    "d1_databases",
    "images",
    "kv_namespaces",
    "pipelines",
    "queues",
    "r2_buckets",
    "send_email",
    "services",
    "vectorize",
    "workflows",
] as const;

interface NodeWranglerConfig {
    durable_objects?: { bindings?: ReadonlyArray<{ class_name?: unknown; name?: unknown; script_name?: unknown }> };
    hyperdrive?: ReadonlyArray<{ binding?: unknown } | null>;
    main?: unknown;
    secrets?: { required?: unknown } | null;
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
    /** Declared wrangler bindings the entry leaves unbound, by key. */
    unbound: string[];
    /** Plain `vars`, baked in as defaults the process environment overrides. */
    vars: Record<string, string>;
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
    /** Declared wrangler bindings the server does not compose, by key. */
    unbound: string[];
}

const stringNames = (entries: ReadonlyArray<{ binding?: unknown } | null> | undefined): string[] =>
    (entries ?? []).flatMap((entry) => (typeof entry?.binding === "string" ? [entry.binding] : []));

/**
 * Read what the server entry has to compose, or throw naming what is missing or unservable.
 * @param projectRoot Directory containing the wrangler config.
 */
const readNodeDeployProject = (projectRoot: string): NodeDeployProject => {
    const configPath = findWranglerFile(projectRoot);

    if (configPath === undefined) {
        throw new Error("--target node bundles the worker entry wrangler.jsonc names in `main`, and this project has no wrangler config");
    }

    const { parsed } = readWranglerJsonc<NodeWranglerConfig>(configPath);

    if (parsed === undefined || typeof parsed.main !== "string") {
        throw new Error(`--target node bundles the worker entry \`main\` names, and ${relative(projectRoot, configPath)} has no \`main\``);
    }

    const durableObjects: NodeDeployProject["durableObjects"] = [];

    for (const binding of parsed.durable_objects?.bindings ?? []) {
        // A binding to another worker's class has no class in this entry to construct.
        if (typeof binding.name === "string" && typeof binding.class_name === "string" && binding.script_name === undefined) {
            durableObjects.push({ className: binding.class_name, name: binding.name });
        }
    }

    if (durableObjects.length === 0) {
        throw new Error(`--target node serves the app's shard Durable Object, and ${relative(projectRoot, configPath)} declares no durable_objects binding`);
    }

    const hyperdrive = stringNames(parsed.hyperdrive);

    // One process has one DATABASE_URL; a second binding would need a naming scheme nothing reads yet.
    if (hyperdrive.length > 1) {
        throw new Error(
            `--target node builds the Hyperdrive binding from DATABASE_URL, so it serves one binding, and the app declares ${hyperdrive.join(", ")}`,
        );
    }

    const variables: Record<string, string> = {};

    for (const [name, value] of Object.entries(parsed.vars ?? {})) {
        variables[name] = typeof value === "string" ? value : JSON.stringify(value);
    }

    const required = parsed.secrets?.required;
    const declared = parsed as Record<string, unknown>;

    return {
        durableObjects,
        entry: resolve(projectRoot, parsed.main),
        hyperdrive: hyperdrive[0],
        storeSecrets: stringNames(parsed.secrets_store_secrets),
        unbound: UNBOUND_BINDING_KEYS.filter((key) => {
            const value = declared[key];

            return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
        }),
        vars: variables,
        workerSecrets: Array.isArray(required) ? required.filter((name): name is string => typeof name === "string") : [],
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
        description: "Directory the SQLite databases live in (default `./data`; the image sets `/data`, its volume). Back it up; it is the app's data.",
        name: "LUNORA_DATA_DIR",
        required: false,
    },
    ...(project.hyperdrive === undefined
        ? []
        : [{ description: `Postgres or MySQL URL the \`${project.hyperdrive}\` Hyperdrive binding connects to.`, name: "DATABASE_URL", required: true }]),
    ...project.storeSecrets.map((name) => {
        return { description: "Read through `ctx.secrets`; rejected when unset or empty.", name, required: true };
    }),
    ...project.workerSecrets.map((name) => {
        return { description: "Worker secret (`secrets.required` in wrangler.jsonc).", name, required: true };
    }),
    ...Object.keys(project.vars).map((name) => {
        return { description: "A wrangler `var`; the bundled value applies unless this is set.", name, required: false };
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
 */
const renderServerEntry = (projectRoot: string, project: NodeDeployProject, cronsModule: string): string => {
    const config = {
        durableObjects: project.durableObjects,
        hyperdrive: project.hyperdrive,
        storeSecrets: project.storeSecrets,
        vars: project.vars,
    };
    const primary = project.durableObjects.find((binding) => binding.name === "SHARD") ?? project.durableObjects[0];

    return `import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

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

import * as worker from ${JSON.stringify(projectSpecifier(projectRoot, project.entry))};
import { LUNORA_CRONS } from ${JSON.stringify(projectSpecifier(projectRoot, cronsModule))};

const CONFIG = ${JSON.stringify(config, undefined, 4)};
const PRIMARY_BINDING = ${JSON.stringify(primary?.name)};

const handler = worker.default;

if (typeof handler?.fetch !== "function") {
    throw new TypeError("lunora: the worker entry has no default export with a fetch handler");
}

const dataDirectory = resolve(process.env.LUNORA_DATA_DIR ?? "data");

mkdirSync(dataDirectory, { recursive: true });

const env = { WORKER_ENV: "production", ...CONFIG.vars };

for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) {
        env[name] = value;
    }
}

Object.assign(env, createNodeSecretBindings(CONFIG.storeSecrets));

if (CONFIG.hyperdrive !== undefined) {
    env[CONFIG.hyperdrive] = createNodeHyperdrive(process.env.DATABASE_URL);
}

const instanceFactory = (className) => {
    const DurableObject = worker[className];

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
    const handlers = {
        directory: join(dataDirectory, binding.name),
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

const pending = new Set();
const context = {
    passThroughOnException: () => undefined,
    waitUntil: (promise) => {
        const tracked = Promise.resolve(promise)
            .catch(() => undefined)
            .finally(() => pending.delete(tracked));

        pending.add(tracked);
    },
};

const server = await createNodeHttpServer({
    fetch: async (request) => handler.fetch(request, env, context),
    host: process.env.HOST,
    origin: process.env.LUNORA_ORIGIN_URL,
    port: Number(process.env.PORT ?? ${String(DEFAULT_PORT)}),
});

console.log(\`lunora: listening on \${server.origin}\`);

let stopping = false;

const stop = async () => {
    if (stopping) {
        return;
    }

    stopping = true;
    await server.close();
    await Promise.all(pending);
    await platform?.drain();

    for (const registry of registries) {
        registry.close();
    }

    platform?.close();
};

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
        stop().then(
            () => process.exit(0),
            (error) => {
                console.error(error);
                process.exit(1);
            },
        );
    });
}
`;
};

const renderDockerfile = (): string => `# Generated by \`lunora deploy --target node\`. Build: docker build -t <image> .
#
# The build stage compiles better-sqlite3 from source against this image's Node and libc, the one
# native module the bundled server.mjs leaves to node_modules.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN apt-get update \\
    && apt-get install -y --no-install-recommends g++ make python3 \\
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev --build-from-source --no-audit --no-fund

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

const DOCKERIGNORE = `# Generated by \`lunora deploy --target node\`.
node_modules
data
*.sqlite3*
.env*
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

## Environment

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

/** The `better-sqlite3` version the project's `@lunora/platform-node` runs on, so the image installs the same one. */
const betterSqliteVersion = (platformNodeManifest: string): string => {
    const manifest = createRequire(platformNodeManifest).resolve("better-sqlite3/package.json");

    return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
};

interface EsbuildApi {
    build: (options: Record<string, unknown>) => Promise<{ errors: unknown[] }>;
}

/**
 * Build the container context for the app at `projectRoot`. Codegen must already have run for the node target: the entry imports
 * `_generated/*`.
 * @throws when the wrangler config names no entry or no Durable Object, or esbuild or `@lunora/platform-node` is not installed.
 */
const buildNodeContainer = async (projectRoot: string): Promise<NodeContainerArtifact> => {
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

    await esbuild.build({
        // CommonJS dependencies bundled into ESM still call `require` for Node built-ins.
        banner: { js: `import { createRequire as __lunoraCreateRequire } from "node:module";\nconst require = __lunoraCreateRequire(import.meta.url);` },
        bundle: true,
        external: [...EXTERNAL_MODULES],
        format: "esm",
        legalComments: "none",
        logLevel: "silent",
        outfile: join(directory, "server.mjs"),
        platform: "node",
        stdin: { contents: renderServerEntry(projectRoot, project, cronsModule), loader: "js", resolveDir: projectRoot, sourcefile: "lunora-node-server.mjs" },
        target: "node22",
    });

    const env = nodeDeployEnv(project);
    const manifest = {
        dependencies: { "better-sqlite3": betterSqliteVersion(platformNodeManifest) },
        engines: { node: ">=22.15.0" },
        name: "lunora-node-server",
        private: true,
        type: "module",
    };

    writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, undefined, 4)}\n`, "utf8");
    writeFileSync(join(directory, "Dockerfile"), renderDockerfile(), "utf8");
    writeFileSync(join(directory, ".dockerignore"), DOCKERIGNORE, "utf8");
    writeFileSync(join(directory, "README.md"), renderReadme(env), "utf8");

    return { directory, env, files: [".dockerignore", "Dockerfile", "package.json", "README.md", "server.mjs"], unbound: project.unbound };
};

export type { NodeContainerArtifact, NodeDeployEnvVariable };
export { buildNodeContainer, NODE_DEPLOY_DIRECTORY, NODE_IMAGE };
