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

/** Test seam: runs after a taker has read a dead owner and before it moves to retire that owner's lock. */
interface LockHooks {
    afterReadingOwner?: () => void;
}

const readOwner = (path: string): number => Number(readFileSync(path, "utf8"));

const ownerOf = (path: string): number | undefined => {
    try {
        return readOwner(path);
    } catch {
        return undefined;
    }
};

/**
 * Retire the lock of the dead process `dead`. Two takers that both read the same dead pid must not both remove
 * the lock, or the second removes the first's fresh one. So the right to retire is claimed with a hard link named
 * for the dead pid (`link` fails if the name exists, so one taker wins); the winner checks that what it linked is
 * still the dead owner's lock before unlinking it, and a loser never touches the lock. Returns whether the lock
 * was retired.
 */
const retire = (path: string, dead: number): boolean => {
    const claim = `${path}.retire-${String(dead)}`;

    try {
        linkSync(path, claim);
    } catch {
        // Another taker is retiring it, or the lock is already gone: either way this one leaves it alone.
        return false;
    }

    try {
        // The link is the file that was at `path` when it was made: if its owner is not the dead one, a taker that
        // finished before us has since put a live lock there.
        if (readOwner(claim) !== dead || isAlive(readOwner(claim))) {
            return false;
        }

        // Nothing else can replace `path` before this: a live lock is only ever published after the dead one is gone.
        if (statSync(path).ino === statSync(claim).ino) {
            unlinkSync(path);
        }

        return true;
    } finally {
        rmSync(claim, { force: true });
    }
};

/**
 * A deploy rewrites the checkout's wrangler config and restores it afterwards, so a second one in the same
 * checkout would read the first's env block or restore the file from under it. The lock is a file holding the
 * owner's pid, published whole (written to a temporary name, then linked into place, so no reader sees it empty).
 * One whose process is gone is retired and replaced. Returns the release, or the reason the lock is held.
 */
const acquireCheckoutLock = (cwd: string, hooks: LockHooks = {}): CheckoutLock => {
    const path = join(cwd, ".lunora", "preview.lock");
    const staged = `${path}.${String(process.pid)}.${randomUUID()}`;

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(staged, String(process.pid));

    try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                linkSync(staged, path);

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
                return { error: `another preview command is running in this checkout (pid ${String(owner)}); wait for it, or remove ${path} if it is not` };
            }

            hooks.afterReadingOwner?.();

            if (!retire(path, owner)) {
                return {
                    error: `another preview command is taking over the lock at ${path}; run this again in a moment. If none is running, remove ${path}.retire-${String(owner)}`,
                };
            }
        }

        return { error: `could not take the preview lock ${path}` };
    } finally {
        rmSync(staged, { force: true });
    }
};

export type { LockHooks };
export default acquireCheckoutLock;
