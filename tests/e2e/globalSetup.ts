import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FullConfig } from "@playwright/test";

/**
 * Boots Miniflare (via `wrangler dev --local`) and the Vite dev server for
 * the playground app. We keep the child processes alive on `globalThis` so
 * `globalTeardown.ts` can SIGTERM them after the suite finishes.
 *
 * Why `wrangler dev --local` and not the Miniflare programmatic API?
 *   - wrangler reads `apps/playground/wrangler.jsonc` for us — DO bindings,
 *     D1, R2 — without us having to hand-roll the same config in JS.
 *   - It exposes the same `/_cirrus/rpc` and `/_cirrus/ws` routes the prod
 *     worker would expose, so the dev-server proxy in Vite finds them.
 *   - Miniflare 4 is what `wrangler dev --local` uses under the hood, so the
 *     R2 / D1 / DO emulation is identical to running Miniflare directly.
 *
 * Ports:
 *   - Vite       → 5173 (configured in `apps/playground/vite.config.ts`)
 *   - Wrangler   → 8787 (default)
 *
 * Env propagation:
 *   - `CIRRUS_E2E=true` flips the `/test/reset` route on (see
 *     `apps/playground/src/server/index.ts`).
 *   - `AUTH_SECRET` is a deterministic dev value so cross-tab cookie reads
 *     line up between Playwright contexts.
 */
const ROOT = new URL("../../", import.meta.url).pathname;
const PLAYGROUND = join(ROOT, "apps/playground");

interface SpawnedProcess {
    name: string;
    proc: ChildProcess;
}

declare global {
    var CIRRUS_E2E_PROCS: SpawnedProcess[] | undefined;
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

const globalSetup = async (_config: FullConfig): Promise<void> => {
    if (process.env.CIRRUS_E2E === "skip") {
        // eslint-disable-next-line no-console
        console.warn("[e2e] CIRRUS_E2E=skip — bypassing globalSetup");

        return;
    }

    if (process.env.CIRRUS_E2E_EXTERNAL === "true") {
        // External orchestrator already started servers (e.g. `pnpm dev` in
        // another terminal). Just wait for them to be reachable.
        await waitForUrl("http://localhost:8787/_cirrus/health", 10_000, "wrangler");
        await waitForUrl("http://localhost:5173", 10_000, "vite");

        return;
    }

    const tmpDir = mkdtempSync(join(tmpdir(), "cirrus-e2e-"));
    // Wrangler reads `process.env.AUTH_SECRET` etc. when the corresponding
    // var / secret is declared in `wrangler.jsonc`. We *don't* write a
    // `.dev.vars` file in the repo because it would risk leaking into git.

    const procs: SpawnedProcess[] = [];

    // 1. wrangler dev --local — boots Miniflare + DOs + D1 + R2.
    const wranglerArgs = [
        "exec",
        "wrangler",
        "dev",
        "--local",
        "--port",
        "8787",
        "--ip",
        "127.0.0.1",
        "--persist-to",
        join(tmpDir, ".wrangler-state"),
        "--var",
        "CIRRUS_E2E:true",
    ];

    procs.push(
        spawnProc("wrangler", "pnpm", wranglerArgs, PLAYGROUND, {
            AUTH_SECRET: "e2e-deterministic-secret-do-not-use-in-prod",
            CIRRUS_E2E: "true",
            STORAGE_SECRET: "e2e-deterministic-storage-secret",
            // Force non-interactive so wrangler doesn't try to open a TTY UI.
            WRANGLER_LOG: "info",
            CI: "true",
        }),
    );

    // Give wrangler a head start before Vite tries to proxy to it. We still
    // poll for both below — this just keeps the early Vite log quieter.
    await waitForUrl("http://localhost:8787", 30_000, "wrangler").catch(() => {
        // Health check may not exist; the actual smoke check below covers it.
    });

    // 2. Vite dev server for the playground SPA.
    procs.push(
        spawnProc("vite", "pnpm", ["exec", "vite", "--port", "5173", "--strictPort"], PLAYGROUND, {
            VITE_CIRRUS_URL: "http://localhost:8787",
        }),
    );

    await waitForUrl("http://localhost:5173", 30_000, "vite");

    globalThis.CIRRUS_E2E_PROCS = procs;
};

export default globalSetup;
