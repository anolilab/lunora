# {{name}}

A Lunora app on **TanStack Start (React)**, scaffolded by `lunora init`.

Real-time queries flow through Lunora's WebSocket transport while TanStack
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
handler and the Lunora `/_lunora/*` RPC layer composed into a single worker.
Deploy with `pnpm deploy` (which runs `lunora deploy`).

## Stack

- `@tanstack/react-start` — full-stack React framework
- `@tanstack/react-router` — type-safe file-based routing
- `@tanstack/react-query` — async cache (powers Lunora's `useQuery`)
- `@lunora/*` — the realtime backend on Cloudflare Workers + Durable Objects
