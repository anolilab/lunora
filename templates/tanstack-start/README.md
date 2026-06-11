# {{name}}

A Cirrus app on **TanStack Start**, scaffolded by `cirrus init`.

Real-time queries flow through Cirrus's WebSocket transport while TanStack
Query owns the client cache and TanStack Router drives navigation. SSR is
wired through `preloadQuery` so initial paint hydrates without a fetch.

## Develop

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs the TanStack Start dev server alongside `wrangler dev` so
your client and worker share the same origin.

## Build

```bash
pnpm build
```

`vite build` produces a Cloudflare Worker bundle with the TanStack Start SSR
handler and the Cirrus `/_cirrus/*` RPC layer composed into a single worker.
Deploy with `pnpm deploy` (which runs `cirrus deploy`).

## Stack

- `@tanstack/react-start` — full-stack React framework
- `@tanstack/react-router` — type-safe file-based routing
- `@tanstack/react-query` — async cache (powers Cirrus's `useQuery`)
- `@cirrus/*` — the realtime backend on Cloudflare Workers + Durable Objects
