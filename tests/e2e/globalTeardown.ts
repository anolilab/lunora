import type { ChildProcess } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";

import type { FullConfig } from "@playwright/test";

import { DEV_VARS_PATH } from "./globalSetup";

/**
 * Tear down whatever `globalSetup.ts` spun up. SIGTERM gives Miniflare a
 * chance to flush state to disk; we follow up with SIGKILL after a short
 * grace period so a hung child can't block CI.
 */
const killProc = async (name: string, proc: ChildProcess): Promise<void> => {
    if (proc.killed) {
        return;
    }

    try {
        proc.kill("SIGTERM");
    } catch (error: unknown) {
        // eslint-disable-next-line no-console
        console.warn(`[e2e:${name}] SIGTERM failed:`, error);
    }

    await new Promise((resolve) => {
        setTimeout(resolve, 750);
    });

    if (!proc.killed) {
        try {
            proc.kill("SIGKILL");
        } catch (error: unknown) {
            // eslint-disable-next-line no-console
            console.warn(`[e2e:${name}] SIGKILL failed:`, error);
        }
    }
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
