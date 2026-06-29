import { fileURLToPath } from "node:url";

import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const fromHere = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

// The local Lunora worker the studio's same-origin `/_lunora/*` calls (HTTP +
// the live WebSocket) are proxied to. One knob: override with `LUNORA_DEV_PROXY`,
// else the playground's default port. The studio client always uses its OWN
// origin (see `main.tsx`), and this proxy forwards to the worker — so the browser
// only ever talks to one origin (no cross-origin CORS/WS, which can storm the
// socket pool against a cold worker).
const workerUrl = process.env.LUNORA_DEV_PROXY ?? "http://localhost:5173";

// Plain SPA: the studio talks to a remote Lunora worker over HTTP, so this
// app ships no worker/wrangler of its own. Tailwind v4 (shadcn + Base UI) is
// compiled by @tailwindcss/vite; it scans this app plus the @lunora/studio
// source declared via @source in index.css.
//
// React Compiler is enabled here (mirroring the @lunora/studio package's packem
// build, `panicThreshold: "none"`). It's REQUIRED, not an optimization: the
// studio source — resolved to SOURCE via the alias below — is written assuming
// the compiler stabilises callback identities (e.g. effect deps in the data
// browser, `useConnectionStatus`'s subscribe). Built uncompiled, those
// callbacks churn every render and the effects loop — re-issuing reads until the
// socket pool is exhausted and re-asserting the URL so you can't leave the data
// tab. Compiling here makes this standalone app behave like the embedded studio.
export default defineConfig({
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
});
