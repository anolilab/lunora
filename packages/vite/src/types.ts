import type errorOverlayPlugin from "@visulima/vite-overlay";
import type { Plugin } from "vite";

/** Options forwarded to `@cloudflare/vite-plugin`'s cloudflare plugin. */
export type CloudflarePluginOptions = Record<string, unknown>;

/**
 * Options forwarded to `@visulima/vite-overlay`'s error-overlay plugin. Derived
 * from the plugin's own factory signature so it tracks the real shape
 * (`forwardConsole`, `forwardedConsoleMethods`, `reactPluginName`,
 * `solutionFinders`, `showBallonButton`, `vuePluginName`, …).
 */
export type OverlayPluginOptions = NonNullable<Parameters<typeof errorOverlayPlugin>[0]>;

export interface CirrusPluginOptions {
    /** Pass through to `@cloudflare/vite-plugin`. Pass `false` to opt out. Defaults to `true`. */
    cloudflare?: boolean | CloudflarePluginOptions;
    /** Directory name (relative to `projectRoot`) where generated files are written. Defaults to `"cirrus/_generated"`. */
    generatedDir?: string;

    /**
     * Inject `@visulima/vite-overlay` for runtime errors (dev only). Pass
     * `false` to opt out, or an options object to forward to the overlay.
     * Defaults to `true`.
     */
    overlay?: boolean | OverlayPluginOptions;
    /** Project root containing the `cirrus/` directory. Defaults to `process.cwd()`. */
    projectRoot?: string;
    /** Directory name (relative to `projectRoot`) containing `schema.ts` and function files. Defaults to `"cirrus"`. */
    schemaDir?: string;
    /** Serve the Cirrus studio at `/__cirrus` during dev. Pass `false` to opt out. Defaults to `true`. */
    studio?: boolean;
    /** Validate that `wrangler.jsonc` declares the bindings the schema implies. Defaults to `true`. */
    validateWrangler?: boolean;
}

/** Resolved options after merging defaults. */
export interface ResolvedCirrusPluginOptions {
    cloudflare: false | CloudflarePluginOptions;
    generatedDir: string;
    overlay: false | OverlayPluginOptions;
    projectRoot: string;
    schemaDir: string;
    studio: boolean;
    validateWrangler: boolean;
}

/**
 * The plugins `cirrus()` returns. A mutable `Plugin[]` (not `ReadonlyArray`) so
 * it slots directly into Vite's `plugins` — which recursively flattens nested
 * plugin arrays — without a spread: `plugins: [cirrus()]`.
 */
export type CirrusPlugins = Plugin[];
