import { existsSync, readFileSync } from "node:fs";

import { lunora } from "@lunora/vite";
import { defineConfig, loadEnv } from "vite";

import { describeDevPorts, devPortsFor, shiftedPort, staleDevOrigin } from "../../shared/dev-ports";

export default defineConfig(({ command, mode }) => {
    const ports = devPortsFor(loadEnv(mode, process.cwd(), ""));
    const port = shiftedPort(5175, ports);

    if (command === "serve") {
        process.stdout.write(`[blog] ${describeDevPorts(ports)}; serving :${String(port)}\n`);

        const devVars = existsSync(".dev.vars") ? readFileSync(".dev.vars", "utf8") : "";
        const stale = ports.offset === 0 ? undefined : staleDevOrigin(devVars, port);

        // Refused, not warned: see the playground config.
        if (stale !== undefined) {
            throw new Error(
                `[blog] .dev.vars sets LUNORA_ORIGIN_URL="${stale}" but this checkout serves :${String(port)}; scheduled jobs would call back to the wrong server. Set it to http://localhost:${String(port)}.`,
            );
        }
    }

    return {
        plugins: [lunora()],
        server: {
            // Fail rather than drift to the next port: a signed storage URL and an auth
            // callback both bind to the origin, so a silently-moved port breaks them.
            port,
            strictPort: true,
        },
    };
});
