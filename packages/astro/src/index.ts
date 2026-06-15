/**
 * `@lunora/astro` — the Astro integration for Lunora (PLAN4 class-B:
 * own-CF-adapter, hook-injection composition).
 *
 * Astro is multi-framework at the UI layer, so this package is **not** a new
 * reactive layer. Reactivity comes from whichever island adapter the app
 * hydrates with (`@lunora/react`, `@lunora/solid`, `@lunora/svelte`,
 * `@lunora/vue`). `@lunora/astro` owns two server-side seams instead.
 *
 * Seam 1 — single-worker composition: `withLunora` wraps the Worker
 * `@astrojs/cloudflare` emits so Lunora realtime (`/_lunora/rpc`, `/_lunora/ws`,
 * `/_lunora/admin/*` + `ShardDO`) is mounted *inside* it, while everything else
 * falls through to Astro's SSR handler — one worker, one deploy. `lunora` is the
 * matching `astro.config` integration.
 *
 * Seam 2 — reactive-loader server helpers: the framework-neutral `@lunora/client/ssr`
 * contract (`createServerClient`, `preloadQuery`, `getServerSession`,
 * `serializePreloaded`) is re-exported from `@lunora/astro/server` for use in
 * Astro server endpoints / `.astro` frontmatter. Preload a query there, then
 * hand the `Preloaded` token to your island adapter's `hydratePreloaded` for the
 * "your loaders are live" SSR-seed → live handoff.
 */
export type { AstroIntegrationLike, LunoraIntegrationOptions } from "./integration";
export { lunora } from "./integration";
export type { AstroWorkerHandler, LunoraOptions, ComposedWorker } from "./with-lunora";
export { withLunora } from "./with-lunora";
