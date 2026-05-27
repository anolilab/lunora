import type { ChildProcess } from "node:child_process";

import type { FullConfig } from "@playwright/test";

/**
 * Tear down whatever `globalSetup.ts` spun up. SIGTERM gives wrangler a
 * chance to flush Miniflare state to disk; we follow up with SIGKILL after
 * a short grace period so a hung child can't block CI.
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

const globalTeardown = async (_config: FullConfig): Promise<void> => {
    const procs = globalThis.__CIRRUS_E2E_PROCS__;

    if (!procs?.length) {
        return;
    }

    await Promise.all(procs.map(async ({ name, proc }) => killProc(name, proc)));

    globalThis.__CIRRUS_E2E_PROCS__ = undefined;
};

export default globalTeardown;
