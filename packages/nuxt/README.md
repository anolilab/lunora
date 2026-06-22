# @lunora/nuxt

A **Nuxt module** that runs Lunora and Nuxt as a **single Cloudflare Worker**.

Instead of Lunora owning the Cloudflare worker entry (the two-worker split), it
is mounted _inside_ Nitro: the module registers a server route at `/_lunora/**`
that forwards every Lunora RPC, WebSocket upgrade, and admin request to your
Lunora app in-process. One `wrangler.jsonc`, one deploy, a same-origin client.

## Install

```bash
npm install @lunora/nuxt
```

## Setup

```ts
// nuxt.config.ts
export default defineNuxtConfig({
    modules: ["@lunora/nuxt"],
    nitro: { preset: "cloudflare_module" },
});
```

Add `exports.cloudflare.ts` to the project root so the `ShardDO` Durable Object
class is exported from the emitted worker entry:

```ts
// exports.cloudflare.ts
export { ShardDO } from "./lunora/server";
```

`lunora/server.ts` is your built Lunora app (`defineApp().build()`) — its default
export is the worker (a `fetch` entrypoint), and it re-exports `ShardDO`. The
module aliases the `#lunora/app` virtual to it (configurable via the `lunora.appEntry`
option, default `~/lunora/server`) and serves it at the `/_lunora/**` route
(prefix configurable via `lunora.prefix`).

## Options

| Option     | Default           | Description                                               |
| ---------- | ----------------- | --------------------------------------------------------- |
| `appEntry` | `~/lunora/server` | Module specifier of the Lunora app entry (`#lunora/app`). |
| `prefix`   | `/_lunora`        | URL prefix the Lunora realtime plane is mounted at.       |

## How it works

- **The route** (`addServerHandler` at `prefix/**`): reconstructs a Web `Request`
  from the H3 event, resolves the Cloudflare `env`/`ExecutionContext` off it
  (tolerating both `event.context.cloudflare` and `event.req.runtime.cloudflare`),
  and forwards to your app's `fetch`. A missing Cloudflare runtime answers a clear 500.
- **`#lunora/app` alias**: points the route's worker import at your app entry,
  forwarded into the Nitro server bundle via `nuxt.options.alias`.
- **`ShardDO`** rides to the worker entry through your root `exports.cloudflare.ts`
  (the `cloudflare_module` preset appends its exports).

## Verify before deploy

Single-worker composition rides on two Nitro behaviours that vary across versions
— verify them on your pinned toolchain:

1. **WebSocket upgrade pass-through.** The live feed needs Nitro to return your
   Lunora app's `101 Switching Protocols` response (carrying its Cloudflare
   `webSocket`) untouched. RPC (plain JSON) works regardless; if live
   subscriptions never connect while RPC does, Nitro is normalising the upgrade
   response and `/_lunora/ws` needs a deploy-boundary handoff instead of the H3
   route return.
2. **`exports.cloudflare.ts` hook.** The `cloudflare_module` preset must append
   this file's exports onto the worker entry. If `wrangler deploy` fails with
   "ShardDO class not exported", your Nitro version may use a different hook
   (`nitro.cloudflare.additionalModules`, or a `rollupConfig` output export). The
   module `warn()`s when the file is missing but can't verify the hook fires.

## Server data-loading

`@lunora/nuxt/server` re-exports the framework-neutral SSR helpers
(`createServerClient`, `preloadQuery`, …) from `@lunora/client/ssr` for the
reactive-loader handoff. Safe to import from a Nitro server route (no WebSocket,
no browser globals).
