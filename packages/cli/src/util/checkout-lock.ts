import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const isAlive = (pid: number): boolean => {
    // A torn write leaves no pid; `kill(0)` would signal our own process group and report it alive.
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

type CheckoutLock = { error: string; release?: never } | { error?: never; release: () => void };

/** Test seams: each runs after a taker has read a dead process and before it moves to retire what that process held. */
interface LockHooks {
    /** A dead lock owner. */
    afterReadingOwner?: () => void;
    /** A dead taker still holding the right to retire a lock. */
    afterReadingTaker?: () => void;
}

const readOwner = (path: string): number => Number(readFileSync(path, "utf8"));

const ownerOf = (path: string): number | undefined => {
    try {
        return readOwner(path);
    } catch {
        return undefined;
    }
};

/** Put this process's pid at `path` whole (written to a temporary name, then linked, so no reader sees it empty). Throws EEXIST while `path` is taken. */
const publish = (path: string): void => {
    const staged = `${path}.${String(process.pid)}.${randomUUID()}`;

    writeFileSync(staged, String(process.pid));

    try {
        linkSync(staged, path);
    } finally {
        rmSync(staged, { force: true });
    }
};

/**
 * Remove `path` if it still holds the dead process `dead`; the caller holds the right to. Returns false when
 * a live file has taken its place, true when it is gone.
 */
const removeDead = (path: string, dead: number): boolean => {
    let ino: number;

    try {
        ino = statSync(path).ino;

        // A taker that finished before us has since put a live file there.
        if (readOwner(path) !== dead || isAlive(dead)) {
            return false;
        }
    } catch {
        // Already gone.
        return true;
    }

    // Nothing else can replace `path` before this: a live file is only ever published after the dead one is gone.
    if (statSync(path).ino === ino) {
        unlinkSync(path);
    }

    return true;
};

/**
 * The claim at `claim` is taken: whether it is now free to try again. A live taker keeps it (our own pid counts
 * as alive too); a dead one's claim is retired like a dead lock.
 */
const freeClaim = (claim: string, hooks: LockHooks, retireDead: (path: string, dead: number) => boolean): boolean => {
    const taker = ownerOf(claim);

    // Released between the link and the read.
    if (taker === undefined) {
        return true;
    }

    if (isAlive(taker)) {
        return false;
    }

    hooks.afterReadingTaker?.();

    return retireDead(claim, taker);
};

/**
 * Retire `path`, held by the dead process `dead`. Two takers that both read the same dead pid must not both
 * remove it, or the second removes the first's fresh one. So the right to retire is claimed first, by publishing
 * the taker's own pid at a name keyed by the dead pid (`link` fails if the name exists, so one taker wins), and
 * a loser never touches `path`. The claim names its taker, so one left behind by a taker that died is retired
 * the same way, by the same function, and a live taker's claim is never touched. Returns whether `path` was
 * retired.
 */
const retire = (path: string, dead: number, hooks: LockHooks): boolean => {
    const claim = `${path}.retire-${String(dead)}`;

    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            publish(claim);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }

            if (!freeClaim(claim, hooks, (taken, taker) => retire(taken, taker, hooks))) {
                return false;
            }

            continue;
        }

        try {
            return removeDead(path, dead);
        } finally {
            if (ownerOf(claim) === process.pid) {
                rmSync(claim, { force: true });
            }
        }
    }

    return false;
};

/**
 * A cross-process lock at `path`: a file holding the owner's pid, published whole. One whose process is gone is
 * retired and replaced. Returns the release, or the reason the lock is held; `holder` names the command in that
 * reason.
 */
const acquirePidLock = (path: string, holder: string, hooks: LockHooks = {}): CheckoutLock => {
    mkdirSync(dirname(path), { recursive: true });

    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            publish(path);

            return {
                release: () => {
                    // Only the owner's own lock: a taker that retired it, wrongly or not, must not lose its own.
                    if (ownerOf(path) === process.pid) {
                        rmSync(path, { force: true });
                    }
                },
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }
        }

        const owner = ownerOf(path);

        // Released between the link and the read: try again.
        if (owner === undefined) {
            continue;
        }

        if (isAlive(owner)) {
            return { error: `another ${holder} is running in this checkout (pid ${String(owner)}); wait for it, or remove ${path} if it is not` };
        }

        hooks.afterReadingOwner?.();

        if (!retire(path, owner, hooks)) {
            return {
                error: `another ${holder} is taking over the lock at ${path}; run this again in a moment. If none is running, remove ${path}.retire-${String(owner)}`,
            };
        }
    }

    return { error: `could not take the ${holder} lock ${path}` };
};

/**
 * A deploy rewrites the checkout's wrangler config and restores it afterwards, so a second one in the same
 * checkout would read the first's env block or restore the file from under it.
 */
const acquireCheckoutLock = (cwd: string, hooks: LockHooks = {}): CheckoutLock =>
    acquirePidLock(join(cwd, ".lunora", "preview.lock"), "preview command", hooks);

export type { LockHooks };
export { acquireCheckoutLock, acquirePidLock };
