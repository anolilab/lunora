# {{name}}

A Lunora app on **TanStack Start (React) + Rsbuild**, scaffolded by `lunora init`.

Real-time queries flow through Lunora's WebSocket transport while TanStack
Query owns the client cache and TanStack Router drives navigation.

## Develop

Install dependencies and start the dev server with your package manager
(`npm`, `pnpm`, `yarn`, or `bun`):

```bash
<pm> install
<pm> run dev
```

`rsbuild dev` renders TanStack Start in the dev server and — through
`@lunora/rspack` — starts the Lunora Worker (`src/lunora.ts`) with
`wrangler dev`, proxying `/_lunora/*` (RPC and the live-query WebSocket) to it.
The browser only talks to the dev server's origin, so there is no CORS to set up.

Lunora Studio is at `/__lunora` on the dev server, the same URL as the Vite
templates. The Worker runs in its own process, so it **restarts** when you
change it rather than hot-swapping modules.

## Build & deploy

```bash
<pm> run deploy
```

`rsbuild build` writes the client to `dist/client` and the SSR handler to
`dist/server`, built for workerd. `lunora deploy` then bundles `src/worker.ts`,
which folds that handler and the Lunora `/_lunora/*` layer into a single
Cloudflare Worker, with `dist/client` as its static assets.

## Stack

- `@tanstack/react-start` — full-stack React framework, on Rsbuild
- `@tanstack/react-router` — type-safe file-based routing
- `@tanstack/react-query` — async cache (powers Lunora's `useQuery`)
- `@lunora/rspack` — codegen, wrangler validation, the Worker in dev
- `@lunora/*` — the realtime backend on Cloudflare Workers + Durable Objects
