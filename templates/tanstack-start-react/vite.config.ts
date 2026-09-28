import { lunora } from "@lunora/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

/**
 * Tells the SSR render which origin to call Lunora on.
 *
 * The browser can use `location.origin`; a server render has no page to be
 * relative to, so it needs an absolute URL. There is no second worker here —
 * `virtual:lunora/worker` composes Lunora and the SSR handler into one worker,
 * so that origin is this very dev server. Hardcoding a port means the app
 * breaks the moment it runs on another one (`vite --port 3000`, a second app on
 * the same machine, a preview deploy); reading Vite's *resolved* port covers all
 * of those, and an explicit `VITE_LUNORA_URL` still wins.
 *
 * It runs on `serve` ONLY. `define` is a global text replacement, so without
 * `apply` a production build bakes `http://localhost:<port>` into the CLIENT
 * bundle too — and the client prefers it over `location.origin`, so every
 * deployed browser connects to its own machine. Set `VITE_LUNORA_URL` to point
 * a build at a standalone Worker; otherwise the browser uses its page origin,
 * which is correct for this single-worker topology.
 */
const ssrOrigin = (): Plugin => ({
    apply: "serve",
    config(userConfig) {
        if (process.env.VITE_LUNORA_URL) {
            return undefined;
        }

        // `--port` is merged into the config before plugin `config` hooks run,
        // so this is the port the server will actually bind.
        const port = userConfig.server?.port ?? 5173;

        return { define: { "import.meta.env.VITE_LUNORA_URL": JSON.stringify(`http://localhost:${port}`) } };
    },
    name: "lunora-ssr-origin",
});

/**
 * Plugin ordering is load-bearing on Cloudflare:
 *  1. cloudflare()       — must come first so it owns the "ssr" Vite environment
 *                          before tanstackStart() configures it.
 *  2. tanstackStart()    — generates the SSR + client entry points + route tree
 *                          (reads `tsr.config.json`, which targets React).
 *  3. react()            — JSX transform.
 *  4. lunora({cloudflare:false}) — codegen, wrangler validation, studio overlay.
 *                          `cloudflare: false` tells Lunora not to re-add
 *                          @cloudflare/vite-plugin (it's already position 0 above).
 *
 * The `virtual:lunora/worker` entry (set in wrangler.jsonc `main`) is resolved
 * by the frameworkComposePlugin inside lunora() — it emits a composed worker
 * that routes `/_lunora/*` to Lunora and everything else to the TanStack Start
 * SSR handler (@tanstack/react-start/server-entry).
 */
export default defineConfig({
    resolve: {
        // Vite 8 resolves tsconfig paths natively — no vite-tsconfig-paths plugin needed.
        tsconfigPaths: true,
    },
    // `allowUnauthenticatedShardAccess: true` is a DEMO default: the composed
    // worker default-denies client-named shard access (403), so an auth-less
    // `.shardBy(...)` demo needs this to work. Nothing else guards the data: the
    // demo schema declares no RLS, so any caller can read and write every row.
    // Before deploying, add auth and row-level security (`.rls(...)` in
    // lunora/schema.ts), drop this flag, and configure `authorizeShard` in a
    // hand-written worker instead.
    plugins: [
        cloudflare({ viteEnvironment: { name: "ssr" } }),
        tanstackStart(),
        react(),
        lunora({ allowUnauthenticatedShardAccess: true, cloudflare: false }),
        ssrOrigin(),
    ],
});
