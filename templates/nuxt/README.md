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

## Single-worker composition (Class-B, PLAN4 M4)

Nuxt is a **Class-B** framework in PLAN4's integration matrix (§3): it owns its
own Cloudflare worker entry through **Nitro's `cloudflare-module` preset**, rather
than letting Cirrus own `createWorker`. So unlike the Class-A TanStack Start
template (where the worker entry calls `createWorker({ httpRouter })` directly),
Cirrus's realtime plane is **injected into the Worker Nitro emits** — Nitro keeps
owning every request, Cirrus mounts only the reserved `/_cirrus/*` endpoints
(RPC, WebSocket, admin) plus the `ShardDO`. **One Worker, one deploy.**

The seam is `@cirrus/vue`'s `withCirrus` wrapper (the Vue-free
`@cirrus/vue/worker` entry), which wraps Nitro's emitted handler as Cirrus's
fallback `httpRouter`:

- **`server/cirrus-entry.ts`** is the composed Worker entry. It imports Nitro's
  emitted handler, wraps it with `withCirrus(nitroHandler, cirrusOptions(env))`,
  and re-exports the `ShardDO` class — so the composed Worker and the DO ship
  from one module graph (no double-bundling, the central Class-B risk in PLAN4
  §5 #4). Reserved `/_cirrus/*` requests route into Cirrus; everything else falls
  through to Nitro. A Nitro SSR render that throws is isolated at the seam
  (surfaced as a 500) and can never take down realtime.
- **`cirrus/worker.ts`** builds the Cirrus options (the same shape a Class-A
  template hands `createWorker`, minus `httpRouter`) and constructs the `ShardDO`
  via `createShardDO()`.
- **`nuxt.config.ts`** uses the `cloudflare-module` preset and points
  `nitro.cloudflare.entrypoint` at `server/cirrus-entry`, so Nitro builds the
  composed entry as the Worker.
- **`wrangler.jsonc`**'s `main` points at Nitro's emitted output, and the `SHARD`
  Durable Object binding is satisfied by the `ShardDO` that entry exports.

Because Cirrus is co-located in the same Worker, the SSR loader
(`server/api/messages.get.ts`) reaches `/_cirrus/rpc` on its **own origin**
(derived from the inbound request), and the browser client connects its WebSocket
to the **same origin** as the page (`cirrusUrl: ""`). No second deploy, no
cross-origin token exchange.

> **Honest scope note.** Nuxt/Nitro's real Cloudflare build does not run inside
> the Cirrus monorepo (Nuxt is not a workspace member), so the composition files
> in this template are a **contract-level scaffold**: they show the exact wiring
> `cirrus init -t nuxt` produces in a real Nuxt app. The `#cirrus/nitro-handler`
> import in `server/cirrus-entry.ts` resolves to Nitro's emitted handler at build
> time in that app. If your Nitro version's custom-entry hook differs from
> `nitro.cloudflare.entrypoint`, apply the same `withCirrus(...)` wrap in whatever
> server-entry / `defineNitroPlugin` hook your preset exposes — the contract is
> identical (see `@cirrus/vue/worker`'s `withCirrus` JSDoc for both shapes).

## Develop

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs `cirrus dev`, which brings up the composed worker (Nuxt SSR +
Cirrus realtime under one origin) for local development.

## Build

```bash
pnpm build
```

Produces the composed Nuxt/Nitro Worker under `.output/` — one Worker that serves
both Nuxt SSR and Cirrus realtime. Deploy it with `pnpm deploy` (`cirrus deploy`).

## Stack

- `nuxt` — the Vue meta-framework (Nitro server engine)
- `@cirrus/vue` — Vue composables for Cirrus (live `useQuery`, optimistic
  `useMutation`, `hydratePreloaded`) + the `withCirrus` single-worker composition
  (`@cirrus/vue/worker`)
- `@cirrus/*` — the realtime backend on Cloudflare Workers + Durable Objects
