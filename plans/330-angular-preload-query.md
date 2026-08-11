# Plan 330 — Let Angular produce the preloaded query it can already consume

**Baseline:** `70b7451b5` (2026-08-11)
**Status:** TODO

> **Executor instructions**: follow this file top to bottom, run every verification
> command, stop on any §8 STOP condition, and update this plan's row in
> `plans/README.md` when done.
>
> **Drift check (run first):**
> `git diff --stat 70b7451b5..HEAD -- packages/angular packages/solid/src/server.ts`
>
> **Build before you measure:** `pnpm run build:packages` once.

## 0. Headline finding

`@lunora/angular` ships `hydratePreloaded`, which takes a `Preloaded<T>` produced on
the server — and there is no supported way for an Angular app to produce one. Every
other adapter exports the other half: `packages/react/src/server.ts`,
`packages/vue/src/server.ts`, `packages/solid/src/server.ts`,
`packages/svelte/src/server.ts` all export `preloadQuery`, and `@lunora/nuxt` and
`@lunora/astro` extend it to the meta-frameworks. `packages/angular/package.json`
exports only `.`, `./upload`, and `./package.json`.

The repo ships `templates/analog/` — an Angular SSR starter wired to
`@lunora/angular` — so there is a first-party consumer with a server render pass and
no supported way to feed it. Today's story is "render empty, subscribe on mount",
which is exactly the first-paint gap `preloadQuery` was added to close for the other
four.

**This is smaller than it looks.** The server half is already framework-neutral and
already implemented once, in `@lunora/client/ssr`. `packages/solid/src/server.ts` is a
pure re-export — two lines of exports and a docblock. Angular's is the same shape.

## 1. Current state (audit)

`packages/solid/src/server.ts` in full — the entire template for this plan:

```ts
/**
 * Server-side data-loading helpers for the Solid adapter — re-exported from
 * `@lunora/client/ssr`, the framework-neutral server contract (one implementation
 * shared across every adapter, not re-declared here).
 *
 * Opens no WebSocket and touches no browser globals, so it is safe to import
 * from a SolidStart `"use server"` route loader: build a request-scoped client
 * with `createServerClient`, run `preloadQuery`, then hand the serializable
 * `Preloaded` token to `hydratePreloaded` on the client.
 */
export type { ArgsOf, AuthLike, FunctionReference, HeadersSource, Preloaded, ReturnOf, ServerClientOptions, ServerSession } from "@lunora/client/ssr";
export { createServerClient, deserializePreloaded, getServerSession, preloadedQueryResult, preloadQuery, serializePreloaded } from "@lunora/client/ssr";
```

`packages/angular/src/hydrate-preloaded.ts:1-30` — the consumer that exists, typed
against `Preloaded` from `@lunora/client`, and marked `@experimental` in its
docstrings.

`packages/angular/package.json:37-46` — the exports map, with no `./server`.

`plans/README.md:460` records Angular parity extras as deliberately deferred at plan 109. This plan names the one whose absence became user-visible when the Analog
template shipped.

## 2. Existing seams (do not reinvent)

- **`@lunora/client/ssr`** — the framework-neutral server contract. The implementation
  already exists; nothing new is written.
- **`packages/solid/src/server.ts`** — copy it. Change the docblock's framework
  references (SolidStart → Analog/Angular SSR) and nothing else, unless the export list
  genuinely differs.
- **`packages/solid/package.json`'s `./server` exports entry** — copy the shape,
  including whatever the build (`packem`) needs to emit a second entry point. Check
  whether `packem` discovers entries from the exports map or from a config file in
  `packages/solid/` before assuming.
- **`packages/angular/src/hydrate-preloaded.ts`** — the consumer whose types must line
  up. Angular has no TanStack cache to seed, so there is no cache-priming half; this is
  the simpler of the two sides.

## 3. The behavioural contract to preserve

