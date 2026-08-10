# {{name}}

A Lunora app on **Next.js (Pages Router) running on Vite via [vinext]**,
scaffolded by `lunora init`.

> [!NOTE]
> **vinext is experimental.** It reimplements the Next.js API surface on Vite
> (~94% of Next 16.x) and is a Cloudflare experiment, not a 1.0. Lunora's own
> wiring is stable; the Next.js layer may have rough edges. See the
> [vinext repo][vinext] for current coverage.

Real-time queries flow through Lunora's WebSocket transport while vinext drives
the Next.js Pages Router and server-side rendering. The app runs as a single
Cloudflare Worker: Lunora's Vite plugin composes vinext's router-selected SSR
handler (`vinext/server/fetch-handler`) with the Lunora runtime behind the
`virtual:lunora/worker` entry — no hand-written worker, Lunora mounted under
`/_lunora/*`.

## Develop

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs `vinext dev` — Vite with vinext + the `@cloudflare/vite-plugin`,
so your Next.js app and the Lunora worker share one origin locally. Codegen
(`lunora/_generated/*`) runs through the `lunora()` Vite plugin.

## Build & deploy

```bash
pnpm build      # lunora codegen && vinext build
pnpm deploy     # lunora codegen && vinext build && lunora deploy
```

`vinext build` runs the Vite build, resolving `virtual:lunora/worker` into one
Cloudflare Worker bundle carrying both vinext's Pages pipeline and Lunora's
`/_lunora/*` RPC layer. `lunora deploy` ships it.

## Stack

- `vinext` — Next.js Pages Router on Vite, deployed to Cloudflare Workers
- `@lunora/react` — `useQuery` / `useMutation` / `useSubscription`
- `lunorash` / `@lunora/*` — the realtime backend on Cloudflare Workers + Durable Objects

[vinext]: https://github.com/cloudflare/vinext
