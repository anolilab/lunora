import { lunora } from "@lunora/vite";
import { defineConfig, loadEnv } from "vite";

import { devPortsFor, shiftedPort } from "../../shared/dev-ports";

export default defineConfig(({ mode }) => {
    const ports = devPortsFor(loadEnv(mode, process.cwd(), ""));

    return {
        plugins: [
            // The Cloudflare plugin otherwise picks the first free inspector port, which
            // two apps starting at the same moment can both claim — one then dies with
            // EADDRINUSE. Pinning one per example makes running several side by side work.
            lunora({ cloudflare: { inspectorPort: shiftedPort(9229, ports) } }),
        ],
        server: {
            // Fail rather than drift to the next port: a signed storage URL and an auth
            // callback both bind to the origin, so a silently-moved port breaks them.
            port: ports.playground,
            strictPort: true,
        },
    };
});