1. `@lunora/angular/server` must open **no WebSocket** and touch **no browser
   globals** — it is imported into a server render pass. That property comes free from
   re-exporting `@lunora/client/ssr`, and it is why re-declaring anything locally would
   be a mistake.
2. The `Preloaded` token produced on the server must be the same serializable shape
   `hydratePreloaded` already accepts. Since both sides come from `@lunora/client`,
   this holds by construction — assert it once in a test anyway.
3. `@lunora/angular`'s existing exports do not change.
4. The package's surface is marked `@experimental` throughout; the new entry point must
   carry the same marking.

## 4. Design decisions

**Chosen: a pure re-export, matching Solid.** Rejected: an Angular-flavoured wrapper
(an injectable service, a `TransferState` integration). That is a second design on top
of a framework-neutral contract, and it is exactly the kind of adapter-local
divergence the four existing `server.ts` files were kept identical to avoid. If Analog
users later want `TransferState` sugar, that is a follow-up with real usage behind it —
recorded in §9.

**Chosen: ship the subpath even though `@lunora/angular` sits outside all three API
snapshot tiers.** Rejected: adding it to a tier as part of this plan. Tier assignment
is a roadmap decision (`scripts/check-roadmap-tiers.js` enforces agreement with
`ROADMAP.md`), and folding one into a parity fix conflates two calls. Flag it in §9.

## 5. Workstreams

### WS1 — Add the entry point (S)

- Create `packages/angular/src/server.ts` as a copy of `packages/solid/src/server.ts`,
  with the docblock rewritten for Angular/Analog. **Verify the export list against
  `@lunora/client/ssr`'s current surface** rather than trusting the copy — if Solid's
  list is stale, you would inherit the staleness.
- Add the `./server` entry to `packages/angular/package.json`'s exports map, in the
  same shape as `./upload`.
- Confirm the build emits `dist/server.mjs` and `dist/server.d.ts`. If `packem` needs
  an explicit entry declaration, copy how `packages/solid` declares it.
- Run `pnpm run lint:package-json` — key order is a CI-only gate and an exports entry
  in the wrong place passes everything else.

**Verify:** `pnpm --filter "@lunora/angular" run build` exits 0 and
`ls packages/angular/dist/server.*` shows both files.

### WS2 — Prove the round trip (S)

See §Test plan.

### WS3 — Document it (S)

- Add the Angular row wherever the other adapters' `preloadQuery` is documented (find
  it: grep `apps/docs` for `preloadQuery`). One row, matching the others.
- If `templates/analog/` has a data-loading section in its README, show the
  server-loader → `hydratePreloaded` flow there. This is the reason the gap was
  user-visible, so leaving the template unchanged leaves the gap unclosed in practice.

## 6. Platform parity

Not applicable to the capability matrix — this adds no `ctx.*` surface and no binding.
It exposes an existing framework-neutral server helper through one more adapter's
exports map. The underlying `preloadQuery` capability is already mapped for the other
adapters.

## 7. Phasing & ordering

| Phase | Work | Gate                                                                       |
| ----- | ---- | -------------------------------------------------------------------------- |
| 0     | WS1  | `@lunora/angular` builds with `dist/server.mjs`; `lint:package-json` clean |
| 1     | WS2  | round-trip test green                                                      |
| 2     | WS3  | docs build; the Angular row sits alongside the other four                  |

## Commands you will need

| Purpose            | Command                                              | Expected                      |
| ------------------ | ---------------------------------------------------- | ----------------------------- |
| Build              | `pnpm run build:packages`                            | exit 0                        |
| Angular build      | `pnpm --filter "@lunora/angular" run build`          | exit 0, emits `dist/server.*` |
| Angular tests      | `pnpm --filter "@lunora/angular" run test`           | all pass                      |
| Typecheck          | `pnpm --filter "@lunora/angular" run lint:types`     | exit 0                        |
| Manifest key order | `pnpm run lint:package-json`                         | exit 0 (CI-only)              |
| API snapshot       | `pnpm run api:check`                                 | exit 0, or a reviewed diff    |
| Format, lint       | `pnpm run lint:prettier:fix && pnpm run lint:eslint` | exit 0                        |

