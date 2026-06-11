/**
 * Mount Cirrus realtime *inside* the Worker `@astrojs/cloudflare` emits —
 * PLAN4's class-B (own-CF-adapter, hook-injection) composition.
 *
 * Astro owns its own Cloudflare adapter and builds its own server worker, so
 * Cirrus does **not** own the worker entry here (unlike class-A frameworks like
 * TanStack Start / SolidStart). Instead, `withCirrus` wraps the handler Astro's
 * adapter produces and returns a single composed worker. The reserved realtime
 * endpoints — `/_cirrus/rpc`, `/_cirrus/ws`, `/_cirrus/admin/*` (and any auth
 * routes / explicit `routes`) — are handled by Cirrus; everything else falls
 * through to the Astro SSR handler, so the two dispatch flows share one worker
 * but never collide. An Astro render that throws is contained at the seam and
 * surfaced as a plain 500 — it can never take down the realtime plane.
 *
 * The composition is the framework-neutral `withFrameworkWorker` from
 * `@cirrus/runtime` (one implementation shared with `@cirrus/svelte/worker` and
 * `@cirrus/vue/worker`); `withCirrus` is the Astro-named alias. It accepts Astro's
 * handler as a bare `fetch` function *or* a `{ fetch }` object, fixed options or
 * an `(env) => options` factory (for the per-request `env.SHARD` binding), and
 * preserves any `scheduled` the adapter emits when no Cirrus crons are configured.
 *
 * **Astro 6 / `@astrojs/cloudflare` v13 injection point:** the adapter no longer
 * emits a `dist/_worker.js` bundle as a custom-entry target; instead, import
 * `handle` from `@astrojs/cloudflare/handler` — the adapter's built-in SSR fetch
 * function — and wrap it at that boundary:
 *
 * ```ts
 * // src/worker.ts
 * import { handle } from "@astrojs/cloudflare/handler";
 * import { withCirrus } from "@cirrus/astro";
 *
 * // `shardDO` lives on `env` (per request), so pass a factory:
 * export default withCirrus(
 *   (req, env, ctx) => handle(req, env, ctx),
 *   (env) => ({ shardDO: env.SHARD }),
 * );
 * ```
 *
 * Set `"main": "src/worker.ts"` in `wrangler.jsonc` — wrangler bundles this file
 * (via `@cloudflare/vite-plugin` through the Astro adapter) so `handle` resolves
 * at build time. The `cirrus()` integration (from this package) declares the
 * build-time wiring so templates don't hand-roll it.
 */
export type {
    FrameworkHostHandler as AstroWorkerHandler,
    FrameworkWorkerOptions as CirrusOptions,
    CirrusWorker as ComposedWorker,
    FrameworkWorkerOptionsInput,
} from "@cirrus/runtime";
export { withFrameworkWorker as withCirrus } from "@cirrus/runtime";
