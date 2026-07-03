# Plan 114: Unified error layer — `@lunora/errors` on `@visulima/error`

> **Executor instructions**: Phases 1–4a are DONE and committed on
> `feat/unified-error-layer`. Phases 4b (Studio UI) and 3 (per-package class
> collapse) remain. Follow step by step; run each verify. Update this file's
> Status as phases land.

## Status

- **Priority**: P1
- **Effort**: L (multi-phase; big-bang)
- **Risk**: MEDIUM (touches every package)
- **Depends on**: none
- **Category**: dx
- **Planned at**: 2026-07-03

## Why this matters

Error handling was fragmented: **22 custom `Error` subclasses**, **two conflicting
`LunoraError` classes** (incompatible constructors, both relying on `name ===`
string-matching to cross the wire), and **~900 throw sites**. Actionable "how to
fix it" hints existed for **codegen errors only**. Everywhere else — client SDK,
Studio UI, general CLI — users saw a bare `error.message`; `code`/`hint`/`docsUrl`
never reached them. A **latent bug** also shipped: `NotFoundError`/`NotUniqueError`/
`RlsRequiredError` (all `@lunora/do`) advertised structural mapping but their
`name` was in **no** matcher, so on uncaught paths they redacted to a generic 500
instead of 404/400/403.

## Approach

A new internal, zero-runtime-dep package **`@lunora/errors`** built on
`@visulima/error`:

- `LunoraError extends VisulimaError` — inherits `hint`/`title`/`location`/`cause`;
  adds own-enumerable `code`/`status`/`docsUrl`/`data` (so they ride the wire codec).
- `ERROR_CATALOG` — central `code → {status, title, hint?, docsUrl?}` source of
  truth; **absorbs** the former `@lunora/codegen` solutions table.
- `isLunoraError` — one structural guard (string `code` + numeric `status`),
  realm-safe, replacing every scattered `name === "…"` matcher.
- `invariant`/`unreachable` — assertion helpers that throw an `INTERNAL` `LunoraError`.
- Browser/workerd-safe main entry (imports only `@visulima/error/error` — the
  class, never `renderError`); the Node terminal renderer lives on the separate
  `@lunora/errors/render` subpath (`renderLunoraError`). Bundle split verified: no
  `renderError`/`node:fs` reachable from the main entry.

## Phases

### Phase 1 — Foundation ✅ (commit `64164735`)

`packages/errors/*` (base, catalog, guards, invariant, render), tests (14),
`@visulima/error` → `catalog:prod`, `@lunora/errors` → pnpm `overrides`.

### Phase 2 — Reconcile core + fix the latent bug ✅ (commit `c7f2840f`)

- `@lunora/server` `LunoraError` subclasses the shared base (keeps `(code,
message?, data?)`; status/hint from the catalog).
- `@lunora/runtime` `LunoraError` subclasses it too (keeps its `(message, {code,
status})` factory for the ~157 dispatch-code sites).
- Replaced the `name`-string matchers with `isLunoraError` in `runtime/errors.ts`,
  `create-worker.ts`, `server/http.ts` — **fixes the NotFound/NotUnique/Rls gap**.
- `codegen/src/solutions.ts` → thin re-export of the shared catalog.

### Phase 4a — Wire the hint through the RPC edge ✅ (commit `558881ff`)

- `@lunora/do` `errorToResponse`: one `isLunoraError` branch resolves a hint (from
  the error or the catalog by `code`) and forwards `hint` + `docsUrl` + wire-encoded
  `data`. Un-migrated `@lunora/do` errors get catalog hints **by code**, so the
  feature works without waiting on the class collapse.
- `@lunora/client` `reconstructError` restores `hint`/`docsUrl`; `LunoraClientError`
  widened so a UI can render the fix.

### Phase 4b — CLI renderer ✅ (commit `8b6a4505`)

`reportRunError` routes a `LunoraError` (or a message-matched solution) through
`@lunora/errors/render`, so the terminal shows the hint block.

### Phase 4c — Studio UI 🟡 PARTIAL

Done: `errorHint`/`errorDocumentationUrl` helpers (`studio/src/lib/internal.ts`),
the additive `errorSource` field on `useAdminQuery`/`useClientQuery` (keeps
`error: string`), the reusable `<ErrorAlert error={…}>` component
(`components/error-alert.tsx`, message + stripped-markdown hint + docs link), and
the flags panel wired to it.
TODO (mechanical, reusable component now exists): swap the remaining ~11
per-feature `role="alert"` message sites (kv, data, storage, analytics, schema,
advisors, logs, payments) to `<ErrorAlert error={errorSource} />`, threading
`errorSource` where the panel doesn't already read the hook error.

> Verify via `pnpm --filter @lunora/studio run lint:types` + `lint:eslint` + build
> (Studio jsdom tests SIGTERM in the sandbox — see the pinned memory; do not gate
> on `run test`).

### Phase 3 — Per-package class collapse ⬜ TODO (incremental)

Collapse the remaining custom classes onto `@lunora/errors`' `LunoraError`
(subclass, fixed `name` + `code` + catalog `status`, preserve extra fields).
The RPC edge already surfaces hints **by code**, so this is consistency/ergonomics,
not a functional blocker — do it package-by-package:

- **Wire-crossing** (`@lunora/do`): `ConflictError` (keep `.kind`), `NotFoundError`,
  `NotUniqueError`, `CountRlsUnsupportedError`, `RlsRequiredError` (keep `.table`);
  `@lunora/values` `ValidationError` (add `code:"VALIDATION_ERROR"`, `status:400`,
  keep `path/expected/received`) — then drop the ValidationError-by-name branch in
  `shard-do.ts`/`server/http.ts`.
- **Server/runtime-only**: `LunoraPaymentError`, `RateLimitError`, `AnalyticsSqlError`,
  `R2SqlError`, `WorkflowsRestError`, `LunoraEnvError`, `LunoraAuthAdminError`,
  `LunoraAuthHeadersError`, `ContainerBridgeError`.
- **CLI/build-time**: `PromptCancelledError`, `CodegenDiagnosticError` (file/line/col
  → `location`), `SchemaSnapshotParseError`, `BinError` (keep numeric exit `code`
  distinct — it is **not** a wire code).
- **EXCLUDE** `@lunora/workflow` `NonRetryableError` — the Workers runtime classifies
  it by `.name` and rebuilds it as the native `cloudflare:workflows` class at the DO
  boundary; leave its brand/name semantics untouched.
- Route the remaining `throw new Error(...)` domain sites through `LunoraError` /
  `invariant`; leave genuine JS `TypeError`/`RangeError` guards and codegen's
  emitted-into-generated-code throw strings (NodeNext `.js` exception) alone.

## Verify (whole)

- `pnpm run build:packages` (build first — stale-dist footgun).
- `pnpm run lint:types`, `pnpm run lint:eslint`.
- `pnpm run test` (excludes e2e/studio/d1/playground). Green so far: errors 14,
  server 377, codegen 491, runtime 450, client 331, do 1000, cli 522.
- Bundle-safety: the `@lunora/errors` main entry pulls only `@visulima/error/error`
  (no `renderError`/`node:fs`) — keeps client/runtime bundles clean.

## Notes

- New `@lunora/errors` dep is the "good" shared-vocabulary edge (like `@lunora/values`);
  `@visulima/error` is zero-dep so the transitive footprint is minimal.
- Wire-envelope change is additive/back-compatible (`hint`/`docsUrl` optional).
