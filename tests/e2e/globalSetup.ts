import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FullConfig } from "@playwright/test";

import { BASE_URL, PORT } from "./origin";

/**
 * Boots the playground exactly like `pnpm dev`: one Vite dev server whose
 * embedded `@cloudflare/vite-plugin` worker (Miniflare under the hood) is the
 * SINGLE backend for auth, RPC, WebSockets, R2, and the `/test/*` helpers — all
 * on one D1. There is deliberately no second standalone `wrangler dev`: a second
 * worker would have its own D1 and split auth state from the RPC/WS state (the
 * bug this harness used to have). The child process is kept on `globalThis` so
 * `globalTeardown.ts` can stop it.
 *
 * Port: Vite + worker share one port (same origin, so cookies + CSRF just
 * work). `origin.ts` decides which; `LUNORA_E2E_BASE_URL` overrides it.
 *
 * Worker env comes from `.dev.vars` (the plugin loads it, like real dev). We
 * write a deterministic e2e `.dev.vars` on setup and restore the developer's on
 * teardown — `LUNORA_E2E=true` is what gates the `/test/*` routes, and
 * `LUNORA_ORIGIN_URL` points the scheduler's HTTP callbacks back at the same
 * origin.
 *
 * Reliability notes (each of these was an observed boot-failure mode):
 *   - The child's stdout/stderr are always captured into a bounded ring buffer
 *     and included in any boot-timeout error, so a failed run is diagnosable
 *     from the Playwright output alone (set `E2E_VERBOSE=true` to stream).
 *   - A cold boot (fresh Vite dep-optimizer cache + first wrangler/Miniflare
 *     init) can take well over a minute on slow or network-constrained
 *     runners; the boot budget is 180s, not the old 60s.
 *   - If the child EXITS during boot (port already bound, broken install) the
 *     setup fails immediately with the child's output instead of burning the
 *     whole budget polling a dead server.
 *   - The port is probed BEFORE spawning: a stale dev server (or a leaked
 *     child from a crashed previous run) would otherwise be silently tested
 *     against, with whatever state it had. Use `LUNORA_E2E_EXTERNAL=true` to
 *     intentionally run against an already-started playground.
 */
const ROOT = new URL("../../", import.meta.url).pathname;
const PLAYGROUND = join(ROOT, "apps/playground");
const DEV_VARS_PATH = join(PLAYGROUND, ".dev.vars");

/** One boot budget for the whole Vite + embedded-worker startup. */
const BOOT_TIMEOUT_MS = 180_000;

const E2E_DEV_VARS = `# Written by tests/e2e/globalSetup.ts; restored on teardown. Do not commit.
AUTH_SECRET="e2e-deterministic-secret-do-not-use-in-prod"
AUTH_URL="${BASE_URL}"
STORAGE_SECRET="e2e-deterministic-storage-secret"
LUNORA_E2E="true"
LUNORA_ORIGIN_URL="${BASE_URL}"
PUBLIC_STORAGE_BASE_URL="${BASE_URL}"
LUNORA_ADMIN_TOKEN="e2e-deterministic-admin-token"
MAIL_FROM="Lunora E2E <noreply@lunora.test>"
LUNORA_MAIL_CAPTURE="1"
`;

interface SpawnedProcess {
    name: string;
    /** Rolling tail of the child's stdout+stderr (empty when E2E_VERBOSE streams instead). */
    output: string[];
    proc: ChildProcess;
}

declare global {
    // eslint-disable-next-line vars-on-top, no-var -- module-scoped handle shared with globalTeardown
    var LUNORA_E2E_PROCS: SpawnedProcess[] | undefined;
    // eslint-disable-next-line vars-on-top, no-var -- developer's .dev.vars, restored on teardown (null = none existed)
    var LUNORA_E2E_DEV_VARS_BACKUP: null | string | undefined;
}

/** Cap on retained output lines — enough to diagnose a boot failure, bounded so a chatty child can't grow memory unbounded. */
const OUTPUT_RING_LINES = 300;

const probeUrl = async (url: string): Promise<boolean> => {
    try {
        const response = await fetch(url, { method: "GET" });

        return response.status < 500;
    } catch {
        return false;
    }
};

/**
 * Poll `url` until it answers (< 500), the deadline passes, or the child under
 * test exits. On failure the error carries the child's captured output tail so
 * the root cause (port bound, missing build, worker crash) is visible without
 * re-running under E2E_VERBOSE.
 */
