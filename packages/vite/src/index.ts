import type { Plugin } from "vite";

import codegenPlugin from "./codegen-plugin.js";
import { dashboardPlugin } from "./dashboard-plugin.js";
import overlayPlugin from "./overlay-plugin.js";
import type { CirrusPluginOptions, CloudflarePluginOptions, ResolvedCirrusPluginOptions } from "./types.js";
import wranglerValidatorPlugin from "./wrangler-validator-plugin.js";

const resolveOptions = (options: CirrusPluginOptions | undefined): ResolvedCirrusPluginOptions => {
    const input = options ?? {};
    const schemaDirectory = input.schemaDir ?? "cirrus";
    let cloudflare: false | CloudflarePluginOptions;

    if (input.cloudflare === false) {
        cloudflare = false;
    } else if (input.cloudflare === true || input.cloudflare === undefined) {
        cloudflare = {};
    } else {
        cloudflare = input.cloudflare;
    }

    return {
        cloudflare,
        dashboard: input.dashboard ?? true,
        generatedDir: input.generatedDir ?? `${schemaDirectory}/_generated`,
        overlay: input.overlay ?? true,
        projectRoot: input.projectRoot ?? process.cwd(),
        schemaDir: schemaDirectory,
        validateWrangler: input.validateWrangler ?? true,
    };
};

/**
 * Best-effort dynamic load of `@cloudflare/vite-plugin`. Returns its plugin(s),
 * or an empty array if the package isn't installed or exports no factory — a
 * missing optional integration must never break the dev server. Extracted from
 * {@link cirrus} to keep that function's cognitive complexity within bounds.
 */
const loadCloudflarePlugins = async (cloudflareOptions: CloudflarePluginOptions): Promise<ReadonlyArray<Plugin>> => {
    try {
        const cloudflareModule = (await import("@cloudflare/vite-plugin")) as {
            cloudflare?: (options?: CloudflarePluginOptions) => Plugin | ReadonlyArray<Plugin>;
            default?: (options?: CloudflarePluginOptions) => Plugin | ReadonlyArray<Plugin>;
        };

        const factory = cloudflareModule.cloudflare ?? cloudflareModule.default;

        if (typeof factory !== "function") {
            return [];
        }

        const result = factory(cloudflareOptions);

        return Array.isArray(result) ? (result as ReadonlyArray<Plugin>) : [result as Plugin];
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        // eslint-disable-next-line no-console
        console.warn(`[cirrus] @cloudflare/vite-plugin could not be loaded: ${message}`);

        return [];
    }
};

/**
 * Cirrus Vite plugin. Returns a flat array of Vite plugins that:
 *
 * 1. Run `@cirrus/codegen` on startup + on schema file changes.
 * 2. Validate the project's `wrangler.jsonc` against the schema's implied bindings.
 * 3. Inject `@visulima/vite-overlay` (when installed) for runtime error overlays.
 * 4. Include `@cloudflare/vite-plugin` so users get one-import setup.
 */
const cirrus = async (options?: CirrusPluginOptions): Promise<ReadonlyArray<Plugin>> => {
    const resolved = resolveOptions(options);
    const plugins: Plugin[] = [codegenPlugin(resolved)];

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
        plugins.push(...(await loadCloudflarePlugins(resolved.cloudflare)));
    }

    return plugins;
};

const VERSION = "0.0.0";

export { default as codegenPlugin } from "./codegen-plugin.js";
export type { ReconcileResult } from "./cron-sync.js";
export { reconcileWranglerCrons } from "./cron-sync.js";
export { buildDashboardUrl, DASHBOARD_PATH, dashboardPlugin } from "./dashboard-plugin.js";
export { default as overlayPlugin } from "./overlay-plugin.js";
export type { CirrusPluginOptions, CirrusPlugins, CloudflarePluginOptions, ResolvedCirrusPluginOptions } from "./types.js";
export { default as wranglerValidatorPlugin } from "./wrangler-validator-plugin.js";
export { cirrus, VERSION };
