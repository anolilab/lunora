/**
 * A Postgres for `lunora dev` behind a Hyperdrive binding.
 *
 * Wrangler refuses to start a dev session for a Hyperdrive binding that has no
 * local database to dial, and a developer who has not set one up gets an error
 * naming an environment variable. Here that database is an embedded PGlite
 * (real Postgres compiled to WASM) behind its wire-protocol socket server, so
 * `ctx.sql` works with no Docker and no account. Its data directory sits under
 * `.wrangler/`, so rows survive a restart.
 *
 * Only a binding with nothing of its own is served: an explicit
 * `localConnectionString` in `wrangler.jsonc`, or the environment variable wrangler
 * reads, always wins. The connection string is handed to wrangler through that
 * same variable, which both `wrangler dev` and the Cloudflare Vite plugin read
 * when they resolve bindings, so it never touches the user's config file.
 *
 * `@electric-sql/pglite` and `@electric-sql/pglite-socket` are optional peers,
 * loaded on demand: an app without Hyperdrive never pays for them.
 */
import { mkdirSync } from "node:fs";

import join from "../path";
import { findWranglerFile, readWranglerJsonc } from "./wrangler-path";

/** Wrangler's variable for a binding's local database; the `WRANGLER_` spelling is its deprecated twin. */
const LOCAL_CONNECTION_STRING_PREFIXES = ["CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_", "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_"] as const;

/** The variable that points wrangler at `binding`'s local database. */
const variableFor = (binding: string): string => `${LOCAL_CONNECTION_STRING_PREFIXES[0]}${binding}`;

/** The two packages PGlite is served from, and the install line a missing one is told to run. */
const INSTALL_HINT = "pnpm add -D @electric-sql/pglite @electric-sql/pglite-socket";

/** The slice of PGlite this module drives, so a test can stand in for the WASM engine. */
interface PgliteRuntime {
    createServer: (dataDirectory: string) => Promise<{ connectionString: string; stop: () => Promise<void> }>;
}

interface StartLocalHyperdriveOptions {
    /** Defaults to `process.env`; the connection strings are written here and removed again by `stop`. */
    env?: NodeJS.ProcessEnv;
    /** Injection seam; defaults to the real PGlite. Resolves `undefined` when it is not installed. */
    load?: () => Promise<PgliteRuntime | undefined>;
    /** Called once with a line to show the developer when the database could not be started. */
    onWarning?: (message: string) => void;
    projectRoot: string;
}

interface LocalHyperdrive {
    /** The bindings served by PGlite. */
    bindings: string[];
    stop: () => Promise<void>;
}

/** Whether wrangler would find a local database for `binding` without help. */
const hasLocalDatabase = (binding: string, entry: { localConnectionString?: unknown }, env: NodeJS.ProcessEnv): boolean =>
    (typeof entry.localConnectionString === "string" && entry.localConnectionString !== "") ||
    LOCAL_CONNECTION_STRING_PREFIXES.some((prefix) => (env[`${prefix}${binding}`] ?? "") !== "");

/** The Hyperdrive bindings in `wrangler.jsonc` that nothing local backs yet. */
const bindingsNeedingDatabase = (projectRoot: string, env: NodeJS.ProcessEnv): string[] => {
    const wranglerPath = findWranglerFile(projectRoot);
    const parsed =
        wranglerPath === undefined
            ? undefined
            : readWranglerJsonc<{ hyperdrive?: ReadonlyArray<{ binding?: string; localConnectionString?: string } | null> }>(wranglerPath).parsed;

    return (parsed?.hyperdrive ?? []).flatMap((entry) =>
        typeof entry?.binding === "string" && entry.binding !== "" && !hasLocalDatabase(entry.binding, entry, env) ? [entry.binding] : [],
    );
};

/** The real PGlite, or `undefined` when either package is not installed. */
const loadPglite = async (): Promise<PgliteRuntime | undefined> => {
    try {
        const [{ PGlite }, { PGLiteSocketServer }] = await Promise.all([import("@electric-sql/pglite"), import("@electric-sql/pglite-socket")]);
        // Optional: pgvector ships separately, and `CREATE EXTENSION vector` needs it loaded.
        const vector = await import("@electric-sql/pglite-pgvector").then(
            (module_) => module_.vector,
            (): undefined => undefined,
        );

        return {
            createServer: async (dataDirectory) => {
                const database = await PGlite.create({ dataDir: dataDirectory, ...(vector === undefined ? {} : { extensions: { vector } }) });
                // Port 0 lets the OS pick a free one; a pool opens several connections, which PGlite's single-connection default would refuse.
                const server = new PGLiteSocketServer({ db: database, host: "127.0.0.1", maxConnections: 16, port: 0 });

                await server.start();

                const [host = "127.0.0.1", port = "5432"] = server.getServerConn().split(":");

                return {
                    // PGlite authenticates as "trust", so these credentials are placeholders.
                    connectionString: `postgres://postgres:postgres@${host}:${port}/postgres`, // gitleaks:allow
                    stop: async () => {
                        await server.stop();
                        await database.close();
                    },
                };
            },
        };
    } catch {
        return undefined;
    }
};

/**
 * Start a PGlite for every Hyperdrive binding with no local database, and point
 * wrangler at it through its environment variable. Resolves `undefined` when
 * there is nothing to serve, or when PGlite is not installed (after saying how
 * to install it).
 */
const startLocalHyperdrive = async (options: StartLocalHyperdriveOptions): Promise<LocalHyperdrive | undefined> => {
    const env = options.env ?? process.env;
    const bindings = bindingsNeedingDatabase(options.projectRoot, env);

    if (bindings.length === 0) {
        return undefined;
    }

    const runtime = await (options.load ?? loadPglite)();

    if (runtime === undefined) {
        options.onWarning?.(
            `Hyperdrive binding ${bindings.map((binding) => `"${binding}"`).join(", ")} has no local database, so \`ctx.sql\` cannot connect in dev. ` +
                `Run \`${INSTALL_HINT}\` for an embedded Postgres, or set ${variableFor(bindings[0] ?? "<BINDING>")}.`,
        );

        return undefined;
    }

    const started: { binding: string; stop: () => Promise<void> }[] = [];

    try {
        for (const binding of bindings) {
            const directory = join(options.projectRoot, ".wrangler", "state", "lunora-pglite", binding);

            mkdirSync(directory, { recursive: true });

            // Sequential: two engines booting at once contend for the same WASM instantiation.
            // eslint-disable-next-line no-await-in-loop
            const server = await runtime.createServer(directory);

            started.push({ binding, stop: server.stop });
            env[variableFor(binding)] = server.connectionString;
        }
    } catch (error) {
        options.onWarning?.(`Could not start the embedded Postgres for Hyperdrive: ${error instanceof Error ? error.message : String(error)}`);

        await Promise.allSettled(started.map(async (server) => server.stop()));

        for (const { binding } of started) {
            Reflect.deleteProperty(env, variableFor(binding));
        }

        return undefined;
    }

    return {
        bindings: started.map(({ binding }) => binding),
        stop: async () => {
            for (const { binding } of started) {
                Reflect.deleteProperty(env, variableFor(binding));
            }

            await Promise.allSettled(started.map(async (server) => server.stop()));
        },
    };
};

export type { LocalHyperdrive, PgliteRuntime, StartLocalHyperdriveOptions };
export { bindingsNeedingDatabase, startLocalHyperdrive };
