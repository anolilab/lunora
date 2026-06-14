import { cirrus } from "@cirrus/vite";
import { defineConfig } from "vite";

// The control-plane Worker (src/server.ts) + the hosted-studio SPA
// (src/client) are served together by `@cirrus/vite` (codegen + the Cloudflare
// vite plugin), exactly as the playground app wires worker + client.
export default defineConfig({
    plugins: [cirrus()],
    server: { port: 5174 },
});
