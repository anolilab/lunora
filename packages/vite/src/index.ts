import { cloudflare } from "@cloudflare/vite-plugin";
import errorOverlayPlugin from "@visulima/vite-overlay";
import type { Plugin } from "vite";

import codegenPlugin from "./codegen-plugin";
import devVariablesPlugin from "./dev-variables-plugin";
import logStreamPlugin from "./log-stream-plugin";
import { studioPlugin } from "./studio-plugin";
import type { CirrusPluginOptions, CirrusPlugins, CloudflarePluginOptions, OverlayPluginOptions, ResolvedCirrusPluginOptions } from "./types";
import { withWorkerStartupHint } from "./worker-startup-hint";
import wranglerValidatorPlugin from "./wrangler-validator-plugin";

const resolveOptions = (options: CirrusPluginOptions | undefined): ResolvedCirrusPluginOptions => {
    const input = options ?? {};
    const schemaDirectory = input.schemaDir ?? "cirrus";

    // Each integration toggle is `boolean | options`: `false` opts out, `true`
    // (or omitted) means defaults, an object forwards its options.
    let cloudflareOption: false | CloudflarePluginOptions;

    if (input.cloudflare === false) {
        cloudflareOption = false;
    } else if (input.cloudflare === true || input.cloudflare === undefined) {
        cloudflareOption = {};
    } else {
        cloudflareOption = input.cloudflare;
    }

    let overlayOption: false | OverlayPluginOptions;

    if (input.overlay === false) {
        overlayOption = false;
    } else if (input.overlay === true || input.overlay === undefined) {
        overlayOption = {};
    } else {
        overlayOption = input.overlay;
    }

    return {
        apiSpec: input.apiSpec ?? "openapi",
        cloudflare: cloudflareOption,
        studio: input.studio ?? true,
        generatedDir: input.generatedDir ?? `${schemaDirectory}/_generated`,
        overlay: overlayOption,
        projectRoot: input.projectRoot ?? process.cwd(),
        schemaDir: schemaDirectory,
        validateWrangler: input.validateWrangler ?? true,
    };
};

/**
 * Cirrus Vite plugin. Returns a flat array of Vite plugins that:
 *
 * 1. Run `@cirrus/codegen` on startup + on schema file changes.
 * 2. Validate the project's `wrangler.jsonc` against the schema's implied bindings.
 * 3. Inject `@visulima/vite-overlay` for runtime error overlays (unless `overlay: false`).
 * 4. Include `@cloudflare/vite-plugin` so users get one-import setup (unless `cloudflare: false`).
 *
 * `@cloudflare/vite-plugin` and `@visulima/vite-overlay` are direct dependencies,
 * so they're imported statically — opt out per-feature via the options rather
 * than relying on whether they're installed.
 */
const cirrus = (options?: CirrusPluginOptions): CirrusPlugins => {
    const resolved = resolveOptions(options);
    // `devVariablesPlugin` is `enforce: "pre"` + `apply: "serve"`: it offers to
    // scaffold `.dev.vars` before `@cloudflare/vite-plugin` boots the worker.
    const plugins: Plugin[] = [devVariablesPlugin(resolved), codegenPlugin(resolved), logStreamPlugin()];

    if (resolved.studio) {
        plugins.push(studioPlugin());
    }

    if (resolved.validateWrangler) {
        plugins.push(wranglerValidatorPlugin(resolved));
    }

    if (resolved.overlay !== false) {
        plugins.push(errorOverlayPlugin(resolved.overlay));
    }

    if (resolved.cloudflare !== false) {
        // Wrap the Cloudflare plugins' startup hooks so a Worker-entry evaluation
        // failure (e.g. a circular import in `cirrus/`) surfaces an actionable
        // hint instead of a bare, file-less `runner-worker` TypeError.
        plugins.push(...withWorkerStartupHint(cloudflare(resolved.cloudflare)));
    }

    return plugins;
};

const VERSION = "0.0.0";

export { default as codegenPlugin } from "./codegen-plugin";
export type { ReconcileResult } from "./cron-sync";
export { reconcileWranglerCrons } from "./cron-sync";
export { default as devVariablesPlugin } from "./dev-variables-plugin";
export { default as logStreamPlugin } from "./log-stream-plugin";
export { buildStudioUrl, STUDIO_PATH, studioPlugin } from "./studio-plugin";
export type { CirrusPluginOptions, CirrusPlugins, CloudflarePluginOptions, OverlayPluginOptions, ResolvedCirrusPluginOptions } from "./types";
export { augmentWorkerStartupError, isWorkerEntryEvalError, withWorkerStartupHint, WORKER_STARTUP_HINT } from "./worker-startup-hint";
export { default as wranglerValidatorPlugin } from "./wrangler-validator-plugin";
export { cirrus, VERSION };
