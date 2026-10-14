import { cloudflare } from "@cloudflare/vite-plugin";
import { lunora } from "@lunora/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

/**
 * Tells the SSR loader which origin to call Lunora on.
 *
 * The browser can use `location.origin`; a server render has no page to be
 * relative to, so it needs an absolute URL. Hardcoding one means the app 500s
 * the moment it runs anywhere but that port — `vite --port 3000`, a second
 * example on the same machine, a preview deploy. Reading Vite's *resolved* port
 * covers all of those, and an explicit `VITE_LUNORA_URL` still wins.
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
    name: "lunora-example-ssr-origin",
});

/**
 * Plugin order is load-bearing on Cloudflare:
 *
 * 1. `cloudflare()` must come first so it owns the `ssr` Vite environment before
 *    `tanstackStart()` configures it.
 * 2. `tanstackStart()` generates the SSR + client entries and the route tree.
 * 3. `react()` does the JSX transform.
 * 4. `lunora({ cloudflare: false })` adds codegen, wrangler validation and the
 *    studio overlay — `cloudflare: false` because the plugin is already at
 *    position 0.
 *
 * `wrangler.jsonc`'s `main` is `virtual:lunora/worker`, which Lunora's compose
 * plugin resolves into a worker that routes `/_lunora/*` to Lunora and
 * everything else to the TanStack Start SSR handler.
 */
export default defineConfig({
    plugins: [cloudflare({ inspectorPort: 9233, viteEnvironment: { name: "ssr" } }), tanstackStart(), react(), lunora({ cloudflare: false }), ssrOrigin()],
    resolve: {
        // Vite 8 resolves tsconfig paths natively.
        tsconfigPaths: true,
    },
});
