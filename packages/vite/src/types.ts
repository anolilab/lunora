import type { CodegenOptions } from "@lunora/codegen";
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

export interface LunoraPluginOptions {
    /**
     * Allow a client-named NON-default shard / cross-shard fan-out WITHOUT an
     * `authorizeShard`/`authorizeFanOut` callback. The auto-composed class-A worker
     * (`virtual:lunora/worker`) default-denies such access (403 `FORBIDDEN_SHARD`);
     * set this `true` to opt into open access — only safe when every table is
     * protected by per-row RLS. A production sharded app should configure
     * `authorizeShard` instead (via a hand-written class-B worker). Defaults to `false`.
     */
    allowUnauthenticatedShardAccess?: boolean;

    /**
     * Which machine-readable API spec(s) codegen emits into `_generated/`.
     * `"openapi"` (default) writes `openapi.json` (OpenAPI 3.1; RPC + REST),
     * `"openrpc"` writes `openrpc.json` (OpenRPC 1.x; RPC-only), `"both"` writes
     * both, and `"none"` writes neither. Forwarded to `runCodegen({ apiSpec })`;
     * the value set is derived from `CodegenOptions` so it can't drift.
     */
    apiSpec?: CodegenOptions["apiSpec"];
    /** Pass through to `@cloudflare/vite-plugin`. Pass `false` to opt out. Defaults to `true`. */
    cloudflare?: boolean | CloudflarePluginOptions;
    /** Directory name (relative to `projectRoot`) where generated files are written. Defaults to `"lunora/_generated"`. */
    generatedDir?: string;

    /**
     * Inject `@visulima/vite-overlay` for runtime errors (dev only). Pass
     * `false` to opt out, or an options object to forward to the overlay.
     * Defaults to `true`.
     */
    overlay?: boolean | OverlayPluginOptions;

    /** Project root containing the `lunora/` directory. Defaults to `process.cwd()`. */
    projectRoot?: string;
    /** Directory name (relative to `projectRoot`) containing `schema.ts` and function files. Defaults to `"lunora"`. */
    schemaDir?: string;
    /** Serve the Lunora studio at `/__lunora` during dev. Pass `false` to opt out. Defaults to `true`. */
    studio?: boolean;

    /**
     * Deploy target the emitted `ctx.*` surface is tailored to. Defaults to
     * `"target"` in `lunora.json`, then `"cloudflare"` — so an existing project
     * emits byte-identical output.
     *
     * Set it here only to override the project config for one build — keeping
     * this and `lunora deploy` on the same target is what the shared resolution
     * in `@lunora/config` exists to guarantee.
     */
    target?: string;
    /** Validate that `wrangler.jsonc` declares the bindings the schema implies. Defaults to `true`. */
    validateWrangler?: boolean;
}

/** Resolved options after merging defaults. */
export interface ResolvedLunoraPluginOptions {
    allowUnauthenticatedShardAccess: boolean;
    apiSpec: NonNullable<CodegenOptions["apiSpec"]>;
    cloudflare: false | CloudflarePluginOptions;
    generatedDir: string;
    overlay: false | OverlayPluginOptions;
    projectRoot: string;
    schemaDir: string;
    studio: boolean;
    target: string;
    validateWrangler: boolean;
}

/**
 * The plugins `lunora()` returns. A mutable `Plugin[]` (not `ReadonlyArray`) so
 * it slots directly into Vite's `plugins` — which recursively flattens nested
 * plugin arrays — without a spread: `plugins: [lunora()]`.
 */
export type LunoraPlugins = Plugin[];
