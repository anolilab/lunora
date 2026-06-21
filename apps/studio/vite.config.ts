import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const fromHere = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

// Plain SPA: the studio talks to a remote Lunora worker over HTTP, so this
// app ships no worker/wrangler of its own. Vite's built-in esbuild transform
// handles the automatic JSX runtime — no React plugin dependency needed.
// Tailwind v4 (shadcn + Base UI) is compiled by @tailwindcss/vite; it scans
// this app plus the @lunora/studio source declared via @source in index.css.
export default defineConfig({
    plugins: [tailwindcss()],
    esbuild: {
        jsx: "automatic",
    },
    resolve: {
        // Resolve the studio library to its SOURCE (not the built dist), so
        // editing a panel HMRs instantly and the build compiles from source —
        // no `packem build` step between changing the UI and seeing it. The
        // more specific `/mount` subpath must come first.
        alias: {
            "@lunora/studio/mount": fromHere("../../packages/studio/src/mount.tsx"),
            "@lunora/studio": fromHere("../../packages/studio/src/index.ts"),
        },
    },
    server: {
        port: 5174,
        // Opt-in dev proxy: point the standalone studio at a Lunora worker
        // running locally (e.g. the playground on :5173) without CORS/WS hassle —
        // the studio's same-origin `/_lunora/*` calls (HTTP + the live WebSocket)
        // are forwarded to it. Enable with `LUNORA_DEV_PROXY=http://localhost:5173
        // pnpm --filter @lunora/studio-app dev`. Off by default, so production
        // builds are unaffected (proxy is a dev-server-only concept).
        ...(process.env.LUNORA_DEV_PROXY
            ? {
                  proxy: {
                      "/_lunora": {
                          changeOrigin: true,
                          target: process.env.LUNORA_DEV_PROXY,
                          ws: true,
                      },
                  },
              }
            : {}),
    },
});
