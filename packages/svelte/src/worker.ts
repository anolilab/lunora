/**
 * Single-worker composition for SvelteKit (PLAN4 §3, class-B — "own CF adapter,
 * hook-injection").
 *
 * SvelteKit owns its Cloudflare build (`@sveltejs/adapter-cloudflare` emits the
 * Worker entry), so — unlike a class-A framework — Cirrus cannot own the Worker
 * entry. Instead we *inject* Cirrus's realtime plane into the very Worker
 * SvelteKit emits: the SvelteKit handler is wrapped as the `httpRouter` of
 * `composeWorker`, so the reserved realtime endpoints (`/_cirrus/rpc`,
 * `/_cirrus/ws`, `/_cirrus/admin/*`) hit Cirrus and everything else delegates to
 * SvelteKit. One Worker, one deploy, the two flows never collide.
 *
 * This entry is **socket-free** and touches no browser globals — it runs on the
 * Worker, mirroring how `@cirrus/svelte/server` is set up. Keep your client-side
 * stores in the default `@cirrus/svelte` import; this `@cirrus/svelte/worker`
 * import belongs only in the Worker entry.
 *
 * The composition itself is the framework-neutral `withFrameworkWorker` from
 * `@cirrus/runtime` (one implementation shared with `@cirrus/vue/worker` and
 * `@cirrus/astro`); `withCirrus` is the SvelteKit-named alias. It accepts the
 * SvelteKit handler as a `{ fetch }` object, fixed Cirrus options or an
 * `(env) => options` factory (for per-request bindings like `env.SHARD`), and
 * preserves any `scheduled` the adapter emits when no Cirrus crons are configured.
 *
 * ## SvelteKit integration point
 *
 * `@sveltejs/adapter-cloudflare` builds a Worker whose default export is a
 * `{ fetch }` handler that drives SvelteKit's SSR + endpoints. Wrap that handler
 * with `withCirrus` and re-export the result as your Worker's default export:
 *
 * ```ts
 * // src/worker.ts (your CF Worker entry)
 * import { withCirrus } from "@cirrus/svelte/worker";
 * import svelteKitWorker from "../.svelte-kit/cloudflare/_worker.js"; // adapter output
 * import { auth } from "./cirrus/auth";
 *
 * // `shardDO` lives on `env` (per request), so pass a factory:
 * export default withCirrus(svelteKitWorker, (env) => ({ shardDO: env.SHARD, auth }));
 * ```
 *
 * The `ShardDO` class itself is exported from your Cirrus schema worker and
 * declared in `wrangler.jsonc` so a single Worker bundles both planes.
 */
export type {
    FrameworkWorkerOptions as CirrusWorkerOptions,
    FrameworkWorkerOptionsInput as CirrusWorkerOptionsInput,
    ExecutionContextLike,
    FrameworkHostHandler as SvelteKitWorker,
} from "@cirrus/runtime";
export { withFrameworkWorker as withCirrus } from "@cirrus/runtime";
