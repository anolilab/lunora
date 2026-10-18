import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { devPortsFor, shiftedPort } from "../../shared/dev-ports";

const ports = devPortsFor(process.env);

/**
 * The example workspaces and the ports the browser suite drives them on.
 */
export const EXAMPLES = [
    { name: "kanban-board", port: shiftedPort(5273, ports) },
    // Workers AI has no local emulation: the `AI` binding is proxied to
    // Cloudflare even under `vite dev`, so this one cannot boot without an
    // authenticated account. See the credential gate in the Playwright config.
    { name: "feedback-board", needsCloudflareAuth: true, port: shiftedPort(5274, ports) },
    { name: "team-chat", port: shiftedPort(5275, ports) },
    { name: "chess", port: shiftedPort(5276, ports) },
    { name: "tanstack-start", port: shiftedPort(5277, ports) },
    // Plan 457: two sibling Workers run as auxiliary Workers in the same
    // `vite dev` session, bound to the app as `ctx.services`.
    { name: "services", port: shiftedPort(5278, ports) },
] as const;

/**
 * Whether the examples that need a real Cloudflare account can run.
 *
 * A CI runner has neither `CLOUDFLARE_API_TOKEN` nor a cached `wrangler login`,
 * so the Workers AI binding cannot boot. Locally the example is left in: a
 * developer usually is logged in, and if not, the plugin's own error names the
 * variable to set.
 *
 * Read by BOTH halves on purpose — the Playwright config, to decide whether to
 * start that example's dev server, and the spec, to skip its tests with a
 * reason the reporter counts. Before that, the config quietly dropped the whole
 * project and logged a `console.warn`: three tests then existed in no run, no
 * report and no required check, and the gate went green having executed them
 * zero times.
 */
export const CLOUDFLARE_AUTH_AVAILABLE = process.env.CI !== "true" || Boolean(process.env.CLOUDFLARE_API_TOKEN);

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
