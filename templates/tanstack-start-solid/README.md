# {{name}}

A Cirrus app on **TanStack Start (Solid)**, scaffolded by `cirrus init`.

Real-time queries flow through Cirrus's WebSocket transport. Solid's
fine-grained signals map directly onto Cirrus's per-subscription deltas, so a
live query is just a signal the socket writes to. TanStack Router drives
navigation, and SSR is wired through `preloadQuery` + `hydratePreloaded` so the
initial paint hydrates without a fetch and then goes live with no refetch.

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

- `@tanstack/solid-start` — full-stack Solid framework
- `@tanstack/solid-router` — type-safe file-based routing
- `@cirrus/solid` — Solid adapter: `createQuery` / `createMutation` / `hydratePreloaded`
- `@cirrus/*` — the realtime backend on Cloudflare Workers + Durable Objects
