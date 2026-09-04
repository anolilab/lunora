/**
 * Mount Lunora realtime *inside* the Worker `@astrojs/cloudflare` emits —
 * PLAN4's class-B (own-CF-adapter, hook-injection) composition.
 *
 * Astro owns its own Cloudflare adapter and builds its own server worker, so
 * Lunora does **not** own the worker entry here (unlike class-A frameworks like
 * TanStack Start / SolidStart). Instead, `withLunora` wraps the handler Astro's
 * adapter produces and returns a single composed worker. The reserved realtime
 * endpoints — `/_lunora/rpc`, `/_lunora/ws`, `/_lunora/admin/*` (and any auth
 * routes / explicit `routes`) — are handled by Lunora; everything else falls
 * through to the Astro SSR handler, so the two dispatch flows share one worker
 * but never collide. An Astro render that throws is contained at the seam and
 * surfaced as a plain 500 — it can never take down the realtime plane.
 *
 * The composition is the framework-neutral `withFrameworkWorker` from
 * `@lunora/runtime` (the same composer codegen's `buildFrameworkWorker` uses
 * for SvelteKit); `withLunora` is the Astro-named alias. It accepts Astro's
 * handler as a bare `fetch` function *or* a `{ fetch }` object, fixed options or
 * an `(env) => options` factory (for the per-request `env.SHARD` binding), and
 * preserves any `scheduled` the adapter emits when no Lunora crons are configured.
 *
 * **Astro 6 / `@astrojs/cloudflare` v13 injection point:** the adapter no longer
 * emits a `dist/_worker.js` bundle as a custom-entry target; instead, import
 * `handle` from `@astrojs/cloudflare/handler` — the adapter's built-in SSR fetch
 * function — and wrap it at that boundary:
 *
 * ```ts
 * // src/server.ts
 * import { handle } from "@astrojs/cloudflare/handler";
 * import { withLunora } from "@lunora/astro";
 *
 * // `shardDO` lives on `env` (per request), so pass a factory:
 * export default withLunora(
 *   (req, env, ctx) => handle(req, env, ctx),
 *   (env) => ({ shardDO: env.SHARD }),
 * );
 * ```
 *
 * Set `"main": "src/server.ts"` in `wrangler.jsonc` — wrangler bundles this file
 * (via `@cloudflare/vite-plugin` through the Astro adapter) so `handle` resolves
 * at build time. Add the `lunora()` integration (from this package) to
 * `astro.config.*` to declare the composition in the idiomatic Astro place and
 * reserve a home for future build-time wiring — but the load-bearing step is
 * this `withLunora` wrapper plus `wrangler.jsonc`'s `main`; the integration does
 * not resolve `serverEntry` or emit the worker for you today.
 */
export type { FrameworkHostHandler as AstroWorkerHandler, LunoraWorker as ComposedWorker, FrameworkWorkerOptions as LunoraOptions } from "@lunora/runtime";
export { withFrameworkWorker as withLunora } from "@lunora/runtime";
