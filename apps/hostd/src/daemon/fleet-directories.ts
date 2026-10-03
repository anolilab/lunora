/**
 * The fleets' directories on the box (plan 458 W8): what the fleet user may
 * reach in the data directory, and each fleet's own working directory.
 *
 * The data directory, `fleets/` and `releases/` are `{daemon}:{fleet group}`
 * 0710 — the fleet user passes through to its own working directory and to the
 * release it deploys, and lists neither. A release is shared with the fleet
 * group read-only; a fleet's working directory (its `HOME` and `TMPDIR`) is the
 * fleet user's own, 0700.
 */
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { Account } from "./accounts";
import type { ChildLaunch } from "./capabilities";
import { describeFailure, runChild } from "./child";
import { CHILD_PATH } from "./fleet-environment";

/** How long emptying a fleet's directory may take. */
const REMOVE_TIMEOUT_MS = 120_000;

/**
 * Give the fleet group passage through the data directory: `dataDir`,
 * `fleets/` and `releases/` become `{owner}:{fleet group}` 0710 — the fleet
 * user can reach its own working directory and the release it deploys, and
 * list neither.
 */
const prepareDataDirectory = (dataDirectory: string, account: Account): void => {
    for (const path of [dataDirectory, join(dataDirectory, "fleets"), join(dataDirectory, "releases")]) {
        mkdirSync(path, { mode: 0o710, recursive: true });
        chownSync(path, -1, account.gid);
        chmodSync(path, 0o710);
    }
};

/** Make a release directory readable to the fleet group (`celld deploy` runs as the fleet user): dirs 0750, files 0640. */
const shareWithFleet = (directory: string, account: Account): void => {
    chownSync(directory, -1, account.gid);
    chmodSync(directory, 0o750);

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
            shareWithFleet(path, account);
        } else if (entry.isFile()) {
            chownSync(path, -1, account.gid);
            chmodSync(path, 0o640);
        }
    }
};

/**
 * A fleet's working directory (`{dataDir}/fleets/{alias}`), created when
 * missing: the fleet user's own, mode 0700, when fleets run as one.
 * @returns its path
 */
const ensureFleetDirectory = (dataDirectory: string, alias: string, account: Account | undefined): string => {
    const directory = join(dataDirectory, "fleets", alias);

    if (!existsSync(directory)) {
        mkdirSync(directory, { mode: 0o700, recursive: true });

        if (account !== undefined) {
            chownSync(directory, account.uid, account.gid);
        }
    }

    return directory;
};

/**
 * Delete a fleet's working directory. A fleet user's directory is emptied as
 * that user — the daemon may neither list nor enter it (0700, and the unit
 * grants no `CAP_DAC_*`) — and the empty directory is then removed by the
 * daemon, which owns `fleets/`: `rmdir` needs only `fleets/`, where a
 * recursive removal would have to read the directory and fail with `EACCES`.
 * @throws {Error} when the fleet user's `find` fails, or the directory is not empty after it.
 */
const removeFleetDirectory = async (dataDirectory: string, alias: string, launch: ChildLaunch, account: Account | undefined): Promise<void> => {
    const directory = join(dataDirectory, "fleets", alias);

    if (account === undefined) {
        rmSync(directory, { force: true, recursive: true });

        return;
    }

    if (!existsSync(directory)) {
        return;
    }

    const result = await runChild(launch, "find", [directory, "-mindepth", "1", "-delete"], { env: { PATH: CHILD_PATH }, timeoutMs: REMOVE_TIMEOUT_MS });

    if (result.code !== 0 || result.timedOut) {
        throw new Error(describeFailure("find", result));
    }

    rmdirSync(directory);
};

export { ensureFleetDirectory, prepareDataDirectory, removeFleetDirectory, shareWithFleet };
