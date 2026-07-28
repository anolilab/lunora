# Plan 201 — Studio SQL editor diagnostics

- **Category**: dx (competitive parity — Prisma Studio SQL editor intelligence)
- **Priority**: P2
- **Effort**: M · **Risk**: LOW
- **Status**: DONE (Phases 1–2 shipped; Phase 3 dropped — see below)
- **Baseline**: `865a9a4c` (2026-07-28)
- **Goal**: tell the operator what is wrong with a statement _while they type_ —
  rejected verbs, unknown tables/columns, syntax errors, full-scan plans — instead
  of only after they hit Run.

## Context (verified)

**The editor is a plain `<textarea>`** (`packages/studio/src/features/sql/sql-editor-panel.tsx:645`,
759 lines) with a hand-rolled line-number gutter kept in sync by mirroring the
textarea's scroll (`:42`, `:308`), plus a custom schema-aware autocomplete
dropdown (`features/sql/sql-autocomplete.ts` — pure, unit-tested, sourced from
`listTables` + `readTablePage`'s `columns`; UI in `sql-autocomplete-ui.tsx`).
There is no CodeMirror in the dependency tree.

**Feedback is run-then-see.** Running goes to `__lunora_admin__:runSql` →
`packages/do/src/sql-console.ts` (145 lines), which enforces a read-only _lead_
regex (`READONLY_LEAD` — `select`/`with`, optionally behind `EXPLAIN [QUERY PLAN]`)
plus a deliberately broad denylist of mutating verbs anywhere in the statement,
and caps results at `MAX_SQL_ROWS = 1000`. `EXPLAIN QUERY PLAN` exists but as a
_result tab_ the operator opts into (`sql-editor-panel.tsx:224`, `:471`, `:677`),
not as ambient feedback. Errors land in an `Alert` after the round trip (`:729`).

**What Prisma does** (`Architecture/sql-editor-intelligence.md`,
`ui/studio/views/sql/sql-lint-source.ts`): a backend lint surface returns parse +
plan diagnostics that render as inline CodeMirror squiggles while typing, with a
documented capability fallback when the adapter cannot lint, Postgres-specific
safety guardrails, and the same treatment for table filter expressions
(`views/table/sql-filter-lint.ts`).

## Design decision — do NOT adopt CodeMirror

`@lunora/studio` is embedded in the CLI/Vite dev server and shipped to users;
CodeMirror 6 + a SQL language mode is a large addition to that bundle, and it
would obsolete two working, tested components (the gutter and the autocomplete).
Diagnostics are rendered instead by an **underline overlay** — an absolutely
positioned mirror div behind the textarea, sharing its font metrics and scroll
offset, drawing decorations at character offsets. This is the same alignment
trick the line-number gutter already relies on, so the risk is known.

Every diagnostic also appears in a **problems row** under the editor (text, not
geometry), so the feature degrades gracefully if the overlay ever misaligns —
and stays usable for screen readers, where a visual squiggle is nothing.

## Phase 1 — Client-side rules (zero RPC)

- [x] Extract the read-only gate from `packages/do/src/sql-console.ts` into
      `shared/sql-readonly.ts` (zero-dep: `READONLY_LEAD` + the mutating-verb
      denylist + a `classifyStatement()` returning `{ allowed, reason, offset }`).
      The DO imports it as its enforcement; the editor imports it as a lint. One
      source, so the warning and the rejection can never disagree.
- [x] Diagnostic: "`DELETE` is not allowed in the SQL console — it is read-only",
      anchored at the offending token's offset, shown before the operator runs it.
- [x] Diagnostic: unknown table / unknown column, from the `SqlSchema` the
      autocomplete already assembles. Column checks only for tables whose columns
      have been probed (`SqlSchema.columns` is deliberately partial) — never warn
      from absent knowledge.
- [x] Overlay + problems row, wired to a debounced (≈250ms) pure lint pass.

## Phase 2 — Server-side parse + plan lint

- [x] `__lunora_admin__:lintSql` in `packages/do/src/sql-console.ts`: run
      `EXPLAIN QUERY PLAN <stmt>` (SQLite parses and plans without executing),
      return `{ diagnostics: [{ severity, message, offset?, length? }], plan }`.
      Reuses the existing read-only gate, so lint cannot become a side-effect
      channel — it must be gated identically to `runSql`, not more loosely.
- [x] Map SQLite's `near "x": syntax error` into an offset when the message
      carries enough to locate it; fall back to a whole-statement diagnostic
      rather than guessing a wrong span.
- [x] Plan-derived warnings: a `SCAN <table>` opcode (no index) → "full table
      scan on `<table>`", using the same vocabulary as the advisor's existing
      scan attribution (`features/advisors/derive-insights.ts`) so one concept
      does not get two names in one UI.
- [x] Debounce ≥600ms and cancel in-flight lints on a new keystroke (Prisma's
      single-active-query rule) — one lint per pause, never one per character.
- [x] Capability fallback: an older worker without `lintSql` keeps Phase 1's
      client-side diagnostics and shows no server ones. No error, no empty panel.

## Phase 3 — Filter expressions — DROPPED (premise was wrong)

The plan assumed the data browser takes a raw predicate the way Prisma's
`sql-filter-lint.ts` does. It does not: `features/data/data-filters.tsx` is a
**structured** builder — column from a `<select>` of the table's real columns,
operator from a 7-value enum, value coerced by `coerceFilterValue`. There is no
expression text that can be malformed, so there is nothing to lint. Adding a
linter here would be theatre.

The one genuine gap in that area — a filter that returns nothing because the
value's type doesn't match the column's — is a **typed-predicate** problem, and
it is already scoped as plan 205 Phase 2. Left there rather than duplicated.

## Exit criteria

- Typing `DELETE FROM users` underlines `DELETE` and explains it before Run.
- Typing `SELECT * FROM userz` underlines `userz` as unknown.
- A syntax error is underlined at (or near) the offending token, with the same
  message the server would have returned on Run.
- A statement that will full-scan is flagged as a warning, not an error.
- Unit tests for the pure classifier + offset mapping (no DOM); a component test
  for overlay/problems-row rendering; a test asserting `lintSql` refuses exactly
  what `runSql` refuses.
- No measurable typing lag on a 200-line statement (the lint pass is pure and
  debounced; the overlay redraws once per pass).

## STOP conditions

- **If the overlay cannot stay aligned** with the textarea across wrapping,
  tabs, and horizontal scroll: ship Phase 1/2 with the problems row only, and
  report. Do not adopt CodeMirror to rescue the overlay without a bundle-cost
  decision from the maintainer — that is a different plan.

## Review corrections (thermo pass, 2026-07-28)

- **`toSpans` dropped the wrong overlaps.** It compared each span against the
  previous element of the sorted input rather than the last KEPT span, so a span
  nested inside an earlier wider one survived — desynchronising the overlay from
  the textarea for the rest of the statement. Latent (only one span-bearing
  diagnostic is emitted today) but fixed, with a regression test.
- The four hand-reset `lastIndex` scan loops became `matchAll`, and the
  diagnostic-source label became an exhaustive record.

## Non-goals

- A full SQL parser/AST in Studio. Diagnostics come from cheap regex/lexical
  rules plus the database's own planner — the two sources that cannot drift from
  what actually happens.
- Autocomplete changes; `sql-autocomplete.ts` stays as is.
- Making the console writable. The read-only gate is a security boundary, and
  this plan only makes it legible earlier.
