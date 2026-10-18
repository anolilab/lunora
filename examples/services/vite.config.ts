import { lunora } from "@lunora/vite";
import { defineConfig, loadEnv } from "vite";

import { devPortsFor } from "../../shared/dev-ports";

export default defineConfig(({ mode }) => {
    const ports = devPortsFor(loadEnv(mode, process.cwd(), ""));

    return {
        plugins: [lunora()],
        server: {
            port: ports.playground,
        },
    };
});
