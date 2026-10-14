import { createRequire } from "node:module";

import { resolveOptions } from "./options";
import { LunoraRspackPlugin } from "./plugin";
import type { LunoraRspackOptions } from "./types";

/**
 * Lunora Rspack plugin. Add it to `plugins` in `rspack.config.*` (or
 * `tools.rspack.plugins` under Rsbuild) and it will:
 *
 * 1. Run `@lunora/codegen` before every compilation, and again on any edit
 * under `lunora/` in watch mode.
 * 2. Write the Cloudflare bindings your code implies into `wrangler.jsonc`,
 * plus your cron triggers and the compatibility date.
 * 3. Validate that config against the schema's requirements (`validateWrangler`).
 * 4. Run the project's `postcodegen` hook.
 *
 * A production build fails on an ERROR-level advisory or platform diagnostic; a
 * watch rebuild logs them and carries on.
 *
 * **It does not run your Worker.** Rspack has no `@cloudflare/vite-plugin`
 * equivalent — no workerd/miniflare integration — so this plugin builds the
 * client half and `wrangler dev` (or `lunora dev`) runs the Worker, which is the
 * same split as `@lunora/vite`'s `cloudflare: false` path. The Vite plugin's
 * dev-server features therefore have no counterpart here: no error overlay, no
 * embedded Studio, no worker log streaming, no remote-binding injection. Use
 * `lunora dev` for those, or `@lunora/vite` if you want them in-process.
 *
 * The plugin API tapped here is webpack 5's, so the same instance works in a
 * webpack build unchanged.
 */
const lunoraRspack = (options?: LunoraRspackOptions): LunoraRspackPlugin => new LunoraRspackPlugin(resolveOptions(options));

// Read the real published version from the package manifest at load time rather
// than a hardcoded literal (which lies to anyone introspecting the plugin for
// support diagnostics). `../package.json` resolves to this package's manifest
// from both `src/index.ts` (tsc/vitest) and the bundled `dist/index.mjs`.
const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

// Deliberately narrow. `CompilerLike` has to be public — it is in `apply`'s
// signature — but `./codegen` stays internal (its `Project` would drag `ts-morph`
// into this package's `.d.ts`, a type a consumer never installs), and so do the
// projection's inner types and the option resolver. `@lunora/vite`, which has
// adopters, publishes three values; this package has none yet.
export type { CompilerLike } from "./compiler";
export { LunoraRspackPlugin } from "./plugin";
export type { LunoraRspackOptions } from "./types";
export { lunoraRspack, VERSION };
