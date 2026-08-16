import { cloudflare } from "@cloudflare/vite-plugin";
import { lunora } from "@lunora/vite";
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
 * so that origin is this very dev server. Hardcoding a port breaks the moment it
 * runs on another one (`vite --port 3000`, a second app on the same machine, a
 * preview deploy); reading Vite's *resolved* port covers all of those, and an
 * explicit `VITE_LUNORA_URL` still wins.
 */
const ssrOrigin = (): Plugin => ({
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
 *                          @cloudflare/vite-plugin (it's already position 0).
 *
 * Copied from `templates/tanstack-start-react` deliberately: the builder
 * generates apps from that template, so its own composition being the same one
 * is what keeps "works here" and "works in a generated app" the same statement.
 */
export default defineConfig({
    plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), tanstackStart(), react(), lunora({ cloudflare: false }), ssrOrigin()],
    resolve: {
        // Vite 8 resolves tsconfig paths natively — no vite-tsconfig-paths plugin needed.
        tsconfigPaths: true,
    },
});
