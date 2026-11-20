import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The build box's command runner (`containers/build/run.mjs`). Build instances
 * are reused across tenants, so nothing a build starts may outlive it: a
 * leftover process would read the next tenant's workspace and env.
 */

interface RunModule {
    default: (
        command: string,
        args: string[],
        options: { cwd?: string; label?: string; timeoutMs?: number },
        onLine: (line: string, stream: "stderr" | "stdout") => void,
    ) => Promise<number>;
}

// Loaded by URL: the module is plain `.mjs` shipped into the image, with no
// declaration file for the type checker to resolve.
const { default: run } = (await import(new URL("../containers/build/run.mjs", import.meta.url).href)) as RunModule;

/** Alive means signalable and not a zombie awaiting its reaper. */
const isAlive = async (pid: number): Promise<boolean> => {
    try {
        process.kill(pid, 0);
    } catch {
        return false;
    }

    try {
        const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");

        return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
    } catch {
        return false;
    }
};

// Polls without asserting: an `expect` inside `vi.waitFor` counts once per retry, so a slow
// runner would break `expect.assertions`.
const waitUntilGone = async (pid: number): Promise<void> => {
    await vi.waitFor(async () => {
        if (await isAlive(pid)) {
            throw new Error(`process ${String(pid)} is still alive`);
        }
    });
};

let sandbox: string;
let pidFile: string;
let grandchild: number | undefined;

const readPid = async (): Promise<number> => {
    const text = await readFile(pidFile, "utf8");

    return Number.parseInt(text.trim(), 10);
};

describe("build box run", () => {
    beforeEach(async () => {
        sandbox = await mkdtemp(join(tmpdir(), "build-box-run-"));
        pidFile = join(sandbox, "pid");
        grandchild = undefined;
    });

    afterEach(async () => {
        // Only the pid this test's own shell wrote, never a pattern match.
        if (grandchild !== undefined && (await isAlive(grandchild))) {
            process.kill(grandchild, "SIGKILL");
        }

        await rm(sandbox, { force: true, recursive: true });
    });

    it("kills a timed-out command's background descendants, not only the command", async () => {
        expect.assertions(3);

        const result = run("sh", ["-c", `sleep 60 >/dev/null 2>&1 & echo $! > ${pidFile}; sleep 60`], { label: "the build", timeoutMs: 300 }, () => {});

        await expect(result).rejects.toThrow("the build exceeded 300ms and was killed");

        grandchild = await readPid();

        expect(grandchild).toBeGreaterThan(0);

        // SIGKILL is delivered asynchronously; the milestone is the process being gone.
        await waitUntilGone(grandchild);

        await expect(isAlive(grandchild)).resolves.toBe(false);
    });

    it("kills a background process a successful command left behind", async () => {
        expect.assertions(3);

        const lines: string[] = [];
        const code = await run("sh", ["-c", `sleep 60 >/dev/null 2>&1 & echo $! > ${pidFile}; echo built`], { label: "the build" }, (line) => {
            lines.push(line);
        });

        grandchild = await readPid();

        expect(code).toBe(0);
        expect(lines).toStrictEqual(["built"]);

        await waitUntilGone(grandchild);

        await expect(isAlive(grandchild)).resolves.toBe(false);
    });
});
