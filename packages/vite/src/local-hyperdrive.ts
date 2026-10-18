/**
 * Give `vite dev` a database for a Hyperdrive binding that has none.
 *
 * Wrangler refuses to resolve a Hyperdrive binding without a local connection
 * string, which takes the whole dev server down. `startLocalHyperdrive` serves an
 * embedded PGlite for each such binding and hands wrangler its address through
 * the environment variable it reads, before the Cloudflare plugin resolves the
 * worker's bindings. `lunora dev` starts the same database itself, and the Vite
 * child it spawns inherits the variable, so this plugin then finds nothing to do.
 *
 * Every config resolution asks again, and the starter only serves bindings that
 * still have no database, so a binding added after the first start gets one on
 * the next reload. The databases belong to the project, not to one server:
 * `restartServer` resolves the new config before it closes the old server, so a
 * server closing only starts a short countdown, and the databases stop when no
 * server has come back by the end of it.
 */
import { lunoraLine } from "@lunora/config/cli";
import type { LocalHyperdrive } from "@lunora/config/cloudflare";
import { startLocalHyperdrive } from "@lunora/config/cloudflare";
import type { Plugin } from "vite";

import type { PendingCloseMap } from "./server-close";
import { registerDevServerClose, runPendingClose } from "./server-close";

/** How long after the last server closes before the databases stop, so a restart keeps them. */
const STOP_GRACE_MS = 5000;

interface LocalHyperdriveOptions {
    projectRoot: string;
    /** Injection seam; defaults to the real PGlite. */
    start?: typeof startLocalHyperdrive;
    /** The wrangler config the Cloudflare plugin runs, when it is not the project's own. */
    wranglerConfigPath?: string;
}

/** What a project has running in this process. */
interface Session {
    databases: LocalHyperdrive[];
    /** Startups run one after another, so two config resolutions never start the same binding twice. */
    pending: Promise<void>;
    servers: number;
    /** A shutdown in flight, so a config resolved while it runs starts its databases after it, not into it. */
    stopping: Promise<void>;
    stopTimer?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, Session>();

const sessionFor = (projectRoot: string): Session => {
    const existing = sessions.get(projectRoot);

    if (existing !== undefined) {
        return existing;
    }

    const created: Session = { databases: [], pending: Promise.resolve(), servers: 0, stopping: Promise.resolve() };

    sessions.set(projectRoot, created);

    return created;
};

const stopAll = async (session: Session): Promise<void> => {
    const databases = session.databases.splice(0);

    await Promise.allSettled(databases.map(async (database) => database.stop()));
};

/** Stop the databases after the grace period. Unref'd: the countdown must not keep a finished process alive. */
const scheduleStop = (session: Session): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
        // A startup still in flight adds its database after the timer fires: wait for it, then stop only if no server has come back.
        session.pending
            .then(async () => {
                if (session.servers === 0) {
                    // eslint-disable-next-line no-param-reassign -- the session is a plain state record, mutated by design
                    session.stopping = stopAll(session);
                    await session.stopping;
                }

                return undefined;
            })
            .catch((): undefined => undefined);
    }, STOP_GRACE_MS);

    timer.unref();

    return timer;
};

const localHyperdrive = ({ projectRoot, start = startLocalHyperdrive, wranglerConfigPath }: LocalHyperdriveOptions): Plugin => {
    // Close callbacks of middleware-mode servers, which have no httpServer to listen on.
    const pendingMiddlewareCloses: PendingCloseMap = new Map();

    return {
        async config(_config, env) {
            if (env.command !== "serve" || env.isPreview === true) {
                return;
            }

            const session = sessionFor(projectRoot);

            // A server is on its way: the countdown to stop the databases is off until it has come and gone again.
            clearTimeout(session.stopTimer);

            const previous = session.pending;
            const attempt = (async () => {
                await previous;
                // A shutdown already running would close what this start opens, so it finishes first.
                await session.stopping;

                const local = await start({
                    onWarning: (message) => {
                        // eslint-disable-next-line no-console -- the dev server's logger isn't available while the Cloudflare plugin resolves its config.
                        console.warn(lunoraLine(message));
                    },
                    projectRoot,
                    wranglerConfigPath,
                });

                if (local !== undefined) {
                    session.databases.push(local);
                }

                if (local !== undefined && local.bindings.length > 0) {
                    // eslint-disable-next-line no-console -- see above.
                    console.info(lunoraLine(`Hyperdrive ${local.bindings.join(", ")}: embedded Postgres (PGlite), data in .wrangler/state/lunora-pglite.`));
                }
            })();

            // Later attempts queue behind this one whether it succeeds or not; only this caller sees its error.
            session.pending = attempt.catch((): undefined => undefined);

            try {
                await attempt;
            } finally {
                // The countdown restarts once the startup is done, so a server gets the grace period to arrive and
                // a replacement that never does (its config failed later) does not keep the databases running.
                if (session.servers === 0) {
                    clearTimeout(session.stopTimer);
                    session.stopTimer = scheduleStop(session);
                }
            }
        },
        buildEnd() {
            // Middleware-mode close (no httpServer to listen on); a no-op in classic dev mode and for a build.
            runPendingClose(pendingMiddlewareCloses, this.environment);
        },
        configureServer(server) {
            const session = sessionFor(projectRoot);
            let closed = false;

            session.servers += 1;
            clearTimeout(session.stopTimer);

            registerDevServerClose(server, pendingMiddlewareCloses, () => {
                // Idempotent: some hosts deliver both close signals for one server.
                if (closed) {
                    return;
                }

                closed = true;
                session.servers -= 1;

                if (session.servers === 0) {
                    session.stopTimer = scheduleStop(session);
                }
            });
        },
        enforce: "pre",
        name: "lunora:local-hyperdrive",
    };
};

export default localHyperdrive;
