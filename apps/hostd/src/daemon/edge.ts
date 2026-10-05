/**
 * Caddy's files on the box (plan 458 W8). Caddy parses untrusted HTTP, so it
 * runs as its own user (`lunora-edge`), which must not reach the box key, the
 * bucket credentials, the state or a fleet's files.
 */
import { lstatSync } from "node:fs";
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

/** One of Caddy's directories as install.sh lays it out: its owner, group and mode. */
interface EdgeDirectory {
    /** Whose group it has: the daemon's or the edge user's. */
    group: "daemon" | "edge";
    mode: number;
    /** Whose uid owns it. */
    owner: "daemon" | "edge";
    /** Under the data directory. */
    path: string;
}

/**
 * Caddy's directories exactly as `install.sh` creates them (`create_directories`;
 * a test keeps the two equal). The daemon never creates or changes them: the
 * set-group-ID bits are what make `caddy.json` take the edge group and the
 * access log take the daemon's, and the unit's `RestrictSUIDSGID=yes` forbids
 * the daemon from setting either bit (chmod fails with EPERM) — root sets them
 * once, at install.
 */
const EDGE_DIRECTORIES: ReadonlyArray<EdgeDirectory> = [
    { group: "edge", mode: 0o2750, owner: "daemon", path: "caddy" },
    { group: "edge", mode: 0o700, owner: "edge", path: join("caddy", "state") },
    { group: "daemon", mode: 0o2750, owner: "edge", path: join("caddy", "log") },
];

const octal = (mode: number): string => mode.toString(8).padStart(4, "0");

/**
 * Check that Caddy's directories are laid out for the edge user `edge` (see
 * {@link EdgePaths}), with `daemon` the daemon's own uid and gid: each a real
 * directory (never a link) with exactly the owner, group and mode install.sh
 * gives it.
 * @throws {Error} naming every directory that is not, and how to fix it.
 */
const checkEdgeDirectories = (dataDirectory: string, edge: Account, daemon: { gid: number; uid: number }): void => {
    const ids = { daemon, edge: { gid: edge.gid, uid: edge.uid } };
    const problems: string[] = [];

    for (const directory of EDGE_DIRECTORIES) {
        const path = join(dataDirectory, directory.path);
        const want = { gid: ids[directory.group].gid, mode: directory.mode, uid: ids[directory.owner].uid };
        let stats: ReturnType<typeof lstatSync>;

        try {
            stats = lstatSync(path);
        } catch {
            problems.push(`${path} is missing`);
            continue;
        }

        if (!stats.isDirectory()) {
            problems.push(`${path} is not a directory`);
            continue;
        }

        const mode = stats.mode % 0o1_0000;

        if (stats.uid !== want.uid || stats.gid !== want.gid || mode !== want.mode) {
            problems.push(
                `${path} is ${String(stats.uid)}:${String(stats.gid)} ${octal(mode)}, not ${String(want.uid)}:${String(want.gid)} ${octal(want.mode)}`,
            );
        }
    }

    if (problems.length > 0) {
        throw new Error(`${problems.join("; ")} (install.sh lays them out: run it again)`);
    }
};

export type { EdgeDirectory, EdgePaths };
export { checkEdgeDirectories, EDGE_DIRECTORIES, edgePaths };
