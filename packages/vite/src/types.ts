import type { Plugin } from "vite";

/** Options forwarded to `@cloudflare/vite-plugin`'s cloudflare plugin. */
export type CloudflarePluginOptions = Record<string, unknown>;

export interface CirrusPluginOptions {
    /** Pass through to `@cloudflare/vite-plugin`. Pass `false` to opt out. Defaults to `true`. */
    cloudflare?: boolean | CloudflarePluginOptions;
    /** Serve the Cirrus dashboard at `/__cirrus` during dev. Pass `false` to opt out. Defaults to `true`. */
    dashboard?: boolean;
    /** Directory name (relative to `projectRoot`) where generated files are written. Defaults to `"cirrus/_generated"`. */
    generatedDir?: string;
    /** Inject `@visulima/vite-overlay` for runtime errors (dev only). Defaults to `true`. */
    overlay?: boolean;
    /** Project root containing the `cirrus/` directory. Defaults to `process.cwd()`. */
    projectRoot?: string;
    /** Directory name (relative to `projectRoot`) containing `schema.ts` and function files. Defaults to `"cirrus"`. */
    schemaDir?: string;
    /** Validate that `wrangler.jsonc` declares the bindings the schema implies. Defaults to `true`. */
    validateWrangler?: boolean;
}

/** Resolved options after merging defaults. */
export interface ResolvedCirrusPluginOptions {
    cloudflare: false | CloudflarePluginOptions;
    dashboard: boolean;
    generatedDir: string;
    overlay: boolean;
    projectRoot: string;
    schemaDir: string;
    validateWrangler: boolean;
}

export type CirrusPlugins = ReadonlyArray<Plugin>;
