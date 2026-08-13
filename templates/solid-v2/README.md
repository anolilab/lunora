# {{name}}

A Lunora app on **Solid 2.0**, scaffolded by `lunora init`.

Real-time queries flow through Lunora's WebSocket transport. Solid's
fine-grained signals map directly onto Lunora's per-subscription deltas, so a
live query is just a signal the socket writes to — `createQuery` returns an
accessor, and only the parts of the UI that read it update when a delta lands.

The Vite dev server and the Cloudflare Worker share one origin, so the browser
client needs no endpoint configuration and there is no CORS to set up.

## Develop

Install dependencies and start the dev server with your package manager
(`npm`, `pnpm`, `yarn`, or `bun`):

```bash
<pm> install
<pm> run dev
```

That serves the Solid app, the Lunora `/_lunora/*` RPC + WebSocket plane, and
Lunora Studio at [`/__lunora`](http://localhost:5173/__lunora).

## Build

```bash
<pm> run build
```

`lunora codegen` regenerates `lunora/_generated/*` from `lunora/schema.ts`, then
`vite build` produces the client bundle plus a Cloudflare Worker containing the
Lunora runtime. Deploy with `<pm> run deploy` (which runs `lunora deploy`).

## Solid 2 notes

This template targets the Solid 2.0 line, which is a breaking release. If you
are porting code — or prompting a code generator — from Solid 1.x, these are the
changes that bite first:

| Solid 1.x                  | Solid 2.0                                   |
| -------------------------- | ------------------------------------------- |
| `solid-js/web`             | `@solidjs/web` (and `jsxImportSource`)      |
| `solid-js/store`           | `solid-js` (stores moved into core)         |
| `onMount`                  | `onSettled` (returns its own cleanup)       |
| `createEffect(fn)`         | `createEffect(compute, apply)` — two args   |
| `on(source, fn)`           | the two-argument `createEffect`             |
| `<Suspense>` / `<Index>`   | `<Loading>` / `<For keyed={false}>`         |
| `<ErrorBoundary>`          | `<Errored>`                                 |
| `createResource`           | async computations under `<Loading>`        |
| `batch`                    | automatic; `flush()` to apply synchronously |
| `classList={{ … }}`        | `class={{ … }}`                             |
| `<Ctx.Provider value={…}>` | `<Ctx value={…}>` — the context IS provider |

Two behaviour changes have no syntactic tell, so they are worth knowing up
front: **signal reads do not update until the microtask flushes** (call
`flush()` when a test asserts right after a write), and **writing a signal from
a component body throws in dev** — writes belong in event handlers or
`onSettled`.

`solid-js` ships a `CHEATSHEET.md` in its package with the full list.

### One thing that is not ported yet

`lunora add auth-ui` has **no Solid 2 payload**. The copy-in auth screens are
Solid 1.x source, and since you own those files once they are copied, the CLI
refuses rather than handing you code that does not compile. Everything else
works: `lunora add auth` installs the server half, and `@lunora/solid` supports
both Solid majors, so you can build the screens against the same better-auth
client. Every other `lunora add` feature is framework-agnostic and unaffected.

## Stack

- `solid-js` 2.0 + `@solidjs/web` — fine-grained reactivity and the DOM renderer
- `@lunora/solid` — `createQuery` / `createMutation` / `LunoraProvider`
- `@lunora/vite` — codegen, wrangler validation, Studio, single-origin dev
- `@lunora/*` — the realtime backend on Cloudflare Workers + Durable Objects
