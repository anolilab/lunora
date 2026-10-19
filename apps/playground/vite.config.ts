import { existsSync, readFileSync } from "node:fs";

import { lunora } from "@lunora/vite";
import { defineConfig, loadEnv } from "vite";

import { describeDevPorts, devPortsFor, staleDevOrigin } from "../../shared/dev-ports";

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

        const devVars = existsSync(".dev.vars") ? readFileSync(".dev.vars", "utf8") : "";
        const stale = ports.offset === 0 ? undefined : staleDevOrigin(devVars, ports.playground);

        // Refused, not warned: the scheduler dispatches to this variable and cannot be steered at runtime, so a
        // warning lets scheduled jobs run on another checkout's server.
        if (stale !== undefined) {
            throw new Error(
                `[playground] .dev.vars sets LUNORA_ORIGIN_URL="${stale}" but this checkout serves :${String(ports.playground)}; scheduled jobs would call back to the wrong server. Set it to http://localhost:${String(ports.playground)}.`,
            );
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
