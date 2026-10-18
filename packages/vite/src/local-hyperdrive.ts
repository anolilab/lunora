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
 * Started once per process and kept: `restartServer` resolves the new config
 * before it closes the old server, so tying the database to a server would stop
 * it under the one that replaces it. The process exiting takes it down, and
 * Postgres replays its WAL on the next start.
 */
import { lunoraLine } from "@lunora/config/cli";
import type { LocalHyperdrive } from "@lunora/config/cloudflare";
import { startLocalHyperdrive } from "@lunora/config/cloudflare";
import type { Plugin } from "vite";

interface LocalHyperdriveOptions {
    projectRoot: string;
    /** Injection seam; defaults to the real PGlite. */
    start?: typeof startLocalHyperdrive;
}

/** The database already started for each project root in this process. */
const started = new Map<string, Promise<LocalHyperdrive | undefined>>();

const localHyperdrive = ({ projectRoot, start = startLocalHyperdrive }: LocalHyperdriveOptions): Plugin => {
    return {
        async config(_config, env) {
            if (env.command !== "serve" || env.isPreview === true) {
                return;
            }

            const existing = started.get(projectRoot);

            if (existing !== undefined) {
                await existing;

                return;
            }

            const pending = start({
                onWarning: (message) => {
                    // eslint-disable-next-line no-console -- the dev server's logger isn't available while the Cloudflare plugin resolves its config.
                    console.warn(lunoraLine(message));
                },
                projectRoot,
            });

            started.set(projectRoot, pending);

            const local = await pending;

            if (local !== undefined) {
                // eslint-disable-next-line no-console -- see above.
                console.info(lunoraLine(`Hyperdrive ${local.bindings.join(", ")}: embedded Postgres (PGlite), data in .wrangler/state/lunora-pglite.`));
            }
        },
        enforce: "pre",
        name: "lunora:local-hyperdrive",
    };
};

export default localHyperdrive;
