/**
 * Single-worker composition for SvelteKit (PLAN4 §3, class-B — "own CF adapter,
 * hook-injection").
 *
 * SvelteKit owns its Cloudflare build (`@sveltejs/adapter-cloudflare` emits the
 * Worker entry), so — unlike a class-A framework — Lunora cannot own the Worker
 * entry. Instead we *inject* Lunora's realtime plane into the very Worker
 * SvelteKit emits: the SvelteKit handler is wrapped as the `httpRouter` of
 * `composeWorker`, so the reserved realtime endpoints (`/_lunora/rpc`,
 * `/_lunora/ws`, `/_lunora/admin/*`) hit Lunora and everything else delegates to
 * SvelteKit. One Worker, one deploy, the two flows never collide.
 *
 * This entry is **socket-free** and touches no browser globals — it runs on the
 * Worker, mirroring how `@lunora/svelte/server` is set up. Keep your client-side
 * stores in the default `@lunora/svelte` import; this `@lunora/svelte/worker`
 * import belongs only in the Worker entry.
 *
 * The composition itself is the framework-neutral `withFrameworkWorker` from
 * `@lunora/runtime` (one implementation shared with `@lunora/vue/worker` and
 * `@lunora/astro`); `withLunora` is the SvelteKit-named alias. It accepts the
 * SvelteKit handler as a `{ fetch }` object, fixed Lunora options or an
 * `(env) => options` factory (for per-request bindings like `env.SHARD`), and
 * preserves any `scheduled` the adapter emits when no Lunora crons are configured.
 *
 * ## SvelteKit integration point
 *
 * `@sveltejs/adapter-cloudflare` builds a Worker whose default export is a
 * `{ fetch }` handler that drives SvelteKit's SSR + endpoints. Wrap that handler
 * with `withLunora` and re-export the result as your Worker's default export:
 *
 * ```ts
 * // src/worker.ts (your CF Worker entry)
 * import { withLunora } from "@lunora/svelte/worker";
 * import svelteKitWorker from "../.svelte-kit/cloudflare/_worker.js"; // adapter output
 * import { auth } from "./lunora/auth";
 *
 * // `shardDO` lives on `env` (per request), so pass a factory:
 * export default withLunora(svelteKitWorker, (env) => ({ shardDO: env.SHARD, auth }));
 * ```
 *
 * The `ShardDO` class itself is exported from your Lunora schema worker and
 * declared in `wrangler.jsonc` so a single Worker bundles both planes.
 */
export type {
    FrameworkWorkerOptions as LunoraWorkerOptions,
    FrameworkWorkerOptionsInput as LunoraWorkerOptionsInput,
    ExecutionContextLike,
    FrameworkHostHandler as SvelteKitWorker,
} from "@lunora/runtime";
export { withFrameworkWorker as withLunora } from "@lunora/runtime";
