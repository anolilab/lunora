import { fileURLToPath } from "node:url";

import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const fromHere = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

// Plain SPA: the studio talks to a remote Lunora worker over HTTP, so this
// app ships no worker/wrangler of its own. Tailwind v4 (shadcn + Base UI) is
// compiled by @tailwindcss/vite; it scans this app plus the @lunora/studio
// source declared via @source in index.css.
//
// React Compiler is enabled here, mirroring the @lunora/studio package's packem
// build (`panicThreshold: "none"`), so this standalone app — which resolves the
// studio to SOURCE via the alias below — behaves like the embedded studio that
// ships the compiled dist. It is defense-in-depth + perf, NOT a correctness
// dependency: the data-browser effects read their churny callbacks through refs
// and depend on view *values* (see `use-data-browser`), so a compiler bailout
// can't reintroduce the old read/navigate loop. `panicThreshold: "none"` (skip
// uncompilable components, never fail the build) is therefore the right call —
// nothing here breaks if a component ships uncompiled.
export default defineConfig(({ mode }) => {
    // Read env from the shell AND `.env`/`.env.local` (the `""` prefix loads all
    // keys, not just `VITE_*`). `process.env` alone misses `.env` files because
    // Vite evaluates this config before loading them — hence `loadEnv`.
    const env = loadEnv(mode, process.cwd(), "");

    // The local Lunora worker the studio's same-origin `/_lunora/*` calls (HTTP +
    // the live WebSocket) are proxied to. One knob: override with `LUNORA_DEV_PROXY`
    // (shell or `.env`), else the playground's default port. The studio client
    // always uses its OWN origin (see `main.tsx`), and this proxy forwards to the
    // worker — so the browser only ever talks to one origin (no cross-origin
    // CORS/WS, which can storm the socket pool against a cold worker).
    const workerUrl = env["LUNORA_DEV_PROXY"] ?? "http://localhost:5173";

    return {
        plugins: [react(), babel({ presets: [reactCompilerPreset({ panicThreshold: "none" })] }), tailwindcss()],
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
            // Always proxy the studio's same-origin `/_lunora/*` calls (HTTP + the
            // live WebSocket) to the local worker, so the standalone studio works out
            // of the box (point at a different worker with `LUNORA_DEV_PROXY`). Keeping
            // it always-on — rather than opt-in — means the browser never talks to the
            // worker cross-origin in dev, which is what could storm the socket pool
            // against a cold worker. A production build ships no dev server, so this is
            // a dev-only concern.
            proxy: {
                "/_lunora": {
                    changeOrigin: true,
                    target: workerUrl,
                    ws: true,
                },
            },
        },
    };
});
