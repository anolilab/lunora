/**
 * Caddy's files on the box (plan 458 W8). Caddy parses untrusted HTTP, so it
 * runs as its own user (`lunora-edge`), which must not reach the box key, the
 * bucket credentials, the state or a fleet's files.
 */
import { chmodSync, chownSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Account } from "./accounts";

/**
 * Where Caddy's files live. hostd must never write into a directory Caddy can
 * write (a link planted there would turn hostd's next write into a
 * write anywhere hostd can):
 *
 * - `{dataDir}/caddy/` — hostd's, group `lunora-edge`, 2750: the config Caddy
 * boots from (`caddy.json`, 0640), which hostd writes and Caddy only reads;
 * - `{dataDir}/caddy/state/` — Caddy's own, 0700: its `HOME`, autosaved config
 * and certificates;
 * - `{dataDir}/caddy/log/` — Caddy's, group of hostd, 2750 (new files take
 * that group): the JSON access log, 0640, which hostd only reads.
 */
interface EdgePaths {
    accessLog: string;
    config: string;
    home: string;
    log: string;
    state: string;
}

const edgePaths = (dataDirectory: string): EdgePaths => {
    const home = join(dataDirectory, "caddy");

    return { accessLog: join(home, "log", "access.log"), config: join(home, "caddy.json"), home, log: join(home, "log"), state: join(home, "state") };
};

/**
 * Create `path` when it is missing and hand it to `uid`:`gid` with `mode`. The
 * mode is set while the daemon still owns the directory and it is in the
 * daemon's own group — the kernel drops a set-group-ID bit set on a directory
 * of a group the caller is not in — then chown (CAP_CHOWN) hands it over,
 * which keeps that bit on a directory.
 */
const ownedDirectory = (path: string, mode: number, owner: { gid: number; uid: number }, daemon: { gid: number; uid: number }): void => {
    if (!existsSync(path)) {
        mkdirSync(path, { mode: 0o700 });
    }

    const stats = statSync(path);

    if (stats.uid === daemon.uid && stats.mode % 0o1_0000 !== mode) {
        chownSync(path, daemon.uid, daemon.gid);
        chmodSync(path, mode);
    }

    chownSync(path, owner.uid, owner.gid);
};

/**
 * Lay Caddy's directories out for the edge user `edge` (see {@link EdgePaths}),
 * with `daemon` the daemon's own uid and gid, and let other users traverse —
 * never list — the data directory (0711), which the edge user must pass
 * through. Nothing else in it is open to other users.
 */
const prepareEdgeDirectories = (dataDirectory: string, edge: Account, daemon: { gid: number; uid: number }): void => {
    const paths = edgePaths(dataDirectory);

    chmodSync(dataDirectory, 0o711);
    // Set-group-ID: caddy.json, which the daemon writes, takes the edge group Caddy reads it through.
    ownedDirectory(paths.home, 0o2750, { gid: edge.gid, uid: daemon.uid }, daemon);
    ownedDirectory(paths.state, 0o700, edge, daemon);
    // Set-group-ID: the access log Caddy writes takes the daemon's group, which reads it.
    ownedDirectory(paths.log, 0o2750, { gid: daemon.gid, uid: edge.uid }, daemon);
};

export type { EdgePaths };
export { edgePaths, prepareEdgeDirectories };
