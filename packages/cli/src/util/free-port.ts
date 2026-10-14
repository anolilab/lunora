import { createServer } from "node:net";

/** How many consecutive ports {@link findAvailablePort} probes before giving up. */
const DEFAULT_PROBE_ATTEMPTS = 64;
/** The loopback host availability is probed against — the address `wrangler dev` ultimately binds. */
const LOOPBACK_HOST = "127.0.0.1";
/** The highest valid TCP port. */
const MAX_PORT = 65_535;

/**
 * Resolve `true` when `port` can be bound on `host` right now, `false` when it is
 * already in use (or otherwise refuses the bind). Best-effort and racy by nature
 * — the port can be taken between this check and the real bind — but that is the
 * same window `wrangler` itself races.
 */
const isPortFree = (port: number, host: string = LOOPBACK_HOST): Promise<boolean> =>
    new Promise((resolve) => {
        const server = createServer();

        server.once("error", () => {
            resolve(false);
        });
        server.once("listening", () => {
            server.close(() => {
                resolve(true);
            });
        });
        server.listen(port, host);
    });

/**
 * The first free port at or above `preferred` on the loopback interface, probing
 * up to `attempts` consecutive ports. Falls back to `preferred` when the whole
 * window is busy (the caller then lets `wrangler` surface the bind error).
 *
 * This mirrors `wrangler`'s own "probe a small consecutive range from 8787"
 * behaviour, which it only applies when no port is pinned — so `lunora dev` can
 * keep that free-port fallback even though it passes an explicit `--port` for a
 * deterministic worker origin (the studio proxies to it).
 */
const findAvailablePort = async (preferred: number, host: string = LOOPBACK_HOST, attempts: number = DEFAULT_PROBE_ATTEMPTS): Promise<number> => {
    for (let port = preferred; port < preferred + attempts && port <= MAX_PORT; port += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential probing is intentional: return the lowest free port, lowest first.
        if (await isPortFree(port, host)) {
            return port;
        }
    }

    return preferred;
};

export { findAvailablePort, isPortFree };
