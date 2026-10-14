# Auth UI — Solid

Copy-in, user-owned Solid auth screens for Lunora, on top of the base `auth`
item and @lunora/solid. Distributed the shadcn way: the code lands in your project and
you own it.

```bash
lunora add auth-ui        # auto-detects Solid and pulls in the base `auth` item
```

## What lands in your project

```
lunora/auth-ui/
  core/         framework-agnostic flow controllers (shared across frameworks)
  solid/   Solid components + a context provider
  client.ts     your better-auth client — edit this to toggle plugins
  styles.css    minimal, token-aligned CSS (no Tailwind)
```

Mount the provider from `lunora/auth-ui/solid` with the `authClient` from
`lunora/auth-ui/client.ts`, import `lunora/auth-ui/styles.css` once, and pass your
router into the `nav` adapter. Everything is yours to edit; re-running
`lunora add auth-ui` 3-way merges upstream changes.
