import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const fromHere = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

// Plain SPA: the dashboard talks to a remote Cirrus worker over HTTP, so this
// app ships no worker/wrangler of its own. Vite's built-in esbuild transform
// handles the automatic JSX runtime — no React plugin dependency needed.
// Tailwind v4 (shadcn + Base UI) is compiled by @tailwindcss/vite; it scans
// this app plus the @cirrus/dashboard source declared via @source in index.css.
export default defineConfig({
    plugins: [tailwindcss()],
    esbuild: {
        jsx: "automatic",
    },
    resolve: {
        // Resolve the dashboard library to its SOURCE (not the built dist), so
        // editing a panel HMRs instantly and the build compiles from source —
        // no `packem build` step between changing the UI and seeing it. The
        // more specific `/mount` subpath must come first.
        alias: {
            "@cirrus/dashboard/mount": fromHere("../../packages/dashboard/src/mount.tsx"),
            "@cirrus/dashboard": fromHere("../../packages/dashboard/src/index.ts"),
        },
    },
    server: {
        port: 5174,
    },
});
