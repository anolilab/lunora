import { lunora } from "@lunora/vite";
import { defineConfig, loadEnv } from "vite";

import { devPortsFor, shiftedPort } from "../../shared/dev-ports";

export default defineConfig(({ mode }) => {
    const ports = devPortsFor(loadEnv(mode, process.cwd(), ""));

    return {
        plugins: [lunora()],
        server: {
            // Fail rather than drift to the next port: a signed storage URL and an auth
            // callback both bind to the origin, so a silently-moved port breaks them.
            port: shiftedPort(5175, ports),
            strictPort: true,
        },
    };
});
