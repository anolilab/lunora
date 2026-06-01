import type { Plugin } from "vite";

import { codegenPlugin } from "./codegen-plugin.js";
import { dashboardPlugin } from "./dashboard-plugin.js";
import { overlayPlugin } from "./overlay-plugin.js";
import type { CirrusPluginOptions, CloudflarePluginOptions, ResolvedCirrusPluginOptions } from "./types.js";
import { wranglerValidatorPlugin } from "./wrangler-validator-plugin.js";

export { codegenPlugin } from "./codegen-plugin.js";
export { buildDashboardUrl, DASHBOARD_PATH, dashboardPlugin } from "./dashboard-plugin.js";
export { overlayPlugin } from "./overlay-plugin.js";
export type { CirrusPluginOptions, CirrusPlugins, CloudflarePluginOptions, ResolvedCirrusPluginOptions } from "./types.js";
export { wranglerValidatorPlugin } from "./wrangler-validator-plugin.js";

const resolveOptions = (options: CirrusPluginOptions | undefined): ResolvedCirrusPluginOptions => {
    const opts = options ?? {};
    const schemaDir = opts.schemaDir ?? "cirrus";
    let cloudflare: false | CloudflarePluginOptions;

    if (opts.cloudflare === false) {
        cloudflare = false;
    } else if (opts.cloudflare === true || opts.cloudflare === undefined) {
        cloudflare = {};
    } else {
        cloudflare = opts.cloudflare;
    }

    return {
        cloudflare,
        dashboard: opts.dashboard ?? true,
        generatedDir: opts.generatedDir ?? `${schemaDir}/_generated`,
        overlay: opts.overlay ?? true,
        projectRoot: opts.projectRoot ?? process.cwd(),
        schemaDir,
        validateWrangler: opts.validateWrangler ?? true,
    };
};

/**
 * Cirrus Vite plugin. Returns a flat array of Vite plugins that:
 *
 * 1. Run `@cirrus/codegen` on startup + on schema file changes.
 * 2. Validate the project's `wrangler.jsonc` against the schema's implied bindings.
 * 3. Inject `@visulima/vite-overlay` (when installed) for runtime error overlays.
 * 4. Include `@cloudflare/vite-plugin` so users get one-import setup.
 */
export const cirrus = async (options?: CirrusPluginOptions): Promise<ReadonlyArray<Plugin>> => {
    const resolved = resolveOptions(options);
    const plugins: Plugin[] = [];

    plugins.push(codegenPlugin(resolved));

    if (resolved.dashboard) {
        plugins.push(dashboardPlugin());
    }

    if (resolved.validateWrangler) {
        plugins.push(wranglerValidatorPlugin(resolved));
    }

    if (resolved.overlay) {
        const overlay = await overlayPlugin();

        if (Array.isArray(overlay)) {
            plugins.push(...(overlay as ReadonlyArray<Plugin>));
        } else {
            plugins.push(overlay as Plugin);
        }
    }

    if (resolved.cloudflare !== false) {
        try {
            const cloudflareModule = (await import("@cloudflare/vite-plugin")) as {
                cloudflare?: (options?: CloudflarePluginOptions) => Plugin | ReadonlyArray<Plugin>;
                default?: (options?: CloudflarePluginOptions) => Plugin | ReadonlyArray<Plugin>;
            };

            const factory = cloudflareModule.cloudflare ?? cloudflareModule.default;

            if (typeof factory === "function") {
                const result = factory(resolved.cloudflare);

                if (Array.isArray(result)) {
                    plugins.push(...(result as ReadonlyArray<Plugin>));
                } else {
                    plugins.push(result as Plugin);
                }
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);

            // eslint-disable-next-line no-console
            console.warn(`[cirrus] @cloudflare/vite-plugin could not be loaded: ${message}`);
        }
    }

    return plugins;
};

export const VERSION = "0.0.0";
