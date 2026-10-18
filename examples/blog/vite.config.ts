import { lunora } from "@lunora/vite";
import { defineConfig, loadEnv } from "vite";

import { devPortsFor, shiftedPort } from "../../shared/dev-ports";

export default defineConfig(({ mode }) => {
    const ports = devPortsFor(loadEnv(mode, process.cwd(), ""));

    return {
        plugins: [lunora()],
        server: {
            port: shiftedPort(5175, ports),
        },
    };
});
