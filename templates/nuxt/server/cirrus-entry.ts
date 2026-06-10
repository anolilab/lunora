/**
 * Composed single-worker entry for Nuxt (Class-B — PLAN4 §3, M4).
 *
 * Nuxt is a Class-B framework: Nitro's `cloudflare-module` preset emits the
 * Cloudflare Worker, so Cirrus does NOT own `createWorker`. Instead this entry
 * wraps Nitro's emitted handler with `withCirrus`, which mounts the Cirrus
 * realtime plane under the reserved `/_cirrus/*` paths (RPC, WS, admin) and lets
 * Nitro keep owning every other request (pages, API routes, SSR). The result is
 * ONE Worker, ONE deploy.
 *
 * ── How to make this the Worker Wrangler runs ──────────────────────────────
 *
 * Nitro's `cloudflare-module` preset lets you supply a custom server entry that
 * wraps its handler. Point `nitro.cloudflare.entrypoint` (or, depending on your
 * Nitro version, the preset's `entry` override) at this file, then set
 * `wrangler.jsonc`'s `main` to the emitted output. Nitro exposes its built
 * handler to a custom entry via the virtual module below.
 *
 * If your Nitro/CF preset instead exposes a `defineNitroPlugin`-style
 * server-entry hook, apply the same `withCirrus(nitroHandler, cirrusOptions(env))`
 * wrap there — the contract is identical (see `@cirrus/vue/worker`'s `withCirrus`
 * JSDoc for both shapes).
 *
 * NOTE (honesty): Nuxt/Nitro's real Cloudflare build does not run inside the
 * Cirrus monorepo (Nuxt is not a workspace member), so this file is a
 * CONTRACT-LEVEL scaffold — it shows the exact wiring `cirrus init -t nuxt`
 * produces in a real Nuxt app. The `#cirrus/nitro-handler` specifier resolves to
 * Nitro's emitted handler in that app; the `@ts-expect-error` below documents
 * that it is a build-time virtual, not a package on disk here.
 */
// @ts-expect-error -- virtual module: Nitro's emitted Cloudflare handler. Resolved at build time inside a real Nuxt app, not present in this template scaffold.
import nitroHandler from "#cirrus/nitro-handler";
import { withCirrus } from "@cirrus/vue/worker";

import { cirrusOptions } from "../cirrus/worker";

// Re-export the ShardDO class so Wrangler registers the Durable Object the
// `SHARD` binding in `wrangler.jsonc` points at. The composed Worker and the DO
// class ship from the SAME module graph — no double-bundling of the DO.
export { ShardDO } from "../cirrus/worker";

interface Env {
    SHARD: Parameters<typeof cirrusOptions>[0]["SHARD"];
}

/**
 * The composed Worker module. `withCirrus` wraps Nitro's `{ fetch }` as Cirrus's
 * fallback `httpRouter`: reserved `/_cirrus/*` paths route into Cirrus, every
 * other request falls through to Nitro. A Nitro SSR render that throws is
 * isolated at the seam (surfaced as a 500) and can never take down realtime.
 *
 * Built lazily per first request because `env.SHARD` is only available inside the
 * Worker invocation.
 */
let composed: ReturnType<typeof withCirrus> | null = null;

export default {
    async fetch(request: Request, env: Env, context: Parameters<ReturnType<typeof withCirrus>["fetch"]>[2]): Promise<Response> {
        composed ??= withCirrus(nitroHandler, cirrusOptions(env));

        return composed.fetch(request, env, context);
    },
};
