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
 * The composition is the framework-neutral `withFrameworkWorker` from
 * `@cirrus/runtime` (one implementation shared with `@cirrus/svelte/worker` and
 * `@cirrus/astro`); `withCirrus` is the Nitro-named alias. It wraps Nitro's
 * `{ fetch }` handler as `composeWorker`'s `httpRouter` (so `/_cirrus/*` + auth +
 * explicit `routes` go to Cirrus and everything else falls through to Nitro), and
 * **preserves Nitro's own `scheduled`** when no Cirrus crons are configured —
 * otherwise Cirrus owns `scheduled` (crons / backup). A Nitro render that throws
 * is contained at the seam as a plain 500 and never takes down the realtime plane.
 *
 * This entry is **socket-free and Vue-free** — it touches only `Request` /
 * `Response` / `@cirrus/runtime`, never `vue` or the browser composables — so it
 * is safe to bundle into Nitro's server worker. (Mirrors how `@cirrus/vue/server`
 * is a separate, browser-global-free entry.)
 *
 * ## Nitro integration point
 *
 * The composed Worker must be the module Wrangler runs, and it must export the
 * `ShardDO` Durable Object class. A thin server entry re-exports Nitro's handler
 * wrapped in `withCirrus`, alongside the DO class:
 *
 * ```ts
 * // server-entry.ts (the worker Wrangler points `main` at)
 * import nitroHandler from "#nitro-cloudflare-handler"; // Nitro's emitted { fetch }
 * import { withCirrus } from "@cirrus/vue/worker";
 * import worker from "./cirrus/worker"; // Cirrus options + ShardDO re-export
 *
 * export { ShardDO } from "@cirrus/do";
 * export default withCirrus(nitroHandler, (env) => ({ shardDO: env.SHARD, ...worker.options }));
 * ```
 */
export type {
    CirrusWorker as ComposedWorker,
    ExecutionContextLike,
    FrameworkWorkerOptionsInput,
    FrameworkHostHandler as NitroCloudflareHandler,
    ScheduledControllerLike,
    FrameworkWorkerOptions as WithCirrusOptions,
} from "@cirrus/runtime";
export { withFrameworkWorker as withCirrus } from "@cirrus/runtime";
