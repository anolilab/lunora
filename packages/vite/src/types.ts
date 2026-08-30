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

/* eslint-disable no-secrets/no-secrets -- false positive: a `{@link}` target in the doc block below, not a credential */

/**
 * Shard Durable Object configuration for the AUTO-COMPOSED class-A worker.
 *
 * A class-A app (TanStack Start, vinext, React Router, SolidStart) has no
 * hand-written worker entry — that is what makes it class A — so it never calls
 * the generated `defineApp()` builder and never reaches `createShardDO(config)`.
 * The composed entry emitted `createShardDO()` bare, which left `cdc` and the
 * whole reactive query cache unreachable for every class-A template no matter
 * what the app wanted. `vite.config.ts` is the one place such an app configures
 * Lunora, so it is where these land — the same route
 * {@link LunoraPluginOptions.allowUnauthenticatedShardAccess} already takes into
 * the same emitted entry.
 *
 * Deliberately only the PLAIN-DATA half of the generated `ShardDOConfig`. The
 * rest of that type is `(env) => …` factories (`scheduler`, `storage`,
 * `vectors`, …) which cannot be written in a config object and which a class-A
 * app reaches by writing its own entry instead.
 *
 * Ignored for class B/C: those pass their config to `createShardDO` directly (or
 * through `defineApp`), and an explicit argument there is unaffected by this.
 */
export interface LunoraShardConfig {
    /** Opt into change-data-capture: every write records a post-image to `__cdc_log`. Backs streaming export, replay-PITR, and shard-local `defineShape` replication. Off by default. */
    cdc?: boolean;

    /** Ceiling on the join keys one relation-crossing `where` predicate may pre-resolve via semijoin before failing closed. Omit for the engine default. */
    maxRelationKeys?: number;

    /**
     * Enable the per-shard reactive query cache: `true` for the defaults, or an
     * options object to tune the caps. Query results are memoized by
     * `(functionPath, args, identity)` and invalidated by the ctx-db write hooks
     * before the subscription broadcast, so a subscriber never observes a
     * pre-write value. Omitted (or `false`) keeps every dispatch re-running its
     * handler.
     */
    reactiveCache?: boolean | { maxBytes?: number; maxEntries?: number };

    /** Resolution policy for a relation-crossing `where` whose child is co-located in this shard: `"auto"` (cost-based, the engine default), `"always"` (inline correlated EXISTS) or `"never"` (universal semijoin). All three return identical rows. */
    relationExistsPushDown?: "always" | "auto" | "never";
}

/* eslint-enable no-secrets/no-secrets -- re-enable after the LunoraShardConfig doc block */

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

    /**
     * Shard DO configuration baked into the auto-composed class-A worker entry —
     * see {@link LunoraShardConfig}. The ONLY way a class-A app can set `cdc` or
     * enable the reactive query cache, since it has no worker entry to call
     * `createShardDO(config)` from. Ignored for class B/C. Defaults to `{}`
     * (byte-identical composed output).
     */
    shard?: LunoraShardConfig;
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

    /**
     * Where codegen writes `_generated/*`, always `<schemaDir>/_generated`.
     *
     * NOT a user option: codegen hardcodes that path (`run-codegen` joins
     * `lunoraDirectory` with `"_generated"`), so a settable override was a no-op
     * everywhere except `frameworkComposePlugin`, which uses it as the composed
     * class-A worker's import base — where a non-default value pointed the
     * emitted imports at a directory nothing writes and broke class-A dev and
     * build. Derived, so the import base cannot disagree with the emitter.
     */
    generatedDir: string;
    overlay: false | OverlayPluginOptions;
    projectRoot: string;
    schemaDir: string;
    shard: LunoraShardConfig;
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
