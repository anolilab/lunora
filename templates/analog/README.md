# {{name}}

A Lunora app on **AnalogJS** (the Vite-first Angular meta-framework), scaffolded
by `lunora init`.

AnalogJS owns Angular routing + SSR; Lunora provides the real-time, type-safe
backend on Cloudflare Workers + Durable Objects. Both run in a **single
Cloudflare Worker** via Analog's Nitro `cloudflare-module` build.

## The honest caveat: no Angular adapter

Lunora ships framework adapters for React, Vue, Solid, and Svelte
(`@lunora/react|vue|solid|svelte`) — **but not Angular.** So this template does
**not** use a `useQuery`-style adapter. Instead it uses the framework-neutral
**vanilla client** `lunorash/client` (`new LunoraClient({ url })`) and a small
hand-written Angular bridge:

- **`src/app/lunora.service.ts`** — an `@Injectable` `LunoraService` that owns
  one `LunoraClient` and exposes:
    - `liveQuery(ref, args, opts)` → subscribes the query and pushes every server
      delta into an Angular **`signal`**; auto-unsubscribes on `DestroyRef`.
    - `mutate(ref, args, opts)` → runs a Lunora mutation.
- **`src/app/pages/index.page.ts`** — the demo page: it calls
  `lunora.liveQuery(api.messages.list, { channelId }, { shardKey: channelId })`
  and renders the resulting signal; the send form calls
  `lunora.mutate(api.messages.send, …)`.

This is the minimal "one component lists `messages` via a `LunoraClient`
subscription into an Angular signal" demo. Swap `LunoraService` for a real
`@lunora/angular` adapter once one ships — the component API (a `signal` + a
`mutate` call) is deliberately small so the migration is mechanical.