## Scope

**In scope:**

- `packages/angular/src/server.ts` (create)
- `packages/angular/package.json` (exports entry, and a build entry if required)
- `packages/angular/__tests__/` — one new spec
- Docs: the adapter table entry, and `templates/analog/`'s README if it documents data
  loading

**Out of scope:**

- `packages/client/src/ssr/**` — the implementation is done and shared; do not fork or
  extend it for Angular.
- The other four adapters' `server.ts` files.
- Angular-specific `TransferState` integration (§4, §9).
- API-snapshot tier assignment for `@lunora/angular` (§9).
- `packages/angular/src/hydrate-preloaded.ts` — the consumer is correct as it stands.

## Git workflow

- Branch: `advisor/330-angular-preload-query`
- Suggested commit: `feat(angular): export preloadQuery from ./server`
- This is an additive public surface on a pre-1.0 package; note it in the commit body
  so semantic-release records a feature.

## Test plan

New spec under `packages/angular/__tests__/`. Model it on whichever of the four
adapters has a `server.ts` test (check `packages/solid/__tests__` and
`packages/svelte/__tests__` first; if none exists, model on the `@lunora/client` ssr
spec).

1. **Round trip** — `createServerClient` → `preloadQuery` → `serializePreloaded` →
   `deserializePreloaded` → the token is accepted by `hydratePreloaded` and seeds its
   signal synchronously with the preloaded value.
2. **No browser globals** — importing `@lunora/angular/server` in a node environment
   with `window`/`document` undefined must not throw. This is §3.1, and it is the
   property most likely to regress if someone later "improves" the module.
3. **Export parity** — the named exports of `@lunora/angular/server` match
   `@lunora/solid/server` exactly. A tiny test, and it is what stops the five copies
   drifting the way hand-mirrored surfaces elsewhere in this repo have.

## Done criteria

- [ ] `ls packages/angular/src/server.ts` → exists; `grep -n '"./server"' packages/angular/package.json` → match
- [ ] `pnpm --filter "@lunora/angular" run build` emits `dist/server.mjs` and `dist/server.d.ts`
- [ ] `pnpm --filter "@lunora/angular" run test` exits 0 with the three new cases
- [ ] The export-parity test passes against `@lunora/solid/server`
- [ ] `pnpm run lint:package-json` exits 0
- [ ] `pnpm run api:check` exits 0, or the snapshot diff is intentional and reviewed
- [ ] `plans/README.md` row updated

## 8. Risks & STOP conditions

- **STOP** if `@lunora/client/ssr`'s exports do not line up with what
  `hydratePreloaded` expects — that would mean the two halves were never designed to
  meet for Angular, and the plan's core premise ("it's a re-export") is wrong.
- **STOP** if `packem` cannot emit a second entry point for this package without
  restructuring its build config. Angular's build already diverges from its siblings
  (`packages/auth-ui`'s vitest config records that the Angular project deliberately
  ships without a build plugin); do not restructure a build inside a parity plan.
- **Risk:** adding a published subpath to a package with no API-snapshot tier means the
  new surface is ungated. Raise it in review (§9 Q2) rather than quietly assigning a
  tier.

## 9. Open questions

1. Should Analog's `TransferState` be integrated so the preloaded value rides the
   existing SSR transfer channel instead of being threaded by hand? Real-usage question
   — record whether anyone has asked.
2. Does `@lunora/angular` want an API-snapshot tier now that it publishes a second
   entry point? Roadmap decision; name it, do not make it here.
3. Does `templates/analog/` actually wire the new loader after WS3, or only document
   it? Wiring it is the honest end state — record which was done.
