import { lunora } from "@lunora/vite";
import { defineConfig } from "vite";

import { devPortsFor } from "../../shared/dev-ports";

const ports = devPortsFor(process.env);

export default defineConfig({
    plugins: [lunora()],
    server: {
        port: ports.playground,
    },
});
