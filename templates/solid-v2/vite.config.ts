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
 * `vite-plugin-solid` is on its 3.x line here: Solid 2 moved the JSX runtime
 * out of core into `@solidjs/web`, and 3.x is the release that emits imports
 * against it. Pairing Solid 2 with the 2.x plugin silently emits `solid-js/web`
 * imports that no longer resolve.
 */
export default defineConfig({
    // `allowUnauthenticatedShardAccess: true` is a DEMO default: the worker
    // default-denies client-named shard access (403), so the auth-less
    // `.shardBy(...)` demo in `lunora/schema.ts` needs it — data is protected by
    // per-row RLS. A PRODUCTION sharded app should drop it and configure
    // `authorizeShard` on the worker entry instead.
    plugins: [solidPlugin(), lunora({ allowUnauthenticatedShardAccess: true })],
});
