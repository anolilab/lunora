/**
 * `@cirrus/astro` — the Astro integration for Cirrus (PLAN4 class-B:
 * own-CF-adapter, hook-injection composition).
 *
 * Astro is multi-framework at the UI layer, so this package is **not** a new
 * reactive layer. Reactivity comes from whichever island adapter the app
 * hydrates with (`@cirrus/react`, `@cirrus/solid`, `@cirrus/svelte`,
 * `@cirrus/vue`). `@cirrus/astro` owns two server-side seams instead.
 *
 * Seam 1 — single-worker composition: `withCirrus` wraps the Worker
 * `@astrojs/cloudflare` emits so Cirrus realtime (`/_cirrus/rpc`, `/_cirrus/ws`,
 * `/_cirrus/admin/*` + `ShardDO`) is mounted *inside* it, while everything else
 * falls through to Astro's SSR handler — one worker, one deploy. `cirrus` is the
 * matching `astro.config` integration.
 *
 * Seam 2 — reactive-loader server helpers: the framework-neutral `@cirrus/ssr`
 * contract (`createServerClient`, `preloadQuery`, `getServerSession`,
 * `serializePreloaded`) is re-exported from `@cirrus/astro/server` for use in
 * Astro server endpoints / `.astro` frontmatter. Preload a query there, then
 * hand the `Preloaded` token to your island adapter's `hydratePreloaded` for the
 * "your loaders are live" SSR-seed → live handoff.
 */
export type { AstroIntegrationLike, CirrusIntegrationOptions } from "./integration";
export { cirrus } from "./integration";
export type { AstroWorkerHandler, CirrusOptions, ComposedWorker } from "./with-cirrus";
export { withCirrus } from "./with-cirrus";
