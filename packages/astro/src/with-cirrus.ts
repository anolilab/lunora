import type { ExecutionContextLike, HttpRouterLike, ScheduledControllerLike, WorkerOptions } from "@cirrus/runtime";
import { composeWorker } from "@cirrus/runtime";

/**
 * The worker `@astrojs/cloudflare` emits. Its default export is a module worker
 * whose `fetch(request, env, ctx)` renders Astro's SSR output. Structurally it
 * is an {@link HttpRouterLike} — `{ fetch(request, env?, ctx?) }` — which is
 * exactly the seam `composeWorker` consults for non-reserved paths.
 *
 * We accept the broader `HttpRouterLike` shape (params compared bivariantly) so
 * any of Astro's adapter output shapes — a bare function or a `{ fetch }`
 * object — assigns here without a cast.
 */
type AstroWorkerHandler = HttpRouterLike | ((request: Request, env?: unknown, context?: ExecutionContextLike) => Promise<Response> | Response);

/**
 * Cirrus realtime options for `withCirrus` — every {@link WorkerOptions} field
 * other than `httpRouter`, which `withCirrus` fills in from the wrapped Astro
 * handler. `shardDO` (the `ShardDO` namespace binding, typically `env.SHARD`) is
 * the one required field; everything else (`auth`, `routes`, `resolveIdentity`,
 * observability, admin/studio wiring, …) is optional and forwarded verbatim.
 */
type CirrusOptions = Omit<WorkerOptions, "httpRouter">;

/**
 * The composed single Cloudflare Worker — the same `{ fetch, scheduled }` shape
 * `composeWorker` / `createWorker` return, so it drops straight into an Astro
 * Cloudflare server entry's `export default`.
 */
interface ComposedWorker {
    fetch: (request: Request, env: unknown, context: ExecutionContextLike) => Promise<Response>;
    scheduled: (controller: ScheduledControllerLike, env: unknown, context: ExecutionContextLike) => Promise<void>;
}

/**
 * Normalise an Astro worker handler (a bare `fetch` function *or* a `{ fetch }`
 * object) into the `{ fetch }` shape `composeWorker` consumes.
 */
const toHttpRouter = (handler: AstroWorkerHandler): HttpRouterLike => {
    if (typeof handler === "function") {
        return { fetch: handler };
    }

    return handler;
};

/**
 * Mount Cirrus realtime *inside* the Worker `@astrojs/cloudflare` emits —
 * PLAN4's class-B (own-CF-adapter, hook-injection) composition.
 *
 * Astro owns its own Cloudflare adapter and builds its own server worker, so
 * Cirrus does **not** own the worker entry here (unlike class-A frameworks like
 * TanStack Start / SolidStart). Instead, `withCirrus` wraps the handler Astro's
 * adapter produces and returns a single composed worker. The reserved realtime
 * endpoints — `/_cirrus/rpc`, `/_cirrus/ws`, `/_cirrus/admin/*` (and any auth
 * routes / explicit `routes`) — are handled by Cirrus. Everything else falls
 * through to the Astro SSR handler, so the two dispatch flows share one worker
 * but never collide: pages/endpoints go to Astro; queries/mutations/
 * subscriptions go to `/_cirrus/*`. An Astro render that throws is contained at
 * the `httpRouter` seam (see `dispatchHttpRoute` in `@cirrus/runtime`) and
 * surfaced as a plain 500 — it can never take down the realtime plane.
 *
 * The `@astrojs/cloudflare` injection point: Astro's Cloudflare adapter emits a
 * server entry (`dist/_worker.js/index.js`) whose default export is the SSR
 * worker. Wrap it at that boundary, reading `shardDO` from `env` per request:
 *
 * ```ts
 * // src/worker.ts
 * import astroWorker from "../dist/_worker.js/index.js";
 * import { withCirrus } from "@cirrus/astro";
 *
 * export default {
 *   fetch: (request, env, ctx) =>
 *     withCirrus(astroWorker, { shardDO: env.SHARD }).fetch(request, env, ctx),
 * };
 * ```
 *
 * Because the `ShardDO` binding lives on `env` (not at module scope), the
 * realtime options are resolved per request inside the `fetch` closure. The
 * Cirrus integration (`cirrus()` from this package) declares the build-time
 * wiring (binding reconcile) so templates don't hand-roll it.
 * @param astroHandler The worker handler `@astrojs/cloudflare` emits.
 * @param options Cirrus realtime options (`CirrusOptions`); `shardDO` is required.
 * @returns The composed `{ fetch, scheduled }` worker for Astro's `export default`.
 */
const withCirrus = (astroHandler: AstroWorkerHandler, options: CirrusOptions): ComposedWorker =>
    composeWorker({
        ...options,
        httpRouter: toHttpRouter(astroHandler),
    });

export type { AstroWorkerHandler, CirrusOptions, ComposedWorker };
export { withCirrus };
