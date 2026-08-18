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

| Solid 1.x                   | Solid 2.0                                   |
| --------------------------- | ------------------------------------------- |
| `solid-js/web`              | `@solidjs/web` (and `jsxImportSource`)      |
| `solid-js/store`            | `solid-js` (stores moved into core)         |
| `onMount`                   | `onSettled` (returns its own cleanup)       |
| `createEffect(fn)`          | `createEffect(compute, apply)` — two args   |
| `on(source, fn)`            | the two-argument `createEffect`             |
| `<Suspense>` / `<Index>`    | `<Loading>` / `<For keyed={false}>`         |
| `<ErrorBoundary>`           | `<Errored>`                                 |
| `createResource`            | async computations under `<Loading>`        |
| `batch`                     | automatic; `flush()` to apply synchronously |
| `classList={{ … }}`         | `class={{ … }}`                             |
| `mergeProps` / `splitProps` | `merge` / `omit`                            |
| `unwrap`                    | `snapshot`                                  |
| `<Ctx.Provider value={…}>`  | `<Ctx value={…}>` — the context IS provider |

DOM attributes changed too, and these are the ones a compiler catches only
because Solid 2 typed them deliberately: **built-in attributes are lowercase**
(`novalidate`, `autocomplete`, `tabindex`, `readonly` — `prop:tabIndex` is typed
`never` so the old spelling is rejected rather than ignored), while **event
handlers stay camelCase** (`onClick`). Boolean-ish ARIA attributes take the
strings `"true"` / `"false"`, not a boolean — `aria-invalid={hasError()}` has to
become `aria-invalid={hasError() ? "true" : "false"}`.

Two behaviour changes have no syntactic tell at all, so they are worth knowing
up front: **signal reads do not update until the microtask flushes** (call
`flush()` when a test asserts right after a write), and **writing a signal from
a component body throws in dev** — writes belong in event handlers or
`onSettled`, or the signal needs `{ ownedWrite: true }`.

`solid-js` ships a `CHEATSHEET.md` in its package with the full list.

`lunora add auth-ui` follows the same split: it detects Solid 2 and copies in
the `auth-ui-solid-v2` screens, which are written against the 2.0 API above.

## Stack

- `solid-js` 2.0 + `@solidjs/web` — fine-grained reactivity and the DOM renderer
- `@lunora/solid` — `createQuery` / `createMutation` / `LunoraProvider`
- `@lunora/vite` — codegen, wrangler validation, Studio, single-origin dev
- `@lunora/*` — the realtime backend on Cloudflare Workers + Durable Objects
