import { cloudflare } from "@cloudflare/vite-plugin";
import errorOverlayPlugin from "@visulima/vite-overlay";
import type { Plugin } from "vite";

import codegenPlugin from "./codegen-plugin.js";
import { dashboardPlugin } from "./dashboard-plugin.js";
import type { CirrusPluginOptions, CirrusPlugins, CloudflarePluginOptions, OverlayPluginOptions, ResolvedCirrusPluginOptions } from "./types.js";
import wranglerValidatorPlugin from "./wrangler-validator-plugin.js";

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
        cloudflare: cloudflareOption,
        dashboard: input.dashboard ?? true,
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
    const plugins: Plugin[] = [codegenPlugin(resolved)];

    if (resolved.dashboard) {
        plugins.push(dashboardPlugin());
    }

    if (resolved.validateWrangler) {
        plugins.push(wranglerValidatorPlugin(resolved));
    }

    if (resolved.overlay !== false) {
        plugins.push(errorOverlayPlugin(resolved.overlay));
    }

    if (resolved.cloudflare !== false) {
        plugins.push(...cloudflare(resolved.cloudflare));
    }

    return plugins;
};

const VERSION = "0.0.0";

export { default as codegenPlugin } from "./codegen-plugin.js";
export type { ReconcileResult } from "./cron-sync.js";
export { reconcileWranglerCrons } from "./cron-sync.js";
export { buildDashboardUrl, DASHBOARD_PATH, dashboardPlugin } from "./dashboard-plugin.js";
export type { CirrusPluginOptions, CirrusPlugins, CloudflarePluginOptions, OverlayPluginOptions, ResolvedCirrusPluginOptions } from "./types.js";
export { default as wranglerValidatorPlugin } from "./wrangler-validator-plugin.js";
export { cirrus, VERSION };
