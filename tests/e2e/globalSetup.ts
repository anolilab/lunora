import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FullConfig } from "@playwright/test";

/**
 * Boots the playground exactly like `pnpm dev`: one Vite dev server whose
 * embedded `@cloudflare/vite-plugin` worker (Miniflare under the hood) is the
 * SINGLE backend for auth, RPC, WebSockets, R2, and the `/test/*` helpers — all
 * on one D1. There is deliberately no second standalone `wrangler dev`: a second
 * worker would have its own D1 and split auth state from the RPC/WS state (the
 * bug this harness used to have). The child process is kept on `globalThis` so
 * `globalTeardown.ts` can stop it.
 *
 * Port: Vite + worker → 5173 (same origin, so cookies + CSRF just work).
 *
 * Worker env comes from `.dev.vars` (the plugin loads it, like real dev). We
 * write a deterministic e2e `.dev.vars` on setup and restore the developer's on
 * teardown — `LUNORA_E2E=true` is what gates the `/test/*` routes, and
 * `LUNORA_WORKER_ORIGIN` points the scheduler's HTTP callbacks back at :5173.
 */
const ROOT = new URL("../../", import.meta.url).pathname;
const PLAYGROUND = join(ROOT, "apps/playground");
const DEV_VARS_PATH = join(PLAYGROUND, ".dev.vars");

const E2E_DEV_VARS = `# Written by tests/e2e/globalSetup.ts; restored on teardown. Do not commit.
AUTH_SECRET="e2e-deterministic-secret-do-not-use-in-prod"
AUTH_URL="http://localhost:5173"
STORAGE_SECRET="e2e-deterministic-storage-secret"
LUNORA_E2E="true"
LUNORA_WORKER_ORIGIN="http://localhost:5173"
LUNORA_ORIGIN_URL="http://localhost:5173"
PUBLIC_STORAGE_BASE_URL="http://localhost:5173"
LUNORA_ADMIN_TOKEN="e2e-deterministic-admin-token"
MAIL_FROM="Lunora E2E <noreply@lunora.test>"
LUNORA_MAIL_CAPTURE="1"
`;

interface SpawnedProcess {
    name: string;
    proc: ChildProcess;
}

declare global {
    // eslint-disable-next-line vars-on-top, no-var -- module-scoped handle shared with globalTeardown
    var LUNORA_E2E_PROCS: SpawnedProcess[] | undefined;
    // eslint-disable-next-line vars-on-top, no-var -- developer's .dev.vars, restored on teardown (null = none existed)
    var LUNORA_E2E_DEV_VARS_BACKUP: null | string | undefined;
}

const waitForUrl = async (url: string, timeoutMs: number, label: string): Promise<void> => {
    const start = Date.now();
    let lastError: unknown = null;

    while (Date.now() - start < timeoutMs) {
        try {
            const response = await fetch(url, { method: "GET" });

            if (response.status < 500) {
                return;
            }
        } catch (error: unknown) {
            lastError = error;
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`Timed out waiting for ${label} at ${url} (last error: ${String(lastError)})`);
};

const spawnProc = (name: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): SpawnedProcess => {
    const proc = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        shell: false,
        stdio: process.env.E2E_VERBOSE === "true" ? "inherit" : ["ignore", "pipe", "pipe"],
    });

    proc.on("error", (error) => {
        // eslint-disable-next-line no-console
        console.error(`[e2e:${name}] failed to spawn:`, error);
    });

    return { name, proc };
};

/** Swap in the deterministic e2e `.dev.vars`, remembering the developer's file. */
const installDevVars = (): void => {
    globalThis.LUNORA_E2E_DEV_VARS_BACKUP = existsSync(DEV_VARS_PATH) ? readFileSync(DEV_VARS_PATH, "utf8") : null;
    writeFileSync(DEV_VARS_PATH, E2E_DEV_VARS, "utf8");
};

const globalSetup = async (_config: FullConfig): Promise<void> => {
    if (process.env.LUNORA_E2E === "skip") {
        // eslint-disable-next-line no-console
        console.warn("[e2e] LUNORA_E2E=skip — bypassing globalSetup");

        return;
    }

    if (process.env.LUNORA_E2E_EXTERNAL === "true") {
        // An external orchestrator already started the playground (`pnpm dev` in
        // another terminal). Just wait for it.
        await waitForUrl("http://localhost:5173/api/auth/ok", 10_000, "worker");

        return;
    }

    installDevVars();

    const procs: SpawnedProcess[] = [];

    // `LUNORA_E2E` in the process env tells `vite.config.ts` to make storage
    // ephemeral; the same flag in `.dev.vars` (above) gates the worker's /test routes.
    procs.push(spawnProc("vite", "pnpm", ["exec", "vite", "--port", "5173", "--strictPort"], PLAYGROUND, { LUNORA_E2E: "true" }));

    await waitForUrl("http://localhost:5173", 60_000, "vite");
    // Hit a worker route so the embedded worker boots + runs the better-auth
    // migration once, before the first test (so none pays it inside its timeout).
    await waitForUrl("http://localhost:5173/api/auth/ok", 60_000, "worker");

    globalThis.LUNORA_E2E_PROCS = procs;
};

export { DEV_VARS_PATH };
export default globalSetup;
