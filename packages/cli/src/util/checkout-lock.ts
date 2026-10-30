import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * A deploy rewrites the checkout's wrangler config and restores it afterwards, so a second one in the same
 * checkout would read the first's env block or restore the file from under it. The lock is a file holding the
 * owner's pid; one whose process is gone is taken over. Returns the release, or the reason the lock is held.
 */
const acquireCheckoutLock = (cwd: string): { error: string; release?: never } | { error?: never; release: () => void } => {
    const path = join(cwd, ".lunora", "preview.lock");

    mkdirSync(dirname(path), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            writeFileSync(path, String(process.pid), { flag: "wx" });

            return {
                release: () => {
                    rmSync(path, { force: true });
                },
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }

            const owner = Number(readFileSync(path, "utf8"));

            if (isAlive(owner)) {
                return { error: `another preview command is running in this checkout (pid ${String(owner)}); wait for it, or remove ${path} if it is not` };
            }

            rmSync(path, { force: true });
        }
    }

    return { error: `could not take the preview lock ${path}` };
};

export default acquireCheckoutLock;
