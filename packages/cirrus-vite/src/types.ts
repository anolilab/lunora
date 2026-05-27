import type { Plugin } from "vite";

/** Options forwarded to `@cloudflare/vite-plugin`'s cloudflare plugin. */
export type CloudflarePluginOptions = Record<string, unknown>;

export interface CirrusPluginOptions {
    /** Project root containing the `cirrus/` directory. Defaults to `process.cwd()`. */
    projectRoot?: string;
    /** Directory name (relative to `projectRoot`) containing `schema.ts` and function files. Defaults to `"cirrus"`. */
    schemaDir?: string;
    /** Directory name (relative to `projectRoot`) where generated files are written. Defaults to `"cirrus/_generated"`. */
    generatedDir?: string;
    /** Validate that `wrangler.jsonc` declares the bindings the schema implies. Defaults to `true`. */
    validateWrangler?: boolean;
    /** Inject `@visulima/vite-overlay` for runtime errors (dev only). Defaults to `true`. */
    overlay?: boolean;
    /** Pass through to `@cloudflare/vite-plugin`. Pass `false` to opt out. Defaults to `true`. */
    cloudflare?: boolean | CloudflarePluginOptions;
}

/** Resolved options after merging defaults. */
export interface ResolvedCirrusPluginOptions {
    projectRoot: string;
    schemaDir: string;
    generatedDir: string;
    validateWrangler: boolean;
    overlay: boolean;
    cloudflare: false | CloudflarePluginOptions;
}

export type CirrusPlugins = ReadonlyArray<Plugin>;
