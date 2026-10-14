# {{name}}

A Lunora app on **React + Rsbuild**, scaffolded by `lunora init`.

Real-time queries flow through Lunora's WebSocket transport; `@lunora/react`
exposes them as `useQuery` / `useMutation` hooks.

## Develop

Install dependencies and start the dev server with your package manager
(`npm`, `pnpm`, `yarn`, or `bun`):

```bash
<pm> install
<pm> run dev
```

`rsbuild dev` serves the React app and — through `@lunora/rspack` — starts the
Lunora Worker with `wrangler dev` and proxies `/_lunora/*` (RPC and the
live-query WebSocket) to it. The browser only talks to the dev server's origin,
so there is no endpoint to configure and no CORS to set up.

Lunora Studio is at `/__lunora` on the dev server, the same URL as the Vite
templates. The Worker runs in its own process, so it **restarts** when you
change it rather than hot-swapping modules.

## Build

```bash
<pm> run build
```

Codegen regenerates `lunora/_generated/*` from `lunora/schema.ts`, then Rsbuild
writes the SPA to `dist/`, which `wrangler.jsonc` binds as the Worker's static
assets. Deploy with `<pm> run deploy` (which builds, then runs `lunora deploy`).

## Stack

- `react` 19 + `@rsbuild/plugin-react`
- `@lunora/react` — `useQuery` / `useMutation` / `LunoraProvider`
- `@lunora/rspack` — codegen, wrangler validation, the Worker in dev
- `@lunora/*` — the realtime backend on Cloudflare Workers + Durable Objects
