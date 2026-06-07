import { cirrus } from "@cirrus/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";

/**
 * The TanStack Start app + Cirrus's vite plugin share a single config:
 * `cirrus()` runs codegen + wrangler validation + the dev overlay while
 * `TanStackRouterVite` generates the typed route tree.
 */
export default defineConfig({
    plugins: [TanStackRouterVite({ autoCodeSplitting: true }), cirrus()],
});
