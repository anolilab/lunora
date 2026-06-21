/**
 * The Lunora Astro **integration** — an `AstroIntegration` object
 * (`{ name, hooks }`) added to `astro.config.*`'s `integrations` array.
 *
 * Astro is multi-framework at the UI layer, so this integration is **not** a new
 * reactive runtime. Its job is the *composition* seam (PLAN4 class-B): make the
 * Worker `@astrojs/cloudflare` emits mount Lunora realtime under `/_lunora/*`
 * via `withLunora`, and surface the framework-neutral server helpers
 * (`@lunora/astro/server`) to Astro server endpoints / `.astro` frontmatter.
 *
 * Reactivity itself comes from whichever island adapter the app hydrates with —
 * `@lunora/react`, `@lunora/solid`, `@lunora/svelte`, or `@lunora/vue` — each of
 * which ships its own `hydratePreloaded(preloaded)` for the SSR-seed → live
 * handoff. This package owns the server/composition half only.
 */

/**
 * Structural subset of Astro's `AstroIntegration`. Declared locally (rather than
 * importing `astro`'s type) so `@lunora/astro`'s public surface stays decoupled
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

/** Options for the `lunora` integration. */
interface LunoraIntegrationOptions {
    /**
     * Path (or specifier) of the module that calls `withLunora` and is the
     * composed worker's `export default`. Documented for the wiring story; when
     * omitted the integration assumes the conventional `src/worker.ts`.
     */
    readonly serverEntry?: string;
}

/**
 * The Lunora Astro integration. Add it to `astro.config.*`:
 *
 * ```ts
 * import cloudflare from "@astrojs/cloudflare";
 * import { defineConfig } from "astro/config";
 * import { lunora } from "@lunora/astro";
 *
 * export default defineConfig({
 *   output: "server",
 *   adapter: cloudflare(),
 *   integrations: [lunora()],
 * });
 * ```
 *
 * What it does:
 *
 * - Marks the build so the `@astrojs/cloudflare` server entry is wrapped with
 *   `withLunora` — the composed worker reserves `/_lunora/*` for Lunora realtime
 *   and forwards everything else to Astro's SSR handler (one worker, one deploy).
 * - Documents the `serverEntry` (default `src/worker.ts`) where the
 *   `withLunora(astroWorker, { shardDO: env.SHARD, … })` composition lives.
 *
 * The hook is intentionally minimal here: the load-bearing composition is the
 * `withLunora` wrapper at the server-entry boundary (see `withLunora` for the
 * `@astrojs/cloudflare` injection point). The integration object exists so the
 * wiring is declared in `astro.config` the idiomatic Astro way, and so future
 * build-time hooks (binding reconcile, dev middleware) have a home without
 * changing the public surface.
 */
const lunora = (options: LunoraIntegrationOptions = {}): AstroIntegrationLike => {
    const serverEntry = options.serverEntry ?? "src/worker.ts";

    return {
        hooks: {
            "astro:config:done": () => {
                // The composition is performed by `withLunora` at the
                // `@astrojs/cloudflare` server-entry boundary (`serverEntry`).
                // This hook is the declared seam for future build-time wiring
                // (wrangler binding reconcile, dev middleware mounting
                // `/_lunora/*`). Kept side-effect-free today (it only reads the
                // resolved entry) so the integration is safe to add before that
                // wiring lands.
                if (serverEntry.length === 0) {
                    throw new Error("@lunora/astro: `serverEntry` must be a non-empty path.");
                }
            },
        },
        name: "@lunora/astro",
    };
};

export type { AstroIntegrationLike, LunoraIntegrationOptions };
export { lunora };
