# {{name}}

A Cirrus app on **SolidStart**, scaffolded by `cirrus init`.

Your loaders are live: a SolidStart route loader preloads a Cirrus query on the
server (read-your-writes SSR), the HTML ships with the data, and on the client
`@cirrus/solid`'s `hydratePreloaded` seeds it with **no refetch and no flash**
before the same data goes live over the WebSocket.

## How it fits together

- **One worker** (`src/server.ts`): `createWorker({ httpRouter })` composes the
  SolidStart SSR handler with Cirrus realtime. Pages/SSR go to SolidStart;
  `/_cirrus/rpc`, `/_cirrus/ws`, and `/_cirrus/admin/*` go to Cirrus. They never
  collide (PLAN4 §1, class-A integration).
- **Live loader** (`src/routes/index.tsx`): a `"use server"` `query` calls
  `preloadQuery` with cookie-forwarding for same-origin session continuity; the
  component hydrates it with `hydratePreloaded` and writes with `createMutation`.
- **Provider** (`src/app.tsx`): one `CirrusClient` + `<CirrusProvider>` at the
  router root.

## Develop

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs the SolidStart dev server alongside `wrangler dev` so your client
and worker share the same origin.

## Build & deploy

```bash
pnpm build      # SolidStart build (Cloudflare module-worker preset)
pnpm deploy     # cirrus deploy
```

## Stack

- `@solidjs/start` — full-stack SolidJS meta-framework
- `@solidjs/router` — file-based routing + server loaders
- `@cirrus/solid` — `createQuery` / `createMutation` / `hydratePreloaded`
- `@cirrus/*` — the realtime backend on Cloudflare Workers + Durable Objects
