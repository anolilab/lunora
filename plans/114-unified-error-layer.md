# Plan 114: Unified error layer — `@lunora/errors` on `@visulima/error`

> **Executor instructions**: Phases 1, 2, 4a, 4b, and the Phase-3 **class
> collapse** are DONE and committed on `feat/unified-error-layer`. What remains is
> optional: the rest of the Studio panels (4c) and the raw `throw new Error(...)`
> site migration (Phase 3, non-blocking). Follow step by step; run each verify.

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
- **Zero-dependency**: `LunoraError` mirrors `@visulima/error`'s model
  (`type: "VisulimaError"` + `hint`/`title`/`loc`) rather than extending
  `VisulimaError` — bundlers inline the whole `@visulima/error/error` barrel
  (which drags `node:module` via `renderError`) instead of tree-shaking it, so
  extending it would break browser/workerd/standalone bundles. Reimplementing the
  small shape keeps the package bundle-safe everywhere and renderer-compatible.
  The terminal renderer (`renderLunoraError`, using `@visulima/error`'s
  `renderError`) lives in `@lunora/cli`.

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
(`components/error-alert.tsx`, message + stripped-markdown hint + docs link), the
shared `AdvisorView` (threads `errorSource`), and **every panel that reads a hook
query error**: flags, storage-rules, rls, queues, settings, subscriptions,
fanout, function-stats, audit, logs, permissions, payments, migrations (status),
mail, insights, security-advisor.
Remaining (deliberately deferred): panels that catch-and-flatten their error into
a **string in local `useState`/reducer state** before render — health, analytics,
the data/global-data browsers, kv editor/create, generate-rows, shard-explorer,
cascade-preview, home widgets. Surfacing hints there needs the state shape to hold
the raw error object (not the message string), a per-panel refactor with real
regression risk and no jsdom test coverage in the sandbox — tracked as follow-up.

> Verify via `pnpm --filter @lunora/studio run lint:types` + `lint:eslint` + build
> (Studio jsdom tests SIGTERM in the sandbox — see the pinned memory; do not gate
> on `run test`).

### Phase 3 — Per-package class collapse ✅ (classes) / ⬜ (raw throw sites)

**Custom classes collapsed onto `@lunora/errors`' `LunoraError`** (subclass, fixed
`name` + `code` + catalog/explicit `status`, extra fields preserved):

- **Wire-crossing** ✅ (commit `ee0cdb46`): `@lunora/do` `ConflictError` (keeps
  `.kind`), `NotFoundError`, `NotUniqueError`, `CountRlsUnsupportedError`,
  `RlsRequiredError` (keeps `.table`); `@lunora/values` `ValidationError`
  (`code:"VALIDATION_ERROR"`, `status:400`, keeps `path/expected/received`).
  Dropped the ValidationError-by-name branch in `shard-do.ts` (the `isLunoraError`
  branch now catches it).
- **Server/runtime-only** ✅ (commit `2da61da0`): `LunoraPaymentError`,
  `RateLimitError`, `AnalyticsSqlError`, `R2SqlError`, `WorkflowsRestError`,
  `LunoraEnvError`, `LunoraAuthAdminError`, `LunoraAuthHeadersError`,
  `ContainerBridgeError`.
- **Build-time** ✅: `CodegenDiagnosticError` (file/line/col → base `location`),
  `SchemaSnapshotParseError`.

**Intentional exclusions** (control-flow / process signals, not displayable
Lunora errors — unifying them adds friction without user value):

- `@lunora/workflow` `NonRetryableError` — Workers classifies it by `.name` and
  rebuilds it as the native `cloudflare:workflows` class at the DO boundary.
- `@lunora/cli` `PromptCancelledError` — a cancel signal (`exit 130`);
  `instanceof`-gated in the command wrapper, deliberately dependency-free.
- `@lunora/mcp` `BinError` — carries a **numeric process exit code**, not a
  string wire code.

**Remaining ⬜ (optional follow-up):** route the remaining raw
`throw new Error(...)` domain sites through `LunoraError` / `invariant`
package-by-package. This is **not** a functional blocker — the RPC edge already
surfaces hints by `code`, and unhandled throws stay correctly redacted. Leave
genuine JS `TypeError`/`RangeError` guards and codegen's emitted-into-generated
throw strings (NodeNext `.js` exception) alone.

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