> **`@lunora/angular` exists today** and covers `liveQuery` / `mutate` /
> `connectionStatus`, plus a server half for SSR data loading:
> `@lunora/angular/server` (`createServerClient`, `preloadQuery`) pairs with
> `hydratePreloaded` on the client to seed a signal from an Analog server route
> with no loading flash, then hand it off to a live subscription — see
> [Reactive loaders](https://lunora.sh/docs/frameworks/reactive-loaders) and
> the [Angular framework guide](https://lunora.sh/docs/frameworks/angular).
> This template still ships the hand-rolled `LunoraService` bridge above; the
> swap to `@lunora/angular` in this template's demo page is tracked
> separately.

## Single-worker architecture (Analog + Nitro)

This template runs **everything in one worker** by mounting Lunora as an Analog
**server route** and re-exporting `ShardDO` onto Nitro's worker entry. (The Nuxt
template does the same thing through the `@lunora/nuxt` module; Analog has no
dedicated adapter package yet, so the route is inlined here.)

### 1. The `/_lunora/**` server route (in-process delegation)

`src/server/routes/_lunora/[...].ts` is an Analog/Nitro catch-all that owns
`/_lunora/**` (RPC, WebSocket, admin). It imports the project's Lunora worker
(`lunora/server.ts`, a `defineApp().build()` result) and forwards each request
**in-process**:

```ts
const { ctx, env } = resolveCloudflare(event); // reads env.SHARD off the CF runtime
const request = toWebRequest(event);
return lunoraApp.fetch(request, env, ctx);
```

No second worker, no cross-origin hop — the WebSocket loops straight back into
this same worker.

### 2. `ShardDO` on the worker entry (`worker.ts`)

The Durable Object class still has to be a named export of the deployed worker,
and Nitro's `cloudflare-module` output is a single `export default` — it
re-exports nothing else, and the preset has no hook that appends extra named
exports. So the deploy entry is a thin project-root wrapper:

```ts
// worker.ts
export { default } from "./dist/analog/server/index.mjs";
export { ShardDO } from "./lunora/server";
```

`wrangler.jsonc` points `main` at that wrapper, so one worker carries the Analog
SSR handler and `ShardDO`, and the `SHARD` binding resolves to it. (Pointing
`main` straight at `dist/analog/server/index.mjs` fails at deploy with "Your
Worker depends on the following Durable Objects, which are not exported in your
entrypoint file: ShardDO".)

> `ShardDO` is re-exported from **`lunora/server`** (the built class from
> `defineApp().build()`), not from `lunora/_generated/shard.ts` — that generated
> file exports a `createShardDO(config)` **factory**, not a bound class.

### 3. Client assets on `env.ASSETS`

Nitro's Cloudflare runtime serves the client bundle only through the `ASSETS`
binding, so `wrangler.jsonc` binds `dist/analog/public` (the preset's
`output.publicDir`). Without it the SSR HTML renders and every `/assets/*`
request 404s — no hydration, no Lunora client.

### Key files

- **`lunora/server.ts`** — the Lunora worker (`defineApp().build()`); exports
  `ShardDO`. Imported by the server route and by `worker.ts`.
- **`src/server/routes/_lunora/[...].ts`** — mounts `/_lunora/**`, delegates to
  the worker in-process.
- **`worker.ts`** — the deploy entry: re-exports Nitro's SSR handler as `default`
  plus `ShardDO`.
- **`vite.config.ts`** — `@analogjs/platform` with `nitro.preset =
"cloudflare-module"`, plus `@lunora/vite`'s `lunora()` for codegen.
- **`wrangler.jsonc`** — single worker; `main` is `worker.ts`, with the `SHARD`
  Durable Object binding + migration and the `ASSETS` binding.

## Develop

Install dependencies and start the dev server with your package manager
(`npm`, `pnpm`, `yarn`, or `bun`):

```bash
<pm> install
<pm> run dev               # vite dev server (AnalogJS)
```

> **Cloudflare bindings in dev.** `/_lunora/**` needs the Cloudflare runtime
> (`env.SHARD`). Plain `vite`/Node dev does not provide it, so the route returns
> `LUNORA_RUNTIME_UNAVAILABLE`. To exercise realtime locally, build and run the
> Nitro output under Wrangler:
>
> ```bash
> pnpm build
> wrangler dev               # serves dist/analog/server/index.mjs with the SHARD DO
> ```
>
> (or enable Nitro's Cloudflare dev runtime if your Analog/Nitro version exposes
> it). See the verification notes below.

## Build and deploy

```bash
pnpm build                   # vite build → dist/analog (client + Nitro server)
wrangler deploy              # single worker: Analog SSR + Lunora + ShardDO
# or: pnpm deploy
```

## Stack

- `@analogjs/platform` / `@analogjs/router` — the Vite-first Angular
  meta-framework (Nitro SSR, file-based routing, `cloudflare-module` preset)
- `@angular/*` 22 (standalone components, signals)
- `lunorash` — the Lunora umbrella (vanilla `lunorash/client` + `lunorash/server`)
- `@lunora/vite` — codegen for `lunora/_generated/`
- Cloudflare Workers + Durable Objects (`ShardDO`)

## What still needs on-machine verification

This template was authored without an Angular/Analog/workerd toolchain available,
so confirm the following once on a real machine:

1. **Analog version + API surface.** Pinned `@analogjs/*` `^2.6.4` /
   `@angular/*` `^22.1.1`. Bump to the current Analog/Angular release and confirm
   `provideFileRouter`, `provideClientHydration`, and `main.server.ts`'s default
   `bootstrapApplication` export still match.
2. **Build output paths.** `worker.ts` imports `./dist/analog/server/index.mjs`
   and `wrangler.jsonc` binds `dist/analog/public`. Some Nitro versions emit
   under `.output/`; if the import cannot resolve at deploy, or wrangler reads 0
   files from the assets directory, point both at what `vite build` produces.
3. **WebSocket upgrade through the Nitro route.** Confirm the `101 Switching
Protocols` upgrade (with its `webSocket`) survives Nitro's
   `toWebRequest`/response streaming on the Cloudflare runtime.
4. **Dev-time bindings.** Decide whether to recommend `wrangler dev` on the built
   output, or a Nitro Cloudflare dev runtime, for local `/_lunora/**` traffic.
