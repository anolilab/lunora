# Plan 023: Dynamic data masking (`mask()` policy + advisor lint + studio toggle)

> **Executor instructions**: This is a **feature/borrow roadmap note**, not an
> audit bug-fix. The idea is lifted from StarbaseDB's "Dynamic Data Masking"
> plugin (see `ECOSYSTEM-BORROW.md`, StarbaseDB row). StarbaseDB is **AGPL-3.0**
> → **ideas only, do not copy any source**. Everything below is re-implemented
> from scratch against Cirrus's own `rls()` architecture; the StarbaseDB
> reference is conceptual only.
>
> Ship the three sub-items in order — each is its own PR and each is useful
> alone. Run the per-item Verify gate before moving on, honor the STOP
> conditions, and tick the box + update the row in `plans/README.md` when an
> item lands.
>
> **Drift check (run first)**:
> `git diff --stat 2c403598..HEAD -- packages/server/src/rls packages/advisor/src packages/studio/src`
> If `rls/middleware.ts`, the advisor lint registry, or the studio data browser
> moved since this was written, re-read them — the pointers below name files,
> not line numbers, but the surrounding APIs may have shifted.

## Status

- **Priority**: P3 (net-new capability; no correctness/security regression
  blocks it — but item 2's lint has security value once item 1 exists)
- **Effort**: L overall — M (item 1) + S (item 2) + M (item 3)
- **Risk**: MEDIUM — item 1 touches the read path in `@cirrus/server` storage
  middleware; masking the wrong column (or failing open) is a data-exposure
  bug, so the redaction must fail **closed**.
- **Depends on**: nothing external. Mirrors the existing `rls()` pipeline
  (`@cirrus/server` middleware → codegen feeder → advisor lint → studio), so it
  rides the same seams. Item 2's lint depends on item 1's `mask()` existing.
- **Category**: feature / ecosystem-borrow (security + studio)
- **Planned at**: commit `2c403598`, 2026-06-14
- **Borrow source**: StarbaseDB "Dynamic Data Masking" plugin —
  [outerbase/starbasedb](https://github.com/outerbase/starbasedb) ·
  [pre/post-query hooks blog](https://starbasedb.com/blog/pre-and-post-query-hooks/).
  **AGPL-3.0 → ideas only.** No file, block, or snippet copied.

## Why this matters

The StarbaseDB analysis (the one fresh idea its substrate twin had that Cirrus
lacks) surfaced **dynamic data masking**: column-level redaction so a table can
be safely exposed to an AI agent, a support tool, or a shared read without
leaking PII (email, phone, tokens, SSN-shaped values). Cirrus already matches or
beats StarbaseDB on every other axis — RLS is shipped as `.use(rls(policies))`
**with** the `rls_uncovered_table` advisor lint
(`packages/advisor/src/lints/static/rls-uncovered-table.ts`), query hooks are
covered by procedure middleware, logs/stats/PITR/cron/auth/studio all exist —
but it has **no column-masking concept** (the `mask` hits in the tree are all
`.dev.vars` secret masking, unrelated).

Masking is the natural sibling of RLS: RLS decides *which rows* a caller sees;
masking decides *which columns* are returned in the clear. Both are per-procedure
opt-in policy middleware over `ctx.db`. Building masking on the existing RLS
seams keeps the mental model and the codegen/advisor wiring uniform.

## License gate (read before writing any code)

StarbaseDB is **AGPL-3.0**. Per `ECOSYSTEM-BORROW.md`'s gate, copyleft is
incompatible with shipping Cirrus under FSL → **ideas only**. Do **not** open
its source to copy hook signatures, policy shapes, or masking strategies.
Re-derive everything from Cirrus's own `rls()` types
(`packages/server/src/rls/index.ts`). The concept "mask columns on the way out"
is not copyrightable; their code is.

## Design

Three layers, mirroring `rls()` one-for-one:

### Item 1 — `mask()` policy middleware (`@cirrus/server`) — P3, M

Add a `mask()` builder alongside `rls()`, exported from
`packages/server/src/rls/index.ts` (or a sibling `packages/server/src/mask/`
that re-uses the policy-context types). Shape mirrors `rls`:

```ts
// usage
export const listUsers = query(...)
  .use(mask({
    users: {
      email: "redact",                 // → null / "•••" for non-privileged callers
      phone: (value, ctx) => ctx.role === "admin" ? value : maskMiddle(value),
    },
  }))
  .handler(...)
```

- Masking runs in the **read/return path** of the storage middleware
  (`packages/server/src/storage/middleware.ts`), after RLS row-filtering, before
  results leave the procedure. It rewrites column values in returned rows; it
  does **not** change what is stored.
- Strategies: `"redact"` (drop to `null`/sentinel), `"hash"`, and a
  `(value, ctx) => masked` function for partial masks. Reuse `PolicyContext`
  from `rls/index.ts` so `ctx.role` / identity is the same object RLS sees.
- **Fail closed**: if a policy throws or a column is declared maskable but the
  strategy is unresolved, return the redacted form, never the raw value.
- Internal procedures (`internalQuery`/`internalMutation`/`internalAction`)
  bypass masking, exactly as they bypass RLS — they're trusted server-side.

**STOP**: do not auto-apply masking globally or infer "PII columns" at runtime.
Masking is **opt-in per procedure**, identical to RLS. Silent global masking
would break existing queries and hide data unexpectedly.

**Verify**: `pnpm --filter "@cirrus/server..." run build && pnpm --filter
"@cirrus/server" run test` — add unit tests covering: redact-for-anon /
clear-for-admin, fail-closed on throwing strategy, internal-procedure bypass,
and that the stored row is untouched (read-back via an internal query shows the
raw value).

### Item 2 — `mask_uncovered_pii_column` advisor lint — P3, S

A static lint mirroring `rls_uncovered_table`
(`packages/advisor/src/lints/static/rls-uncovered-table.ts`), fed by a codegen
discoverer mirroring `discover-rls-procedures.ts`:

- Flag a **public** procedure that returns a column which **another** procedure
  masks (evidence the developer decided that column is sensitive), but whose own
  chain has no `.use(mask(...))` for it — the "one procedure masks `email`,
  another leaks it" failure mode.
- Optionally (lower confidence, behind the same evidence gate): flag a public
  procedure returning a **PII-shaped column name** (`email`, `phone`, `token`,
  `ssn`, `password*`, `secret*`) with no mask policy anywhere — a heuristic
  nudge, not a hard error. Keep it conservative to avoid noise, same discipline
  as the existing lints.
- Register it in `packages/advisor/src/index.ts` next to `rlsUncoveredTable`
  (import + default re-export + add to the lint list). Surfaces in the studio
  Advisors table automatically.

**Verify**: `pnpm --filter "@cirrus/advisor..." run build && pnpm --filter
"@cirrus/advisor" run test` — fixture procedures: one masks `users.email`, a
sibling returns it unmasked → exactly one finding; both mask it → none; internal
sibling unmasked → none (exempt).

### Item 3 — Studio data-browser mask toggle — P3, M

In the studio data browser, surface masking so an operator viewing a table can
see what a non-privileged caller would see:

- A **"Mask sensitive columns"** toggle in the data-grid toolbar that applies
  the declared mask strategies to the rendered rows (client-side render only —
  the operator still has full DB access; this is a preview, not enforcement).
- Mark masked columns in the column header (a small "masked" chip), driven by
  the codegen-discovered mask policies (same evidence the advisor uses).
- Pairs with the StarbaseDB use-case: "safely share / screenshot a table".

**Verify**: `pnpm --filter "@cirrus/studio..." run build && pnpm --filter
"@cirrus/studio" run test`. Manual: toggle on → declared columns render redacted;
toggle off → raw. (Studio runtime smoke is sandbox-limited per
`project-workerd-sandbox-limit` — verify the render logic with component tests,
not a live worker.)

## Done criteria

- [x] Item 1: `mask()` exported from `@cirrus/server`, runs in the return path
      after RLS, fails closed, internal procedures bypass, stored data untouched,
      unit tests green. (`packages/server/src/mask/` + `__tests__/mask.test.ts`,
      19 tests; `MASK_UNSUPPORTED` (422) added to `error.ts`. Build + lint +
      types + tests verified.)
- [x] Item 2: `mask_uncovered_pii_column` lint registered, codegen feeder added,
      fixtures green, shows in studio Advisors. (`packages/advisor/src/lints/static/mask-uncovered-pii-column.ts`
      + `mask-procedures.ts` type + `LintContext.maskProcedures`; codegen
      `discover-mask-procedures.ts` → `MaskProcedureIR` → `lintSchema`'s 9th arg.
      Table-granular: flags a public procedure reading a mask-covered table with no
      `.use(mask(...))`; internal + write-only exempt. 9 advisor + 6 codegen tests;
      build + lint + types + prettier verified.)
- [x] Item 3: studio data-browser mask toggle + masked-column chips, component
      tests green. Full codegen→DO→studio metadata seam: `MaskMetadataIR`/`MaskColumnMetadataIR`
      + `discoverMaskMetadata` (dedupe by `(table,column)`, first-declaration-wins) →
      `CIRRUS_MASK_METADATA` emitted constant + `maskMetadata()` DO override →
      `__cirrus_admin__:maskPolicies` admin RPC → `useMaskPolicies` hook. Studio
      `mask-preview.ts` mirrors the server FNV-1a (`hash`), `redact`→null,
      `custom`→`•••` sentinel (fail-closed). Toolbar "Mask sensitive columns"
      toggle (client render-only preview) + per-column "masked" header chips.
      5 mask component tests + 4 codegen `discoverMaskMetadata` tests; studio build
      + 480 studio tests + 273 codegen tests green.
- [x] `ECOSYSTEM-BORROW.md` StarbaseDB row updated to note masking is the one
      idea borrowed (and, as items land, that it shipped).
- [x] This plan's row in `plans/README.md` moved to DONE (or per-item progress
      noted) as each item ships.

## STOP conditions (global)

- **No AGPL source.** Do not open StarbaseDB's plugin code to copy hook/policy
  shapes. Re-derive from Cirrus's `rls()` types.
- **Opt-in only.** Masking never applies unless a procedure calls
  `.use(mask(...))`. No global/auto masking.
- **Fail closed.** Any ambiguity in a mask policy redacts; never leak raw on
  error.
- **Don't reshape `rls()`.** Add `mask()` alongside it; if you share the
  `PolicyContext` type, extend, don't narrow — keep RLS callers' inferred types
  intact (same caution the `rls` code documents).
