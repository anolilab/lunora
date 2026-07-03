# {{name}}

A Lunora app on **TanStack Start (Solid)**, scaffolded by `lunora init`.

Real-time queries flow through Lunora's WebSocket transport. Solid's
fine-grained signals map directly onto Lunora's per-subscription deltas, so a
live query is just a signal the socket writes to. TanStack Router drives
navigation, and SSR is wired through `preloadQuery` + `hydratePreloaded` so the
initial paint hydrates without a fetch and then goes live with no refetch.

## Develop

Install dependencies and start the dev server with your package manager
(`npm`, `pnpm`, `yarn`, or `bun`):

```bash
<pm> install
<pm> run dev
```

The dev command runs the TanStack Start dev server alongside `wrangler dev` so
your client and worker share the same origin.

## Build

```bash
pnpm build
```

`vite build` produces a Cloudflare Worker bundle with the TanStack Start SSR
handler and the Lunora `/_lunora/*` RPC layer composed into a single worker.
Deploy with `pnpm deploy` (which runs `lunora deploy`).

## Stack

- `@tanstack/solid-start` — full-stack Solid framework
- `@tanstack/solid-router` — type-safe file-based routing
- `@lunora/solid` — Solid adapter: `createQuery` / `createMutation` / `hydratePreloaded`
- `@lunora/*` — the realtime backend on Cloudflare Workers + Durable Objects
