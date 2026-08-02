import { lunora } from "@lunora/vite";
import { defineConfig } from "vite";

export default defineConfig({
    plugins: [lunora()],
    server: {
        // Fail rather than drift to 5174: a signed storage URL and an auth
        // callback both bind to the origin, so a silently-moved port breaks them.
        port: 5173,
        strictPort: true,
    },
});
