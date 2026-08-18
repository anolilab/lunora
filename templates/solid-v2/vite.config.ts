import { lunora } from "@lunora/vite";
import solidPlugin from "vite-plugin-solid";
import { defineConfig } from "vite";

/**
 * Plugin order matters:
 *  1. solidPlugin() — Solid 2's JSX transform. It must see the JSX before any
 *     other plugin rewrites it.
 *  2. lunora()      — codegen, the `wrangler.jsonc` validator, the error
 *                     overlay, the embedded Studio at `/__lunora`, and
 *                     @cloudflare/vite-plugin, which runs the Worker
 *                     (`src/server.ts`) on the SAME origin as the dev server.
 *                     That shared origin is why the client can default its
 *                     endpoint to `location.origin`.
 *
 * `vite-plugin-solid` is on its 3.x line here: Solid 2 moved the JSX runtime out
 * of core into `@solidjs/web`, and 3.x is the release that emits imports against
 * it. The 2.x plugin still emits `solid-js/web` — a subpath Solid 2 no longer
 * exports — so pairing it with Solid 2 fails at resolve time, in generated code
 * you never wrote.
 */
export default defineConfig({
    // The open-shard-access demo default lives on the worker entry
    // (`src/server.ts`), not here: this plugin option only reaches the generated
    // `virtual:lunora/worker` composition that the meta-framework templates use,
    // and this template ships its own entry.
    plugins: [solidPlugin(), lunora()],
});
