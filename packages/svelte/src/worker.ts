/**
 * Single-worker composition for SvelteKit (PLAN4 §3, class-B — "own CF adapter,
 * hook-injection").
 *
 * SvelteKit owns its Cloudflare build (`@sveltejs/adapter-cloudflare` emits the
 * Worker entry), so — unlike a class-A framework — Cirrus cannot own the Worker
 * entry. Instead we *inject* Cirrus's realtime plane into the very Worker
 * SvelteKit emits: the SvelteKit handler is wrapped as the
 * {@link import("@cirrus/runtime").HttpRouterLike `httpRouter`} of
 * {@link import("@cirrus/runtime").composeWorker `composeWorker`}, so the
 * reserved realtime endpoints (`/_cirrus/rpc`, `/_cirrus/ws`, `/_cirrus/admin/*`)
 * hit Cirrus and everything else delegates to SvelteKit. One Worker, one deploy,
 * the two flows never collide.
 *
 * This entry is **socket-free** and touches no browser globals — it runs on the
 * Worker, mirroring how `@cirrus/svelte/server` is set up. Keep your client-side
 * stores in the default `@cirrus/svelte` import; this `@cirrus/svelte/worker`
 * import belongs only in the Worker entry.
 *
 * ## SvelteKit integration point
 *
 * `@sveltejs/adapter-cloudflare` builds a Worker whose default export is a
 * `{ fetch }` handler that drives SvelteKit's SSR + endpoints. Wrap that handler
 * with `withCirrus` and re-export the result as your Worker's default export.
 * With `adapter-cloudflare`'s `config.platformProxy` / custom-entry model:
 *
 * ```ts
 * // src/worker.ts (your CF Worker entry — see svelte.config.js `adapter({ ... })`)
 * import { withCirrus } from "@cirrus/svelte/worker";
 * import svelteKitWorker from "../.svelte-kit/cloudflare/_worker.js"; // adapter output
 * import { auth } from "./cirrus/auth";
 *
 * export default withCirrus(svelteKitWorker, {
 *   shardDO: undefined as never, // bound at runtime: env.SHARD (see below)
 *   auth,
 * });
 * ```
 *
 * Because `shardDO` and other bindings live on `env` (only available per
 * request), pass a factory instead when you need `env`:
 *
 * ```ts
 * export default withCirrus(svelteKitWorker, (env) => ({
 *   shardDO: env.SHARD,
 *   auth,
 * }));
 * ```
 *
 * The `ShardDO` class itself is exported from your Cirrus schema worker and
 * declared in `wrangler.jsonc` so a single Worker bundles both planes.
 */
import type { ExecutionContextLike, HttpRouterLike, WorkerOptions } from "@cirrus/runtime";
import { composeWorker } from "@cirrus/runtime";

/**
 * The Cirrus options accepted by {@link withCirrus} — exactly
 * {@link import("@cirrus/runtime").WorkerOptions}, minus `httpRouter` (which
 * `withCirrus` supplies for you by wrapping the SvelteKit handler).
 */
type CirrusWorkerOptions = Omit<WorkerOptions, "httpRouter">;

/**
 * Either a fixed {@link CirrusWorkerOptions} object, or a factory that derives
 * one from the per-request `env` (so bindings like `env.SHARD` that only exist
 * at request time can be wired in).
 */
type CirrusWorkerOptionsInput = CirrusWorkerOptions | ((env: unknown) => CirrusWorkerOptions);

/**
 * The Worker handler `@sveltejs/adapter-cloudflare` emits — structurally an
 * {@link HttpRouterLike} (`{ fetch(request, env?, ctx?) }`). It may also carry a
 * `scheduled` hook; we don't depend on it, but keep the type open so the real
 * adapter output assigns.
 */
interface SvelteKitWorker {
    // A method signature (not an arrow property) so params compare bivariantly —
    // the real adapter `fetch` is typed against SvelteKit's own env/ctx and must
    // assign structurally here.
    // eslint-disable-next-line @typescript-eslint/method-signature-style -- bivariant params for adapter compatibility
    fetch(request: Request, env?: unknown, context?: ExecutionContextLike): Promise<Response> | Response;
}

/**
 * Compose a SvelteKit Cloudflare Worker handler with Cirrus's realtime plane
 * into a single `{ fetch, scheduled }` Worker.
 *
 * The returned Worker dispatches Cirrus's reserved `/_cirrus/*` endpoints to
 * Cirrus and delegates **everything else** — pages, SvelteKit endpoints, the
 * `+page.ts` loaders that call Cirrus same-origin — to `svelteKitWorker`. A
 * SvelteKit render that throws is contained at the seam and surfaced as a plain
 * 500; it can never take down `/_cirrus/*` (see `composeWorker`'s error
 * isolation contract).
 * @param svelteKitWorker The `{ fetch }` handler from `@sveltejs/adapter-cloudflare`.
 * @param options Cirrus options (everything except `httpRouter`), or a factory
 * `(env) => options` for bindings that are only available per request.
 */
const withCirrus = (
    svelteKitWorker: SvelteKitWorker,
    options: CirrusWorkerOptionsInput,
): {
    fetch: (request: Request, env: unknown, context: ExecutionContextLike) => Promise<Response>;
    scheduled: (controller: Parameters<ReturnType<typeof composeWorker>["scheduled"]>[0], env: unknown, context: ExecutionContextLike) => Promise<void>;
} => {
    // The SvelteKit handler is the lowest-priority matcher: it is the
    // `httpRouter` composeWorker falls through to once auth, explicit routes, and
    // the reserved `/_cirrus/*` endpoints have had their say.
    const httpRouter: HttpRouterLike = {
        fetch: (request, env, context) => svelteKitWorker.fetch(request, env, context),
    };

    // A static options object can build the composed worker once; a factory must
    // rebuild per request so it can read `env`. We special-case the static path
    // to avoid re-composing on every request.
    if (typeof options === "function") {
        const optionsFactory = options;

        return {
            fetch: (request, env, context) => composeWorker({ ...optionsFactory(env), httpRouter }).fetch(request, env, context),
            scheduled: (controller, env, context) => composeWorker({ ...optionsFactory(env), httpRouter }).scheduled(controller, env, context),
        };
    }

    const worker = composeWorker({ ...options, httpRouter });

    return {
        fetch: (request, env, context) => worker.fetch(request, env, context),
        scheduled: (controller, env, context) => worker.scheduled(controller, env, context),
    };
};

export type { CirrusWorkerOptions, CirrusWorkerOptionsInput, SvelteKitWorker };
export { withCirrus };
