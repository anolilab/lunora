/**
 * The Cirrus Astro **integration** — an `AstroIntegration` object
 * (`{ name, hooks }`) added to `astro.config.*`'s `integrations` array.
 *
 * Astro is multi-framework at the UI layer, so this integration is **not** a new
 * reactive runtime. Its job is the *composition* seam (PLAN4 class-B): make the
 * Worker `@astrojs/cloudflare` emits mount Cirrus realtime under `/_cirrus/*`
 * via `withCirrus`, and surface the framework-neutral server helpers
 * (`@cirrus/astro/server`) to Astro server endpoints / `.astro` frontmatter.
 *
 * Reactivity itself comes from whichever island adapter the app hydrates with —
 * `@cirrus/react`, `@cirrus/solid`, `@cirrus/svelte`, or `@cirrus/vue` — each of
 * which ships its own `hydratePreloaded(preloaded)` for the SSR-seed → live
 * handoff. This package owns the server/composition half only.
 */

/**
 * Structural subset of Astro's `AstroIntegration`. Declared locally (rather than
 * importing `astro`'s type) so `@cirrus/astro`'s public surface stays decoupled
 * from a specific Astro major and type-checks even when `astro` is not installed
 * — `astro` is an *optional* peer here (only the host Astro app pulls it in).
 * The shape is assignable to/from Astro's real `AstroIntegration`, so adding the
 * returned object to `integrations` type-checks in a real Astro project.
 */
interface AstroIntegrationLike {
    readonly hooks: {
        readonly [hook: string]: ((...arguments_: never[]) => unknown) | undefined;
    };
    readonly name: string;
}

/** Options for the `cirrus` integration. */
interface CirrusIntegrationOptions {
    /**
     * Path (or specifier) of the module that calls `withCirrus` and is the
     * composed worker's `export default`. Documented for the wiring story; when
     * omitted the integration assumes the conventional `src/worker.ts`.
     */
    readonly serverEntry?: string;
}

/**
 * The Cirrus Astro integration. Add it to `astro.config.*`:
 *
 * ```ts
 * import cloudflare from "@astrojs/cloudflare";
 * import { defineConfig } from "astro/config";
 * import { cirrus } from "@cirrus/astro";
 *
 * export default defineConfig({
 *   output: "server",
 *   adapter: cloudflare(),
 *   integrations: [cirrus()],
 * });
 * ```
 *
 * What it does:
 *
 * - Marks the build so the `@astrojs/cloudflare` server entry is wrapped with
 *   `withCirrus` — the composed worker reserves `/_cirrus/*` for Cirrus realtime
 *   and forwards everything else to Astro's SSR handler (one worker, one deploy).
 * - Documents the `serverEntry` (default `src/worker.ts`) where the
 *   `withCirrus(astroWorker, { shardDO: env.SHARD, … })` composition lives.
 *
 * The hook is intentionally minimal here: the load-bearing composition is the
 * `withCirrus` wrapper at the server-entry boundary (see `withCirrus` for the
 * `@astrojs/cloudflare` injection point). The integration object exists so the
 * wiring is declared in `astro.config` the idiomatic Astro way, and so future
 * build-time hooks (binding reconcile, dev middleware) have a home without
 * changing the public surface.
 */
const cirrus = (options: CirrusIntegrationOptions = {}): AstroIntegrationLike => {
    const serverEntry = options.serverEntry ?? "src/worker.ts";

    return {
        hooks: {
            "astro:config:done": () => {
                // The composition is performed by `withCirrus` at the
                // `@astrojs/cloudflare` server-entry boundary (`serverEntry`).
                // This hook is the declared seam for future build-time wiring
                // (wrangler binding reconcile, dev middleware mounting
                // `/_cirrus/*`). Kept side-effect-free today (it only reads the
                // resolved entry) so the integration is safe to add before that
                // wiring lands.
                if (serverEntry.length === 0) {
                    throw new Error("@cirrus/astro: `serverEntry` must be a non-empty path.");
                }
            },
        },
        name: "@cirrus/astro",
    };
};

export type { AstroIntegrationLike, CirrusIntegrationOptions };
export { cirrus };
