import { existsSync, readFileSync } from "node:fs";

import { lunora } from "@lunora/vite";
import { defineConfig, loadEnv } from "vite";

import { describeDevPorts, devPortsFor, servedPlaygroundPort, staleDevOrigin } from "../../shared/dev-ports";

/*
 * The bench serves on the playground's per-checkout port: the two are never run
 * side by side, and reusing the pair keeps one rule for which origin a checkout's
 * `.dev.vars` names.
 */
export default defineConfig(({ command, mode }) => {
    const env = loadEnv(mode, process.cwd(), "");
    const ports = devPortsFor(env);

    if (command === "serve") {
        process.stdout.write(`[bench] ${describeDevPorts(ports)}\n`);

        const devVars = existsSync(".dev.vars") ? readFileSync(".dev.vars", "utf8") : "";
        const stale = staleDevOrigin(devVars, servedPlaygroundPort(ports, env));

        // Refused, not warned: workflow, scheduler and agent callbacks dispatch to this
        // origin, and a stale one sends them to whichever server holds that port.
        if (stale !== undefined) {
            throw new Error(
                `[bench] .dev.vars sets LUNORA_ORIGIN_URL="${stale}" but this checkout serves :${String(ports.playground)}; set it (and BETTER_AUTH_URL / APP_BASE_URL) to http://localhost:${String(ports.playground)}.`,
            );
        }
    }

    return {
        // `both`: the MCP route (`lunora/server.ts`) serves the OpenRPC document.
        plugins: [lunora({ apiSpec: "both" })],
        server: { port: ports.playground, strictPort: true },
    };
});
