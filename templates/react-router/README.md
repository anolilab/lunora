# {{name}}

A Lunora app on **React Router v7** (framework mode), scaffolded by `lunora init`.

Real-time queries flow through Lunora's WebSocket transport while React Router
drives routing and server-side rendering. The app runs as a single Cloudflare
Worker: Lunora's Vite plugin composes React Router's SSR handler with the
Lunora `/_lunora/*` RPC layer behind the `virtual:lunora/worker` entry.

## Develop

Install dependencies and start the dev server with your package manager
(`npm`, `pnpm`, `yarn`, or `bun`):

```bash
<pm> install
<pm> run dev
```

The dev server runs Vite with the `@cloudflare/vite-plugin`, so your React Router
app and the Lunora worker share the same origin on the local dev server.

## Build

```bash
pnpm build
```

`pnpm build` runs `lunora codegen` then `react-router build`, producing a
Cloudflare Worker bundle with the React Router SSR handler and the Lunora
`/_lunora/*` RPC layer composed into a single worker. Deploy with `pnpm deploy`
(which runs `react-router build && lunora deploy`).

## Type checking

```bash
pnpm typecheck
```

`react-router typegen` regenerates the route types into `.react-router/types`
(merged via `rootDirs` in `tsconfig.json`), then `tsc` type-checks the project.

## Stack

- `react-router` / `@react-router/dev` — type-safe, file-based routing + SSR (framework mode)
- `@lunora/react` — `useQuery` / `useMutation` / `useSubscription`
- `lunorash` / `@lunora/*` — the realtime backend on Cloudflare Workers + Durable Objects
