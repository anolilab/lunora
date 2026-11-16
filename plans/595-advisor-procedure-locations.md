# Plan 595 — Declaration-level findings carry their declaration's file and line

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and report — do
> not improvise. A reviewer dispatched you and maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git log --oneline -1` → `4121b67cc` (or a descendant of it). Then
> `git diff --stat 4121b67cc..HEAD -- packages/advisor/src packages/codegen/src` → no output.

**Baseline:** `4121b67cc` (2026-11-12)
**Status:** DONE — APPROVED; PR https://github.com/anolilab/lunora/pull/1584 (commits `ce2b9e2de`, `4aedc5e34`, `1b2a46f47`, `a75902bbb`). 18 of 19 lints covered; `topic-too-many-subscriptions` moved to plan 596.
**Source:** follow-up to row 50 of the 2026-11-11 audit (advisor lints): first of a four-PR stack
(595 locations for declaration findings → 596 locations for schema/config findings → 597
per-finding suppression → 588 row 50).

## Status

- **Priority**: P2 · **Effort**: M · **Risk**: LOW (adds fields; no rule fires differently) · **Depends on**: none · **Category**: tech-debt (enabler)

## 0. Headline

A per-finding suppression (plan 597) matches a finding by rule id + file + line. About 76 static
lints already report `metadata.file` and `metadata.line` (the call site). Nineteen report a
declaration — a procedure, admin route, container, cron, queue, workflow, shape or RLS procedure —
by name only, with no line (several with no file). This plan gives every one of them the file and
start line of the declaration that produced it, recorded once in the shared evidence (IR) where it
is discovered, and copied into the finding's `metadata`.

## 1. Current state (audit)

The 19 lints and the evidence array each reads (`packages/advisor/src/lints/static/`):

| Lint file                                                                                                                                                                                                                                                                         | Evidence (`context.*`) | Row type (`packages/advisor/src/*.ts`)                  | has `file` today |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------- | ---------------- |
| action-without-error-handling, ai-unbounded-generation-public, insert-many-unsafe-user-data, privileged-fanout-from-public-procedure, error-without-catalog, user-creating-mutation-without-captcha, public-mutation-without-ratelimit, signup-mutation-without-disposable-gating | `procedureProtections` | `AdvisorProcedureProtection` (procedure-protections.ts) | yes              |
| admin-route-without-guard                                                                                                                                                                                                                                                         | `adminRoutes`          | `AdvisorAdminRoute` (admin-routes.ts)                   | yes              |
| container-long-sleep-after, container-oversized-instance, container-public-internet                                                                                                                                                                                               | `containers`           | `AdvisorContainer` (containers.ts)                      | NO               |
| cron-every-minute                                                                                                                                                                                                                                                                 | `crons`                | `AdvisorCron` (crons.ts)                                | NO               |
| queue-without-dlq, topic-too-many-subscriptions                                                                                                                                                                                                                                   | `queues`               | `AdvisorQueue` (queues.ts; has `filePath?`)             | partly           |
| workflow-unused                                                                                                                                                                                                                                                                   | `workflows`            | `AdvisorWorkflow` (workflows.ts; has `handlerFile?`)    | partly           |
| shape-unknown-table, shape-targets-global-table                                                                                                                                                                                                                                   | `shapes`               | `AdvisorShape` (shapes.ts)                              | yes              |
| policy-references-unknown-table                                                                                                                                                                                                                                                   | `rlsProcedures`        | `AdvisorRlsProcedure` (rls-procedures.ts)               | yes              |

- Codegen producers: `packages/codegen/src/advisor-evidence.ts` builds `adminRoutes`
  (`discoverAdminRoutes`), `procedureProtections` (`discoverProcedureMiddleware`,
  `discover/procedure-middleware.ts`), `rlsProcedures` (`discoverRlsProcedures`), `shapes`; and
  passes through the surface IR for `containers`, `crons`, `queues`, `workflows`
  (`advisor-evidence.ts:69-77`, `run-codegen.ts:1055-1073`; IR types in `packages/codegen/src/ir/platform.ts`).
- `cacheKey`s of these lints do NOT include file or line (e.g.
  `public_mutation_without_ratelimit:${file}:${exportName}`, `container_public_internet:${exportName}`,
  `cron_every_minute:${job.name}`), so adding location fields cannot change dedupe/dismissal ids.
- Existing exemplar of a located finding: `callSiteFields(row)` in `packages/advisor/src/lints/helpers.ts:263`
  returns `{ ...scope, file, line }`.

## 2. Design decisions

- **Field names `file` and `line` on the evidence row** (optional on the advisor side so a runtime or
  older caller still type-checks; always set by codegen), and **`metadata.file` / `metadata.line` on the
  finding** — the same keys call-site findings already use, so plan 597 matches every finding one way.
  Rejected: a nested `site` object (two shapes for one concept).
- **Which line:** the 1-based start line, without leading comments/JSDoc (`node.getStartLineNumber()`,
  which ts-morph computes from `getStart()` excluding trivia), of the **statement that declares the
  object**: for an exported `const`, its `VariableStatement` (the `export const …` line); for an exported
  function, the `FunctionDeclaration`; for an object registered by a call that is not an export (a cron
  job registered by `crons.<method>(...)`, an admin route, …), the `ExpressionStatement` containing that
  call (or the call's own start line when it is not a statement). `file` is the path relative to
  `lunora/`, without extension — the same convention `procedureProtections.file` uses today.
- **Recorded once, at discovery**, in the codegen IR row the evidence is built from; lints only copy it.
  Rejected: computing it in each lint (the lint has no AST).
- **`cacheKey` unchanged** for every lint (see §1). Rejected: putting the line into the key (a moved
  declaration would reset a dismissal).
- Emitted runtime output: if an IR type that ALSO feeds emitted code (containers, crons, queues,
  workflows) gains fields, the emitter must not start writing them into `_generated` runtime code.
  Only the advisories embedded in `_generated/shard.ts` (`LUNORA_ADVISORIES`) may change, by gaining
  the two metadata fields.

## 3. Steps

### Step 1 — record the site in codegen

For each row type in §1, find its discoverer (`grep -rn "<TypeName>\|<IR type>" packages/codegen/src`),
add `file` (where missing) and `line` per §2 at the point the row is built, and add the fields to the
codegen IR type and the advisor row type (`packages/advisor/src/<file>.ts`, JSDoc one line each).
**Verify**: `pnpm --filter "@lunora/codegen" run lint:types` and `pnpm --filter "@lunora/advisor" run lint:types` exit 0.

### Step 2 — copy into findings

In each of the 19 lints, add `file` and `line` to the `metadata` object (only when defined:
`...(row.line === undefined ? {} : { file: row.file, line: row.line })` or the file's existing style).
Do not change `cacheKey`, `detail`, `level` or anything else.
**Verify**: `pnpm --filter "@lunora/advisor" run test` → all pass (update a test ONLY where it asserts the
exact full `metadata` object of one of these lints — add the two fields; never loosen to a partial match).

### Step 3 — tests (must fail without the fix)

- codegen: for each discoverer touched, one test asserting `file`/`line` of a fixture declaration on a
  known line (model each after an existing test of that discoverer; e.g. `__tests__/discover/procedure-middleware.test.ts`).
  Include one fixture with a JSDoc block above `export const` to pin "start line excludes the comment".
- advisor: one test per row type asserting a finding's `metadata.file`/`metadata.line` come from the row
  (model after an existing test of that lint).
  **Verify**: the new tests pass; then restore the baseline sources of Step 1+2
  (`git show 4121b67cc:<p> > <p>` for each changed source file), re-run the new tests → they FAIL; restore
  with `git checkout -- packages`; re-run → pass. Report the names of failing tests.

### Step 4 — generated output and goldens

Do NOT run codegen in `examples/` (the reviewer does it on a full build). Run
`pnpm --filter "@lunora/codegen" run test`; if a golden fixture test fails ONLY because embedded
advisories gained `file`/`line`, STOP and report the diff (the reviewer regenerates goldens with
`packages/codegen/__tests__/capture-expected.ts`). Any other golden diff → STOP.

### Step 5 — gates and commit

codegen and advisor `lint:eslint`, `lint:types`, `test` exit 0; `pnpm exec oxfmt --check` on changed
files; one commit per step group: `feat(codegen): record declaration sites for advisor evidence`,
`feat(advisor): report declaration file and line on declaration findings`.

## Commands

| Purpose              | Command (worktree root)                        | Expected                                       |
| -------------------- | ---------------------------------------------- | ---------------------------------------------- |
| Install              | `pnpm install --frozen-lockfile`               | exit 0                                         |
| Build deps           | `pnpm --filter "@lunora/codegen..." run build` | exit 0                                         |
| Tests / lint / types | `pnpm --filter "@lunora/<codegen               | advisor>" run test`/`lint:eslint`/`lint:types` | pass / exit 0 |

## Scope

In: the codegen discoverers and IR types for the eight row types, the eight advisor row types, the 19
lint files, their tests. Out: `cacheKey`s, any rule's level or wording, `packages/cli`, `packages/studio`,
`packages/mcp` (they render `metadata` generically — the reviewer verifies), every app.

## STOP conditions

- A row type's object has no single declaring statement in app source (report which and why).
- Adding the fields changes emitted `_generated` runtime code beyond `LUNORA_ADVISORIES`.
- A golden fixture changes (report; do not regenerate).
- A verification fails twice.

## 6. Platform parity

Not applicable: no `ctx.*` surface or binding.

## Maintenance notes

- Reviewer: run `api:check` on a fresh build (the advisor row types are exported), the in-repo sweep
  (finding lists unchanged except the new fields), and check Studio/CLI/MCP render `metadata` without change.
