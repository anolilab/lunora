import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The example workspaces and the ports the browser suite drives them on.
 */
export const EXAMPLES = [
    { name: "kanban-board", port: 5273 },
    // Workers AI has no local emulation: the `AI` binding is proxied to
    // Cloudflare even under `vite dev`, so this one cannot boot without an
    // authenticated account. See the credential gate in the Playwright config.
    { name: "feedback-board", needsCloudflareAuth: true, port: 5274 },
    { name: "team-chat", port: 5275 },
    { name: "chess", port: 5276 },
    { name: "tanstack-start", port: 5277 },
] as const;

const ROOT = new URL("../../", import.meta.url).pathname;

const DEV_VARS = `# Written by tests/e2e/examples-setup.ts because none existed.
AUTH_SECRET="examples-e2e-deterministic-secret"
STORAGE_SECRET="examples-e2e-deterministic-storage-secret"
`;

/**
 * Give every example a `.dev.vars`, but only if it has none.
 *
 * `.dev.vars` is gitignored, so a CI runner starts without one and the auth and
 * storage examples refuse to boot. Writing it unconditionally is worse than not
 * writing it at all: Vite watches the file, Playwright re-imports this module in
 * every worker process, and a swap-then-restore cycle across runs restarts all
 * five dev servers mid-boot — which is how this suite first came up blank.
 * Create-if-absent is idempotent, leaves a developer's own secrets alone, and
 * needs no teardown.
 */
export const installDevVars = (): void => {
    for (const { name } of EXAMPLES) {
        const path = join(ROOT, "examples", name, ".dev.vars");

        if (!existsSync(path)) {
            writeFileSync(path, DEV_VARS, "utf8");
        }
    }
};
