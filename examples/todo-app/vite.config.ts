import { cirrus } from "@cirrus/vite";
import { defineConfig } from "vite";

export default defineConfig(async () => ({
    plugins: [...(await cirrus())],
    server: {
        port: 5173,
    },
}));
