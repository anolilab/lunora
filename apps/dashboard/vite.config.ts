import { defineConfig } from "vite";

// Plain SPA: the dashboard talks to a remote Cirrus worker over HTTP, so this
// app ships no worker/wrangler of its own. Vite's built-in esbuild transform
// handles the automatic JSX runtime — no React plugin dependency needed.
export default defineConfig({
    esbuild: {
        jsx: "automatic",
    },
    server: {
        port: 5174,
    },
});
