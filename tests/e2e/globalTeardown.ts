import type { ChildProcess } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";

import type { FullConfig } from "@playwright/test";

import { DEV_VARS_PATH } from "./globalSetup";

/**
 * Tear down whatever `globalSetup.ts` spun up.
 *
 * The child is a process TREE (pnpm → node → vite → workerd), spawned
 * `detached` so its pid doubles as the process-group id. Signalling the child
 * alone used to orphan workerd, which kept :5173 bound and broke the NEXT
 * run's boot — the group kill takes the whole tree down. SIGTERM first so
 * Miniflare can flush; SIGKILL the group after a grace period so a hung child
 * can't block CI. We wait on the real `exit` event rather than the old
 * `proc.killed` heuristic (`killed` only records that a signal was SENT).
 */
const waitForExit = async (proc: ChildProcess, timeoutMs: number): Promise<boolean> => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
        return true;
    }

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            resolve(false);
        }, timeoutMs);

        proc.once("exit", () => {
            clearTimeout(timer);
            resolve(true);
        });
    });
};

const killGroup = (pid: number, signal: NodeJS.Signals): boolean => {
    try {
        // Negative pid — signal the whole process group.
        process.kill(-pid, signal);

        return true;
    } catch {
        return false;
    }
};

const killProc = async (name: string, proc: ChildProcess): Promise<void> => {
    const { pid } = proc;

    if (pid === undefined) {
        return;
    }

    killGroup(pid, "SIGTERM");

    if (await waitForExit(proc, 5000)) {
        return;
    }

    // eslint-disable-next-line no-console
    console.warn(`[e2e:${name}] did not exit on SIGTERM within 5s — escalating to SIGKILL`);
    killGroup(pid, "SIGKILL");
    await waitForExit(proc, 2000);
};

/** Put the developer's `.dev.vars` back (or remove the one we wrote, if none existed). */
const restoreDevVars = (): void => {
    const backup = globalThis.LUNORA_E2E_DEV_VARS_BACKUP;

    if (backup === undefined) {
        return;
    }

    if (backup === null) {
        rmSync(DEV_VARS_PATH, { force: true });
    } else {
        writeFileSync(DEV_VARS_PATH, backup, "utf8");
    }

    globalThis.LUNORA_E2E_DEV_VARS_BACKUP = undefined;
};

const globalTeardown = async (_config: FullConfig): Promise<void> => {
    const procs = globalThis.LUNORA_E2E_PROCS;

    if (procs?.length) {
        await Promise.all(procs.map(async ({ name, proc }) => killProc(name, proc)));
        globalThis.LUNORA_E2E_PROCS = undefined;
    }

    restoreDevVars();
};

export default globalTeardown;