const waitForServer = async (url: string, deadlineAt: number, label: string, child: SpawnedProcess): Promise<void> => {
    let lastError: unknown = null;

    while (Date.now() < deadlineAt) {
        if (child.proc.exitCode !== null) {
            throw new Error(
                `[e2e] ${child.name} exited with code ${child.proc.exitCode} while waiting for ${label}.\n--- ${child.name} output ---\n${child.output.join("")}`,
            );
        }

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

    throw new Error(`Timed out waiting for ${label} at ${url} (last error: ${String(lastError)}).\n--- ${child.name} output ---\n${child.output.join("")}`);
};

const spawnProc = (name: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): SpawnedProcess => {
    const verbose = process.env.E2E_VERBOSE === "true";
    const proc = spawn(command, args, {
        cwd,
        // Own process group: pnpm → node → vite → workerd is a tree, and
        // teardown must kill ALL of it (an orphaned workerd keeps the port bound
        // and poisons the next run). `detached` makes proc.pid the group id.
        detached: true,
        env: { ...process.env, ...env },
        shell: false,
        stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
    });

    const output: string[] = [];
    const record = (chunk: Buffer): void => {
        output.push(chunk.toString());

        if (output.length > OUTPUT_RING_LINES) {
            output.splice(0, output.length - OUTPUT_RING_LINES);
        }
    };

    proc.stdout?.on("data", record);
    proc.stderr?.on("data", record);

    proc.on("error", (error) => {
        // eslint-disable-next-line no-console
        console.error(`[e2e:${name}] failed to spawn:`, error);
    });

    return { name, output, proc };
};

/** Swap in the deterministic e2e `.dev.vars`, remembering the developer's file. */
const installDevVars = (): void => {
    globalThis.LUNORA_E2E_DEV_VARS_BACKUP = existsSync(DEV_VARS_PATH) ? readFileSync(DEV_VARS_PATH, "utf8") : null;
    writeFileSync(DEV_VARS_PATH, E2E_DEV_VARS, "utf8");
};

/**
 * Confirm the externally-started worker actually exposes the `/test/*` helpers.
 *
 * Only `installDevVars` writes `LUNORA_E2E="true"`, and the external branch
 * deliberately does not write `.dev.vars` — it must not clobber the file of the
 * server it did not start. So a playground booted the documented way
 * (`pnpm --filter @lunora/playground dev`) answers every page request fine and
 * then 404s the first `/test/reset`, which surfaces as every test failing at its
 * `beforeEach` with no hint at the cause. Say it once, here, with the fix.
 */
const assertTestRoutesEnabled = async (): Promise<void> => {
    const response = await fetch(`${BASE_URL}/test/reset`, { method: "POST" });

    if (response.ok) {
        return;
    }

    throw new Error(
        `[e2e] the playground at ${BASE_URL} answered ${response.status} for POST /test/reset. ` +
            `Those routes are gated on LUNORA_E2E="true" in apps/playground/.dev.vars — add it there and restart the server ` +
            `(see apps/playground/.dev.vars.example), or drop LUNORA_E2E_EXTERNAL and let this suite start its own.`,
    );
};

const globalSetup = async (_config: FullConfig): Promise<void> => {
    if (process.env.LUNORA_E2E_EXTERNAL === "true") {
        // An external orchestrator already started the playground (`pnpm dev` in
        // another terminal). Just wait for it.
        const start = Date.now();

        while (Date.now() - start < 10_000) {
            if (await probeUrl(`${BASE_URL}/api/auth/ok`)) {
                await assertTestRoutesEnabled();

                return;
            }

            await new Promise((resolve) => setTimeout(resolve, 250));
        }

        throw new Error(`[e2e] LUNORA_E2E_EXTERNAL=true but no playground is answering on ${BASE_URL}`);
    }

    // Fail fast on a stale server: testing against an unknown, already-running
    // process (crashed previous run, a dev's `pnpm dev`) yields confusing
    // state-dependent failures. Make the conflict explicit instead.
    if (await probeUrl(BASE_URL)) {
        throw new Error(`[e2e] something is already listening on ${BASE_URL} — stop it (or pass LUNORA_E2E_EXTERNAL=true to run against it deliberately).`);
    }

    installDevVars();

    // `LUNORA_E2E` in the process env tells `vite.config.ts` to make storage
    // ephemeral; the same flag in `.dev.vars` (above) gates the worker's /test routes.
    const vite = spawnProc("vite", "pnpm", ["exec", "vite", "--port", PORT, "--strictPort"], PLAYGROUND, { LUNORA_E2E: "true" });

    globalThis.LUNORA_E2E_PROCS = [vite];

    const deadlineAt = Date.now() + BOOT_TIMEOUT_MS;

    try {
        await waitForServer(BASE_URL, deadlineAt, "vite", vite);
        // Hit a worker route so the embedded worker boots + runs the better-auth
        // migration once, before the first test (so none pays it inside its timeout).
        await waitForServer(`${BASE_URL}/api/auth/ok`, deadlineAt, "worker", vite);
    } catch (error) {
        // Boot failed — don't leak the half-started tree into the next run.
        const { default: globalTeardown } = await import("./globalTeardown");

        await globalTeardown(_config);

        throw error;
    }
};

export { DEV_VARS_PATH };
export default globalSetup;
