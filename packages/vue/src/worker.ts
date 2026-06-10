/**
 * `@cirrus/vue/worker` — the **Class-B single-worker composition** entry for Nuxt
 * (PLAN4 §3, M4).
 *
 * Nuxt owns its own Cloudflare output: Nitro's `cloudflare-module` /
 * `cloudflare-pages` preset emits the Worker. So unlike a Class-A framework
 * (where Cirrus calls `createWorker({ httpRouter })` and owns the entry), here we
 * inject Cirrus realtime into the Worker Nitro already emits — Cirrus mounts
 * only the reserved `/_cirrus/*` plane (RPC, WS, admin) + the `ShardDO`, and
 * Nitro keeps owning every other request.
 *
 * The seam is `@cirrus/runtime`'s {@link composeWorker} (see
 * `packages/runtime/src/create-worker.ts`): it dispatches auth (`/api/auth/*`),
 * explicit `routes`, then the reserved realtime endpoints first, and falls
 * through to `httpRouter.fetch` for everything else. {@link withCirrus} wraps the
 * Nitro handler as that `httpRouter`, so the composition is just "Nitro is the
 * fallback router."
 *
 * This entry is **socket-free and Vue-free** — it touches only `Request` /
 * `Response` / `@cirrus/runtime`, never `vue` or the browser composables — so it
 * is safe to bundle into Nitro's server worker. (Mirrors how `@cirrus/vue/server`
 * is a separate, browser-global-free entry.)
 */
import type { ExecutionContextLike, HttpRouterLike, ScheduledControllerLike, WorkerOptions } from "@cirrus/runtime";
import { composeWorker } from "@cirrus/runtime";

/**
 * The Nitro Cloudflare handler `withCirrus` wraps. Nitro's `cloudflare-module`
 * preset emits a Worker module whose default export is `{ fetch }` (and, when
 * cron triggers are configured, `scheduled`). Structurally this is exactly an
 * {@link HttpRouterLike} — `{ fetch(request, env?, ctx?) }` — which is why Nitro's
 * own output can be handed straight through as Cirrus's fallback router.
 *
 * `scheduled` is preserved verbatim: a host that wires both Nitro cron tasks and
 * Cirrus crons gets Nitro's `scheduled` unless it overrides `crons` on the Cirrus
 * options (see {@link withCirrus}).
 */
interface NitroCloudflareHandler extends HttpRouterLike {
    scheduled?: (controller: ScheduledControllerLike, env: unknown, context: ExecutionContextLike) => Promise<void> | void;
}

/**
 * Cirrus options for {@link withCirrus} — every {@link WorkerOptions} field
 * except `httpRouter`, which `withCirrus` supplies from the Nitro handler. The
 * one required field is `shardDO` (the `ShardDO` namespace binding, typically
 * `env.SHARD`); auth, routes, observability, crons, admin storage/globals, etc.
 * are all optional and forwarded verbatim to `composeWorker`.
 */
type WithCirrusOptions = Omit<WorkerOptions, "httpRouter">;

/**
 * The composed Worker module returned by {@link withCirrus}: a `fetch` that
 * routes the reserved `/_cirrus/*` realtime plane into Cirrus and everything else
 * into the wrapped Nitro handler, plus a `scheduled` for cron triggers.
 */
interface ComposedWorker {
    fetch: (request: Request, env: unknown, context: ExecutionContextLike) => Promise<Response>;
    scheduled: (controller: ScheduledControllerLike, env: unknown, context: ExecutionContextLike) => Promise<void>;
}

