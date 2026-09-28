import { createRequire } from "node:module";

import { isRunnableTarget, resolveTargetOrThrow, runnableTargetIds } from "@lunora/config";

import { LunoraRspackPlugin } from "./plugin";
import type { LunoraRspackOptions, ResolvedLunoraRspackOptions } from "./types";

/**
 * `resolveTargetOrThrow`, plus the check that the resolved target is one with a
 * command-line toolchain.
 *
 * `isRunnableTarget` is the shared predicate the CLI's `deploy`/`dev` guard uses,
 * so the two cannot drift. `resolveTargetOrThrow` accepts a codegen-only target
 * like `node` — legitimately, since generating for it is meaningful — so without
 * this check the build would go on to emit the wrong surface silently.
 */
const resolveRunnableTargetOrThrow = (projectRoot: string, explicit?: string): string => {
    const target = resolveTargetOrThrow(projectRoot, explicit);

    if (!isRunnableTarget(target)) {
        throw new Error(
            `target "${target}" has no command-line toolchain, so the Lunora Rspack plugin cannot build for it — it can only generate for it (\`lunora codegen --target ${target}\`). Buildable targets: ${runnableTargetIds().join(", ")}`,
        );
    }

    return target;
};

const resolveOptions = (options: LunoraRspackOptions | undefined): ResolvedLunoraRspackOptions => {
    const input = options ?? {};
    const projectRoot = input.projectRoot ?? process.cwd();

    return {
        apiSpec: input.apiSpec ?? "openapi",
        projectRoot,
        schemaDir: input.schemaDir ?? "lunora",
        // Same resolution AND validation as the CLI — explicit option, then
        // `lunora.config.*`, then the default — so a project that sets `target`
        // once gets it in `rspack build` and `lunora deploy` alike, and a typo
        // fails here rather than emitting the default surface silently.
        target: resolveRunnableTargetOrThrow(projectRoot, input.target),
        validateWrangler: input.validateWrangler ?? true,
    };
};

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

// `./codegen` stays internal plumbing: `createReusableProject` returns a
// ts-morph `Project`, and exporting it would put `ts-morph` in this package's
// public `.d.ts` — a type a consumer never installs. Tests import it directly.
export type { CodegenLogger, CodegenPass } from "./codegen";
export type { AsyncTapHook, CompilationLike, CompilerLike, DependencySet } from "./compiler";
export { LunoraRspackPlugin, PLUGIN_NAME } from "./plugin";
export type { LunoraRspackOptions, ResolvedLunoraRspackOptions } from "./types";
export { lunoraRspack, resolveOptions, resolveRunnableTargetOrThrow, VERSION };
