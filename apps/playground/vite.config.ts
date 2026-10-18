import { lunora } from "@lunora/vite";
import { defineConfig, loadEnv } from "vite";

import { describeDevPorts, devPortsFor } from "../../shared/dev-ports";

// In the e2e harness we keep the single embedded worker (prod parity) but make
// its Miniflare storage ephemeral (`persistState: false`) so each run starts
// from a clean DO / D1 / R2 — no state leaking across runs, and the developer's
// own `.wrangler/state` is left untouched.
const e2e = process.env.LUNORA_E2E === "true";

export default defineConfig(({ command, mode }) => {
    const ports = devPortsFor(loadEnv(mode, process.cwd(), ""));

    if (command === "serve") {
        // eslint-disable-next-line no-console -- dev-server startup line, read by humans and agents
        console.info(`[playground] ${describeDevPorts(ports)}`);

        if (ports.offset !== 0) {
            // eslint-disable-next-line no-console -- dev-server startup line, read by humans and agents
            console.info(`[playground] set LUNORA_ORIGIN_URL="http://localhost:${String(ports.playground)}" in .dev.vars (scheduled jobs call back to it)`);
        }
    }

    return {
        plugins: [lunora(e2e ? { cloudflare: { persistState: false } } : undefined)],
        server: {
            port: ports.playground,
            // Fail rather than slide to the next free port. The port is derived per
            // checkout (see shared/dev-ports.ts), so a taken port means another server
            // holds it, and a silent slide would send the studio proxy and auth
            // callbacks to a different app. (`LUNORA_ORIGIN_URL` is the Worker's own
            // origin, :8787 in wrangler.jsonc for `wrangler dev`; the e2e harness
            // overrides it to the playground port, where Vite serves the worker.)
            strictPort: true,
        },
    };
});
