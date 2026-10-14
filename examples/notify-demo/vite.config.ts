import { lunora } from "@lunora/vite";
import { defineConfig } from "vite";

export default defineConfig({
    plugins: [lunora()],
    server: {
        port: 5173,
    },
});
