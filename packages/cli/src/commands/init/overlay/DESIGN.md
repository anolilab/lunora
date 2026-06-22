# `lunora init` — create-vite overlay engine

Status: **design + react foundation**. Branch: `feat/init-create-vite-overlay`.

## Goal

Stop maintaining a bespoke full template per SPA framework. Instead, fetch the
**official `create-vite` starter** for a framework and apply a small **Lunora
overlay** on top. Get `react`, `vue`, `solid`, `svelte`, `vanilla`, `preact`,
`lit`, `qwik`, … essentially for free, always current with the framework's own
conventions.

```
lunora init my-app --vite react      # create-vite react-ts + Lunora overlay
lunora init my-app --vite vue
lunora init my-app --vite solid
```

## Scope (hybrid — confirmed)

- **SPA frameworks → overlay.** Drop the bespoke `vite-react` template; pull
  `create-vite` bases and overlay. Covers react/vue/solid/svelte/vanilla/preact/lit.
- **SSR meta-frameworks stay bespoke.** `create-vite` has no SSR starters, and
  the SSR-preload wiring (TanStack Start `createServerFn` + `preloadQuery`,
  Astro, Nuxt, SvelteKit) is intricate. Keep `tanstack-start-*`, `astro`,
  `nuxt`, `sveltekit` as hand-authored templates.

## Key technical findings (validated against this repo)

1. **`@lunora/vite` does NOT bundle the framework JSX plugin.** It composes
   `@cloudflare/vite-plugin` + codegen + the error overlay (see
   `packages/vite/src/index.ts`). So the overlay must **keep create-vite's
   official `react()`/`vue()`/`solid()` plugin** and just **add `lunora()`** to
   the `plugins` array. This is _better_ than the current bespoke `vite-react`
   template (whose `vite.config.ts` has only `lunora()`, losing React Fast
   Refresh).
2. **`patchViteConfig` already does the vite.config codemod** — the `--here`
   path uses it to insert `lunora()` into an existing config. Reuse it verbatim.
3. **The `--here` machinery is 80% of the overlay.** `runInPlaceInit` already:
   detects the framework, patches the vite config, and scaffolds `lunora/`. The
   overlay = "fetch a fresh create-vite base into the target, then run the
   `--here` overlay against it, plus the few extra files create-vite doesn't
   know about (worker entry, wrangler, provider wiring, deps)."

## The overlay, file by file (React base)

Given a `create-vite` `react-ts` base already in `target/`:

| File                                     | Action     | Source                                                                                                                           |
| ---------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `lunora/schema.ts`, `lunora/messages.ts` | **add**    | canonical scaffold (identical across templates)                                                                                  |
| `src/server.ts`                          | **add**    | worker entry — `defineApp().shard(env => env.SHARD).build()`                                                                     |
| `wrangler.jsonc`                         | **add**    | `name`, `main: src/server.ts`, SHARD DO binding + migration, compat flags                                                        |
| `vite.config.ts`                         | **patch**  | `patchViteConfig` → add `lunora()` (keep `react()`)                                                                              |
| `src/main.tsx`                           | **patch**  | wrap `<App/>` in `<LunoraProvider client={new LunoraClient({url})}>`                                                             |
| `package.json`                           | **patch**  | add `lunorash`, `@lunora/react`, `@lunora/vite`, `wrangler`; stamp Lunora ranges to the CLI channel (existing `stampLunoraDeps`) |
| `tsconfig.json`                          | **patch**  | add worker types / `lunora/_generated` path if needed                                                                            |
| `.gitignore`                             | **append** | `lunora/_generated`, `.wrangler`, `.lunora`                                                                                      |

The only genuinely framework-specific pieces are **the provider codemod
(`src/main.tsx`)** and **which adapter + entry file** — captured per framework in
a registry.

## Framework adapter registry

```ts
interface FrameworkAdapter {
    /** create-vite template id, e.g. "react-ts". */
    createViteTemplate: string;
    /** The Lunora client adapter package, e.g. "@lunora/react". */
    adapter: string;
    /** The entry file create-vite generates, e.g. "src/main.tsx". */
    entry: string;
    /** Wrap the app root in the Lunora provider (the framework-specific codemod). */
    wireProvider: (entrySource: string) => string;
}
```

- **react** → `react-ts`, `@lunora/react`, `src/main.tsx`, wrap in `<LunoraProvider>`. **(implemented + tested here)**
- **vue** → `vue-ts`, `@lunora/vue`, `src/main.ts`, `app.use(lunora, { client })`. _(follow-up — validate against `@lunora/vue`)_
- **solid** → `solid`, `@lunora/solid`, `src/index.tsx`, `<LunoraProvider>`. _(follow-up)_
- **svelte** → `svelte-ts`, `@lunora/svelte`, `src/main.ts`, set context store. _(follow-up)_
- **vanilla** → `vanilla-ts`, `lunorash/client` only (no provider). _(follow-up)_

## Why react first, others as follow-ups

The provider codemod and entry conventions differ per framework and must be
validated against each `@lunora/<fw>` adapter's real API and a real
`create-vite` base (network fetch + a framework build). React is validated
against the existing, known-good `vite-react` wiring, so it anchors the engine.
Each additional adapter is **purely additive** (one registry entry + one
`wireProvider` codemod + one test fixture) — no engine changes.

## Validation strategy (no network in CI)

Overlay tests use a **local fixture** that mimics `create-vite` `react-ts`
output (passed via the existing `--from`-style seam), then assert the overlay
produced the correct Lunora wiring — exactly how the current init tests validate
templates offline. The live `create-vite` fetch is the same giget path the CLI
already uses for templates.
