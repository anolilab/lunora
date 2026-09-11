import { cloudflare } from "@cloudflare/vite-plugin";
import { lunora } from "@lunora/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig, loadEnv } from "vite";

/** The port the dev server binds when nothing overrides it — Vite's own default. */
const DEFAULT_PORT = 5173;

/**
 * Tells the SSR render which origin to call Lunora on.
 *
 * The browser can use `location.origin`; a server render has no page to be
 * relative to, so it needs an absolute URL. There is no second worker here —
 * `virtual:lunora/worker` composes Lunora and the SSR handler into one worker,
 * so in dev that origin is this very dev server.
 *
 * Three rules, each of which the first version of this hook got wrong:
 *
 * 1. **`VITE_LUNORA_URL` wins, wherever it is set.** Vite does not apply `.env`
 *    files to `process.env`, so a value that lives only in `.env` is invisible to
 *    a `process.env` probe during config evaluation — the hook then "helpfully"
 *    overrode the configured URL with a localhost guess. `loadEnv` reads the
 *    `.env` chain *and* the shell, which is why the origin is resolved by the
 *    callback config below and passed in.
 * 2. **The localhost default is dev-only.** `config` also runs for `vite build`,
 *    where baking `http://localhost:5173` into a deployed Worker's SSR bundle is
 *    never right. On a build with no configured origin the hook defines nothing
 *    and leaves the decision to deploy configuration.
 * 3. **The port must be the one that gets bound.** `define` is fixed at config
 *    time and Vite picks a replacement port *after* `config()` runs, so the
 *    config below sets `strictPort` — a busy port is now a startup error instead
 *    of a server quietly listening somewhere the baked origin does not point.
 */
const ssrOrigin = ({ command, origin }: { command: string; origin: string | undefined }): Plugin => ({
    config(userConfig) {
        if (origin !== undefined && origin.length > 0) {
            return { define: { "import.meta.env.VITE_LUNORA_URL": JSON.stringify(origin) } };
        }

        // A build with no deployment origin: say nothing rather than assert a
        // localhost one. `src/routes/__root.tsx`'s own fallback then applies, and
        // a real deploy sets `VITE_LUNORA_URL`.
        if (command !== "serve") {
            return undefined;
        }

        // Safe to read now: `strictPort` below means this IS the port the server
        // binds, or startup fails.
        const port = userConfig.server?.port ?? DEFAULT_PORT;

        return { define: { "import.meta.env.VITE_LUNORA_URL": JSON.stringify(`http://localhost:${String(port)}`) } };
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
export default defineConfig(({ command, mode }) => {
    // The `.env` chain plus any `VITE_`-prefixed shell variable. Resolved here,
    // in the callback, because a plugin `config` hook is too late to load it and
    // `process.env` alone never sees a `.env` file.
    const environment = loadEnv(mode, process.cwd(), "VITE_");

    return {
        plugins: [
            cloudflare({ viteEnvironment: { name: "ssr" } }),
            tanstackStart(),
            react(),
            lunora({ cloudflare: false }),
            ssrOrigin({ command, origin: environment["VITE_LUNORA_URL"] }),
        ],
        resolve: {
            // Vite 8 resolves tsconfig paths natively — no vite-tsconfig-paths plugin needed.
            tsconfigPaths: true,
        },
        server: {
            // The SSR origin is baked at config time, so the server must bind the
            // port that was baked or refuse to start. Silently moving to 5174
            // leaves every server-rendered Lunora call pointed at 5173.
            strictPort: true,
        },
    };
});
