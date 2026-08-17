# Auth UI — Solid 2

Copy-in, user-owned Solid **2** auth screens for Lunora, on top of the base
`auth` item and @lunora/solid. Distributed the shadcn way: the code lands in your
project and you own it.

```bash
lunora add auth-ui        # auto-detects Solid 2 and pulls in the base `auth` item
```

For a project on Solid 1.x, detection picks `auth-ui-solid` instead — the same
screens written against the 1.x API. You do not choose between them by hand.

## What lands in your project

```
lunora/auth-ui/
  core/          framework-agnostic flow controllers (shared across frameworks)
  solid-v2/      Solid 2 components + a context provider
  client.ts      your better-auth client — edit this to toggle plugins
  styles.css     minimal, token-aligned CSS (no Tailwind)
```

Mount the provider from `lunora/auth-ui/solid-v2` with the `authClient` from
`lunora/auth-ui/client.ts`, import `lunora/auth-ui/styles.css` once, and pass your
router into the `nav` adapter. Everything is yours to edit; re-running
`lunora add auth-ui` 3-way merges upstream changes.

## What differs from the Solid 1.x port

The controllers under `core/` are byte-identical — that is the point of the
split. The views differ only where Solid 2 changed:

- JSX types come from `@solidjs/web`, and the project sets
  `"jsxImportSource": "@solidjs/web"`.
- `createStore` / `reconcile` come from `solid-js` (the `solid-js/store` subpath
  is gone), and setters are draft-first.
- `onMount` is `onSettled`, which returns its own teardown.
- Effects are split-phase: `createEffect(compute, apply)`.
- `<Index>` is `<For keyed={false}>`.
- A context object _is_ its provider: `<Ctx value={…}>`.
- DOM attributes are lowercase (`novalidate`), and boolean-ish ARIA attributes
  take `"true"` / `"false"` rather than a boolean.

`client.ts` builds the framework-neutral `better-auth/client` rather than
`better-auth/solid`. The Solid variant exists for a reactive `useSession` these
screens do not use, and it imports `solid-js/store` — a subpath Solid 2 removed —
so it would not resolve in a Solid 2 project at all.
