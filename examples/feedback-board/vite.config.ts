import { lunora } from "@lunora/vite";
import { defineConfig } from "vite";

export default defineConfig({
    plugins: [
        // The Cloudflare plugin otherwise picks the first free inspector port, which
        // two apps starting at the same moment can both claim — one then dies with
        // EADDRINUSE. Pinning one per example makes running several side by side work.
        lunora({ cloudflare: { inspectorPort: 9230 } }),
    ],
    server: {
        // Fail rather than drift to 5174: a signed storage URL and an auth
        // callback both bind to the origin, so a silently-moved port breaks them.
        port: 5173,
        strictPort: true,
    },
});
