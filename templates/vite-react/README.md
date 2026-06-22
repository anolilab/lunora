# {{name}}

A realtime [Lunora](https://lunora.sh) app — Vite + React on the front, a
Cloudflare Worker + Durable Object on the back. The starter ships a live,
shared message list so you can see subscriptions working in seconds.

## Develop

```bash
pnpm install
pnpm dev
```

Open <http://localhost:5173>. Send a message, then open a second tab — the
list is stored in a Durable Object and synced to every client over a
WebSocket, so both tabs update at once.

`pnpm dev` runs everything from one process: the Vite dev server (with HMR), the
Worker, the Lunora Studio, and the codegen watcher.

## Project layout

```
lunora/
  schema.ts        your tables (defineSchema)
  messages.ts      the list query + send mutation
  _generated/      types + typed api, regenerated on save (gitignored)
src/
  main.tsx         mounts <LunoraProvider> with a LunoraClient
  App.tsx          the UI — useQuery / useMutation
  server.ts        the Worker entry (composed via defineApp)
wrangler.jsonc     Cloudflare bindings (the SHARD Durable Object)
```

## Scripts

| Command        | What it does                                             |
| -------------- | -------------------------------------------------------- |
| `pnpm dev`     | Vite + Worker + Studio + codegen watch                   |
| `pnpm build`   | Production build                                         |
| `pnpm deploy`  | Build, then deploy to Cloudflare (`vite build` + deploy) |
| `pnpm codegen` | Regenerate `lunora/_generated/`                          |

## Learn more

- Docs: <https://lunora.sh/docs>
- Add features (`auth`, `mail`, …): `lunora add <name>`
