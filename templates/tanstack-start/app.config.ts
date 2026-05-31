/**
 * TanStack Start app config. Kept thin — the Vite plugin (configured in
 * vite.config.ts) is what TanStack Start v1 actually wires up. This file
 * is the canonical place to declare server presets, deployment targets,
 * and per-environment toggles.
 */
import { defineConfig } from "@tanstack/react-start/config";

export default defineConfig({
    // Cloudflare's TanStack Start preset wires the SSR entry to a Worker.
    server: {
        preset: "cloudflare-module",
    },
    tsr: {
        appDirectory: "src",
    },
});
