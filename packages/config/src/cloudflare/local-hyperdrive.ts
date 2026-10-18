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
import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

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

/** The slice of PGlite and its socket server that {@link serveDatabase} drives, so a test can stand in for them. */
interface PgliteParts {
    PGlite: { create: (options: { dataDir: string; extensions?: Record<string, unknown> }) => Promise<{ close: () => Promise<void> }> };
    PGLiteSocketServer: new (options: { db: never; host: string; maxConnections: number; port: number }) => {
        getServerConn: () => string;
        start: () => Promise<void>;
        stop: () => Promise<void>;
    };
    vector?: unknown;
}

/**
 * Open a persistent PGlite in `dataDirectory` and serve it on a free loopback port. A server that
 * fails to start closes the database it opened, because the caller gets no handle to do it with.
 */
const serveDatabase = async (
    { PGlite, PGLiteSocketServer, vector }: PgliteParts,
    dataDirectory: string,
): Promise<{ connectionString: string; stop: () => Promise<void> }> => {
    const database = await PGlite.create({ dataDir: dataDirectory, ...(vector === undefined ? {} : { extensions: { vector } }) });
    // Port 0 lets the OS pick a free one; a pool opens several connections, which PGlite's single-connection default would refuse.
    const server = new PGLiteSocketServer({ db: database as never, host: "127.0.0.1", maxConnections: 16, port: 0 });

    try {
        await server.start();
    } catch (error) {
        await Promise.allSettled([server.stop(), database.close()]);

        throw error;
    }

    const [host = "127.0.0.1", port = "5432"] = server.getServerConn().split(":");

    return {
        // PGlite authenticates as "trust", so these credentials are placeholders.
        connectionString: `postgres://postgres:postgres@${host}:${port}/postgres`, // gitleaks:allow
        stop: async () => {
            await server.stop();
            await database.close();
        },
    };
};

const UNSAFE_PATH_CHARACTER = /[^\w-]/gu;

/**
 * A directory name for a binding that cannot leave the state directory. A name with anything but
 * letters, digits, `_` and `-` (so no `..`, no separator) is cleaned and closed with a short hash of
 * the original, which keeps two such names apart.
 */
const directoryNameFor = (binding: string): string => {
    const safe = binding.replaceAll(UNSAFE_PATH_CHARACTER, "_");

    return safe === binding ? binding : `${safe}-${createHash("sha256").update(binding).digest("hex").slice(0, 8)}`;
};

/** Whether a process id is running. `EPERM` means it exists but belongs to someone else. */
const isProcessAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

/** What taking a data directory's lock came to: the release to call on stop, or the process that holds it. */
type DirectoryLock = { holder: number } | { release: () => void };

/** An address nothing listens on: port 1 refuses the connection at once. */
const UNAVAILABLE_CONNECTION_STRING = "postgres://postgres:postgres@127.0.0.1:1/postgres"; // gitleaks:allow -- a placeholder that connects to nothing