/**
 * Compose a Nitro Cloudflare Worker handler with Cirrus realtime into a single
 * Worker — the Class-B (own-CF-adapter, hook-injection) composition for Nuxt
 * (PLAN4 §3, M4).
 *
 * Pass Nitro's emitted handler and the Cirrus options; the returned `{ fetch,
 * scheduled }` routes the reserved realtime endpoints (`/_cirrus/rpc`,
 * `/_cirrus/ws`, `/_cirrus/admin/*`) — plus auth (`/api/auth/*`) and any explicit
 * `routes` — into Cirrus, and falls through to the Nitro handler for **every
 * other** request (pages, API routes, SSR). The two flows share one Worker but
 * never collide.
 *
 * **Error isolation is inherited from the seam:** a Nitro SSR render that throws
 * is contained where `composeWorker` calls `httpRouter.fetch` and surfaced as a
 * plain 500 — it can never take down the realtime plane. A subsequent
 * `/_cirrus/*` request on the same Worker still succeeds.
 *
 * Nitro integration point (the contract): the composed Worker must be the module
 * Wrangler runs, and it must export the `ShardDO` Durable Object class. There are
 * two equivalent injection shapes — pick whichever your Nitro/CF preset makes
 * cleanest.
 *
 * (1) The `{ fetch }`-wrapper, the canonical contract: a thin Worker module
 * re-exports the Nitro handler wrapped in `withCirrus`, alongside the DO class.
 *
 * ```ts
 * // server-entry.ts (the worker Wrangler points `main` at)
 * import nitroHandler from "#nitro-cloudflare-handler"; // Nitro's emitted { fetch }
 * import { withCirrus } from "@cirrus/vue/worker";
 * import worker from "./cirrus/worker"; // createWorker-shaped Cirrus options + ShardDO re-export
 *
 * export { ShardDO } from "@cirrus/do";
 * export default withCirrus(nitroHandler, worker.options);
 * ```
 *
 * (2) A Nitro plugin / preset hook: when the preset exposes a server-entry hook
 * (`defineNitroPlugin`-style), the same `withCirrus(nitroHandler, cirrusOptions)`
 * wrap is applied there instead of in a hand-written entry — the contract (wrap
 * Nitro's `{ fetch }`, keep `/_cirrus/*` for Cirrus) is identical; only where the
 * wrap lives changes.
 *
 * Either way the rule is the same: wrap Nitro's `{ fetch }`, mount Cirrus under
 * `/_cirrus/*`, export `ShardDO`.
 *
 * `scheduled`: by default the composed Worker forwards cron triggers to Cirrus
 * (`composeWorker`'s `scheduled`, driven by the `crons` / `backupCron` options).
 * If you instead need Nitro's own scheduled tasks, omit Cirrus `crons` and the
 * Nitro handler's `scheduled` (when present) is preserved on the returned module.
 * @param nitroHandler Nitro's emitted Cloudflare handler (`{ fetch }`, optionally
 * `{ scheduled }`).
 * @param options Cirrus worker options minus `httpRouter` (supplied from
 * `nitroHandler`). `shardDO` is required.
 * @returns A composed `{ fetch, scheduled }` Worker module.
 */
const withCirrus = (nitroHandler: NitroCloudflareHandler, options: WithCirrusOptions): ComposedWorker => {
    const cirrus = composeWorker({ ...options, httpRouter: nitroHandler });

    // Prefer Cirrus's scheduled (cron jobs / backup) when the host configured any
    // cron surface; otherwise fall back to Nitro's own scheduled tasks if it
    // emitted one. This keeps a Nitro-cron-only app working when no Cirrus crons
    // are wired, without silently dropping either side.
    const hasCirrusCrons = Boolean(options.crons ?? options.cronJobs ?? options.backupCron);

    if (!hasCirrusCrons && typeof nitroHandler.scheduled === "function") {
        return {
            fetch: cirrus.fetch,
            scheduled: async (controller, env, context): Promise<void> => {
                await nitroHandler.scheduled?.(controller, env, context);
            },
        };
    }

    return cirrus;
};

export type { ExecutionContextLike, ScheduledControllerLike } from "@cirrus/runtime";
export type { ComposedWorker, NitroCloudflareHandler, WithCirrusOptions };
export { withCirrus };
