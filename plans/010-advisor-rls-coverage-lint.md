# Plan 010: Spike + (if feasible) implement an advisor lint for RLS-uncovered table access

> **Executor instructions**: This is a SPIKE-FIRST plan. Phase A decides
> feasibility and produces a written verdict; Phase B implements only if
> Phase A's gate passes. Follow it step by step; honor STOP conditions. When
> done, update the status row in `plans/README.md` — a Phase-A-only outcome
> with a clear verdict is a SUCCESS, not a failure.
>
> **Drift check (run first)**: `git diff --stat 2f6a466f..HEAD -- packages/advisor/src packages/server/src/rls`
> On any change, re-read before proceeding.

## Status

- **Priority**: P3
- **Effort**: M (A: ~2h spike; B: ~1 day if green-lit)
- **Risk**: LOW (advisory-only output; no runtime behavior changes)
- **Depends on**: none
- **Category**: security / dx
- **Planned at**: commit `2f6a466f`, 2026-06-11

## Why this matters

Cirrus RLS is opt-in per procedure: a policy list only applies inside
procedures whose builder chain includes `.use(rls(policies))`. The middleware
documents this explicitly (`packages/server/src/rls/middleware.ts:27-31`:
"procedures without it see the unwrapped `ctx.db` and ignore every policy in
the list. This is by design (PLAN2 §3.2)."). By design — but it leaves a
silent failure mode: dev A writes policies for `documents`, dev B later adds
a query reading `documents` without `rls()`, and rows leak with no warning
anywhere. The advisor already solves exactly this class of problem for
another sharp edge: the `authApiCallWithoutHeaders` static lint
(`packages/advisor/src/lints/static/auth-api-call-without-headers.ts`,
registered in `packages/advisor/src/index.ts:52`) flags header-less
`ctx.authApi` calls. This plan adds the sibling: **"table covered by an RLS
policy is read/written by a procedure that doesn't use `rls()`"**, surfaced
in the studio Advisors table like every other lint.

## Current state

- `packages/advisor/src/` layout: `index.ts` (lint registry: `STATIC_LINTS`,
  `ALL_LINTS`, `runAdvisor`), `lints/static/*` (the 8 static rules + the
  authapi rule), `queries.ts` (discovered query reads), `inserts.ts`
  (discovered insert writes), `authapi-calls.ts` (the discovery feed for the
  authapi lint), `schema.ts` (`fromServerSchema`), `finding.ts`, `types.ts`.
- The advisor consumes **statically discovered** facts produced at codegen
  time — discovered query reads & insert writes per AGENTS.md. The existing
  `authApiCallWithoutHeaders` lint proves the pipeline can carry
  per-procedure call-site facts from codegen discovery into a lint.
- The open question this spike answers: **can the discovery layer see (a)
  which tables each procedure touches — it already does for reads/inserts —
  and (b) whether the procedure's builder chain includes `rls(...)`, and (c)
  which tables the app's policy list covers?** (b) and (c) are new facts.
- `packages/server/src/rls/middleware.ts` — read the whole header comment
  (lines 1–35) for the semantics; policies are plain data (table → policy
  fns) passed to `rls(policies)` at the call site.

## Commands you will need

| Purpose       | Command                                          | Expected |
| ------------- | ------------------------------------------------- | -------- |
| advisor tests | `pnpm --filter "@cirrus/advisor" run test`        | all pass |
| codegen tests | `pnpm --filter "@cirrus/codegen" run test`        | all pass |
| types/lint    | `pnpm --filter "@cirrus/advisor" run lint:types` (and eslint) | exit 0 |

## Scope

**In scope**: `packages/advisor/src/**`, `packages/advisor/__tests__/**`;
`packages/codegen/src/**` ONLY for adding a discovery feed (mirroring how
`authapi-calls.ts`'s input is produced — find that producer first:
`grep -rn "authApi" packages/codegen/src | head`); the spike report
(written INTO this file under "Spike verdict" — append a section).

**Out of scope**: any change to RLS runtime semantics in
`packages/server/src/rls/**` (the opt-in design stands); studio UI (the
Advisors table renders whatever `runAdvisor` returns); runtime lints over
metrics (separate direction item).

## Git workflow

- Branch: `feat/advisor-rls-coverage-lint` off `alpha`.
- Commits: `feat(advisor): rls-uncovered-table lint` (+ `feat(codegen): discover rls usage` if needed).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Phase A — Spike (always)

**A1.** Read, in order: `packages/advisor/src/index.ts`,
`lints/static/auth-api-call-without-headers.ts`, `authapi-calls.ts`,
`queries.ts`, `types.ts`; then find the codegen side that feeds
`authapi-calls` (`grep -rn "authApiCalls\|authapi" packages/codegen/src`).
Write down (for A3): what input shape lints receive, and where per-procedure
facts originate.

**A2.** Determine: from the existing discovery IR, can you derive
(per procedure) `{ tablesRead, tablesWritten, usesRls: boolean }` and
(per app) `{ policyCoveredTables: string[] }`? `rls(...)` appears in user
code as a builder `.use(rls(policies))` call — check whether codegen's
function discovery already walks builder chains (it must distinguish
query/mutation builders somehow) and whether the policies object's table
keys are statically readable (object-literal keys).

**A3.** Append a "## Spike verdict" section to THIS file:
- FEASIBLE-AS-STATIC: all three facts derivable statically → proceed to B.
- PARTIALLY: e.g. `usesRls` derivable but policy table keys are computed →
  document the degraded rule (flag rls-less procedures touching ANY table
  while any `rls(` usage exists in the app — noisier) and STOP for a
  maintainer decision.
- NOT-FEASIBLE: builder chains aren't statically walkable → document why and
  STOP. Recommend the fallback (a runtime lint once advisor runtime rules
  land — see the audit's direction finding #4).

**Verify**: the verdict section exists and names the exact IR
types/functions inspected.

### Phase B — Implement (only on FEASIBLE-AS-STATIC)

**B1.** Add the discovery feed (codegen side if that's where siblings live):
per-procedure `usesRls` + the policy-covered table set, following the
authapi-calls producer as the structural template.

**B2.** Add `packages/advisor/src/lints/static/rls-uncovered-table.ts`:
for each procedure where `usesRls === false` and
`tablesRead ∪ tablesWritten` intersects `policyCoveredTables`, emit one
finding per (procedure, table): level matching what sibling security-ish
lints use (read two existing lints and match), name `rls-uncovered-table`,
detail naming the procedure and table, remediation pointing at
`.use(rls(policies))`. Register it in `STATIC_LINTS` (`index.ts`), export it
named (repo rule: no default+named mixing — match how siblings export;
note `authApiCallWithoutHeaders` is a default export, so match THAT file's
existing style for lints).

**B3.** Tests in `packages/advisor/__tests__/` modeled on the existing lint
tests: (1) covered table + rls-less reader → finding; (2) same reader WITH
rls → no finding; (3) rls-less reader of an uncovered table → no finding;
(4) insert-write path triggers too; (5) zero policies in app → lint is
silent everywhere.

**Verify**: `pnpm --filter "@cirrus/advisor" run test` → all pass (5 new);
codegen tests pass if a feed was added.

## Done criteria

- [ ] "Spike verdict" section appended to this file with one of the three verdicts
- [ ] If FEASIBLE: lint registered, 5 tests passing, advisor + codegen gates green
- [ ] If not: STOP report delivered; no code changed beyond the spike notes
- [ ] `plans/README.md` status row updated (DONE for a verdict-only outcome is correct if the verdict was PARTIALLY/NOT-FEASIBLE)

## STOP conditions

- Phase A verdict is PARTIALLY or NOT-FEASIBLE (by design — report, don't improvise).
- The lint requires changing the shape of `Lint`/`Finding` types consumed by
  the studio (cross-package contract — maintainer decision).
- Discovery requires *executing* user schema/function files rather than
  parsing them.

## Maintenance notes

- This lint is the static half; the direction finding "advisor runtime lints"
  (audit #4 / DIR-5) could later add a runtime confirmation (actual
  rls-less reads observed). Keep the lint name stable for that pairing.
- False-positive risk to watch in review: internal procedures that
  legitimately bypass RLS (e.g. admin/internal functions). If discovery can
  see `internalQuery` vs `query`, exempt internal ones and document it; if
  not, note it in the lint's remediation text.
