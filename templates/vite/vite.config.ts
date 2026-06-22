import { lunora } from "@lunora/vite";
import { defineConfig } from "vite";

// `lunora()` wraps `@cloudflare/vite-plugin`: it runs your Worker alongside the
// client, watches `lunora/` for codegen, serves the Studio, and wires the error
// overlay — so `pnpm dev` is the only command you need.
export default defineConfig({
    plugins: [lunora()],
    server: { port: 5173 },
});
