# {{name}}

A Cirrus app on **Nuxt**, scaffolded by `cirrus init`.

Real-time queries flow through Cirrus's WebSocket transport via `@cirrus/vue`'s
composables, while Nuxt owns routing and SSR. A server route resolves the data
on the server and the client hydrates it into a **live subscription** — your
loader is live.

## How the live loader works

1. `server/api/messages.get.ts` builds a request-scoped client with
   `createServerClient` and runs `preloadQuery` during SSR (forwarding the
   request cookie so the load runs as the signed-in user). It returns a
   serializable `Preloaded` token.
2. `pages/index.vue` fetches that route with `useFetch`, so the token is
   resolved server-side and embedded in the SSR payload.
3. `components/MessageFeed.vue` hands the token to `hydratePreloaded`, which
   seeds a `ref` **synchronously** (no loading flash) and then attaches a live
   WebSocket subscription that updates on every server delta.
4. `plugins/cirrus.client.ts` provides the browser `CirrusClient` to the app via
   `createCirrus`, so `useQuery` / `useMutation` / `hydratePreloaded` resolve it.

## Develop

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs `cirrus dev`, which brings up the Cirrus worker (realtime +
`/_cirrus/*`) alongside the Nuxt dev server.

## Build

```bash
pnpm build
```

Produces a Nuxt/Nitro build under `.output/`.

## Stack

- `nuxt` — the Vue meta-framework (Nitro server engine)
- `@cirrus/vue` — Vue composables for Cirrus (live `useQuery`, optimistic
  `useMutation`, `hydratePreloaded`)
- `@cirrus/*` — the realtime backend on Cloudflare Workers + Durable Objects

---

## Class-B composition (mounting Cirrus realtime under `/_cirrus/*` inside Nuxt's Nitro/CF preset) is wired in PLAN4 M4 — TODO

Nuxt is a **Class-B** framework in PLAN4's integration matrix (§3): it owns its
own Cloudflare worker entry through **Nitro's CF preset**, rather than letting
Cirrus own `createWorker`. So unlike the Class-A TanStack Start template (where
the worker entry calls `createWorker({ httpRouter })` directly), Cirrus's
realtime worker must be **injected into Nitro's emitted worker** — the framework
keeps everything else, Cirrus mounts only under `/_cirrus/*`.

**This template does NOT yet compose the two into one worker.** Today it runs the
Nuxt SSR server and the Cirrus worker side by side (the `cirrus dev` script wires
both under one origin for local dev; `cirrusWorkerUrl` / `cirrusUrl` in
`nuxt.config.ts` point the SSR loader and the browser client at the worker).

The single-worker composition lands in **PLAN4 M4** via a `withCirrus()`-style
hook-injection wrapper (mirroring how void injects framework hooks). The intended
approach:

- A `@cirrus/vite` (or a Nitro module) plugin injects the Cirrus worker
  composition into Nitro's server entry — registering the `ShardDO` Durable
  Object class and routing `/_cirrus/rpc`, `/_cirrus/ws`, and `/_cirrus/admin/*`
  to Cirrus's runtime, while Nitro handles every other request.
- `wrangler.jsonc`'s `main` is then pointed at the composed Nitro/CF output, and
  the `SHARD` binding declared here is satisfied by the injected DO class.
- This avoids double-bundling the DO classes or fighting Nitro's CF adapter — the
  central Class-B risk (PLAN4 §5 #4).

Until M4 ships, treat this template as: **Vue adapter + reactive-loader handoff,
proven against a standalone Cirrus worker.** The one-worker Nuxt deploy is the
M4 deliverable.
