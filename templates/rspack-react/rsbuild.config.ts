import { lunoraRsbuild } from "@lunora/rspack/rsbuild";
import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

/**
 * `lunoraRsbuild()` runs codegen before every compilation, provisions the
 * bindings your code implies into `wrangler.jsonc`, and — under `rsbuild dev` —
 * starts the Worker (`src/server.ts`) with `wrangler dev` and proxies
 * `/_lunora/*` (RPC + the live-query WebSocket) to it. The browser only ever
 * talks to this dev server's origin, which is why the client can default its
 * endpoint to `location.origin`.
 *
 * `rsbuild build` writes the SPA to `dist/`, which `wrangler.jsonc` binds as the
 * Worker's static assets — one deployment serves both.
 */
export default defineConfig({
    html: { title: "{{name}}" },
    plugins: [pluginReact(), lunoraRsbuild()],
});