/** The pid a lock file names, or `undefined` when it is gone or not a pid. */
const readHolder = (lockPath: string): number | undefined => {
    try {
        const holder = Number.parseInt(readFileSync(lockPath, "utf8"), 10);

        return Number.isInteger(holder) ? holder : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Take the lock beside a data directory. Two engines on one PGlite directory would corrupt it, and
 * `vite dev` has no `.lunora/dev.json` claim to prevent that the way `lunora dev` does.
 *
 * The pid is written to a private file and hard-linked into place, which fails atomically if the lock
 * exists, so a lock is never seen half-written and a contender can't mistake an acquisition in
 * progress for a stale one. A lock whose process has gone is taken over.
 */
const lockDirectory = (lockPath: string): DirectoryLock => {
    const mine = `${lockPath}.${String(process.pid)}.${randomUUID()}`;

    writeFileSync(mine, String(process.pid), "utf8");

    try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                linkSync(mine, lockPath);

                return {
                    release: () => {
                        rmSync(lockPath, { force: true });
                    },
                };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                    throw error;
                }
            }

            const holder = readHolder(lockPath);

            // Our own pid is a lock this process never released (a restart); a dead one is stale. A lock that
            // vanished while it was read is simply taken on the next attempt.
            if (holder !== undefined && holder !== process.pid && isProcessAlive(holder)) {
                return { holder };
            }

            // Removed only if it still names the process it did a moment ago, so a lock taken in between survives.
            if (readHolder(lockPath) === holder) {
                rmSync(lockPath, { force: true });
            }
        }

        return { holder: readHolder(lockPath) ?? -1 };
    } finally {
        rmSync(mine, { force: true });
    }
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

        return { createServer: async (dataDirectory) => serveDatabase({ PGlite, PGLiteSocketServer, vector }, dataDirectory) };
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

    // Bindings that get no database still get an address that refuses connections, so wrangler starts the
    // session and `ctx.sql` fails with a connection error, instead of the whole dev server refusing to boot.
    const unavailable: string[] = [];
    const makeUnavailable = (binding: string): void => {
        env[variableFor(binding)] = UNAVAILABLE_CONNECTION_STRING;
        unavailable.push(binding);
    };
    const started: { binding: string; stop: () => Promise<void> }[] = [];
    const release = async (): Promise<void> => {
        for (const binding of [...started.map((entry) => entry.binding), ...unavailable]) {
            Reflect.deleteProperty(env, variableFor(binding));
        }

        await Promise.allSettled(started.map(async (server) => server.stop()));
    };
    const runtime = await (options.load ?? loadPglite)();

    if (runtime === undefined) {
        options.onWarning?.(
            `Hyperdrive binding ${bindings.map((binding) => `"${binding}"`).join(", ")} has no local database, so \`ctx.sql\` will fail to connect in dev. ` +
                `Run \`${INSTALL_HINT}\` for an embedded Postgres, or set ${variableFor(bindings[0] ?? "<BINDING>")}.`,
        );
        for (const binding of bindings) {
            makeUnavailable(binding);
        }

        return { bindings: [], stop: release };
    }

    try {
        for (const binding of bindings) {
            const directory = join(options.projectRoot, ".wrangler", "state", "lunora-pglite", directoryNameFor(binding));

            mkdirSync(directory, { recursive: true });

            const lock = lockDirectory(`${directory}.lock`);

            if ("holder" in lock) {
                options.onWarning?.(
                    `Hyperdrive binding "${binding}": another process (pid ${String(lock.holder)}) has its embedded Postgres open, so \`ctx.sql\` will fail to connect here. Stop it, or set ${variableFor(binding)} to use a database of your own.`,
                );
                makeUnavailable(binding);

                continue;
            }

            try {
                // Sequential: two engines booting at once contend for the same WASM instantiation.
                // eslint-disable-next-line no-await-in-loop
                const server = await runtime.createServer(directory);

                started.push({
                    binding,
                    stop: async () => {
                        try {
                            await server.stop();
                        } finally {
                            lock.release();
                        }
                    },
                });
                env[variableFor(binding)] = server.connectionString;
            } catch (error) {
                lock.release();

                throw error;
            }
        }
    } catch (error) {
        options.onWarning?.(`Could not start the embedded Postgres for Hyperdrive: ${error instanceof Error ? error.message : String(error)}`);

        await release();

        // Every binding, including the ones that had started, still gets the refusing address.
        for (const binding of bindings) {
            makeUnavailable(binding);
        }

        return { bindings: [], stop: release };
    }

    return { bindings: started.map(({ binding }) => binding), stop: release };
};

export type { LocalHyperdrive, PgliteParts, PgliteRuntime, StartLocalHyperdriveOptions };
export { bindingsNeedingDatabase, serveDatabase, startLocalHyperdrive };
